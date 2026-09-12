import { Readable, Writable } from "node:stream";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import type { TransferEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import type { TransferJobSnapshot } from "../src/shared/transfer/transfer.types";
import { TransferQueue } from "../src/main/services/transfer/transfer-queue";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { makeEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { tmpdir } from "node:os";

const CHUNK = 8 * 1024 * 1024;
const sessions = { status: () => "connected", transferConcurrency: () => 3 } as unknown as SessionManager;
function wrap(endpoint: TransferEndpoint, overrides: Partial<TransferEndpoint>): TransferEndpoint {
  return new Proxy(endpoint, {
    get(target, key) {
      const value = key in overrides ? Reflect.get(overrides, key) : Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function fixture(): Promise<{
  root: string;
  source: string;
  dest: string;
  local: TransferEndpoint;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(`${tmpdir()}/pallet-transfer-`);
  const source = `${root}/source`;
  const dest = `${root}/dest`;
  await fs.mkdir(source);
  await fs.mkdir(dest);
  const local = makeEndpoint(sessions, { kind: "local" });
  return { root, source, dest, local, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
function harness(
  source: TransferEndpoint,
  dest: TransferEndpoint,
  action = "replace",
  onUpdate?: (s: TransferJobSnapshot, q: TransferQueue) => void,
): {
  queue: TransferQueue;
  run: (sourceBase: string, destDir: string, names: string[]) => Promise<TransferJobSnapshot>;
  records: TransferJobSnapshot[];
} {
  const records: TransferJobSnapshot[] = [];
  const waiters = new Map<string, (s: TransferJobSnapshot) => void>();
  const queue = new TransferQueue(
    sessions,
    {
      onUpdate: (s) => onUpdate?.(s, queue),
      onConflict: (p) => queue.resolveConflict(p.jobId, action as "replace" | "keepBoth", true),
      record: (s) => {
        records.push(s);
        waiters.get(s.id)?.(s);
      },
    },
    3,
    (_sessions, ref) => (ref.kind === "local" ? source : dest),
  );
  return {
    queue,
    run(sourceBase: string, destDir: string, names: string[]) {
      const id = queue.enqueue({
        from: { kind: "local" },
        to: { kind: "sftp", sessionId: "test" },
        sourceBase,
        destDir,
        names,
      });
      return new Promise<TransferJobSnapshot>((resolve) => waiters.set(id, resolve));
    },
    records,
  };
}

// Filesystem tests intentionally use the actual endpoints, streams and staging/rename path.
test("2,100 mixed files, empty folders, duplicate selection and symlinks", { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await fs.mkdir(`${f.source}/tree/empty`, { recursive: true });
    const files = Array.from({ length: 2100 }, (_, i) => [`file-${i}`, Buffer.alloc(i % 257, i % 256)] as const);
    for (let i = 0; i < files.length; i += 50)
      await Promise.all(files.slice(i, i + 50).map(([name, bytes]) => fs.writeFile(`${f.source}/tree/${name}`, bytes)));
    await fs.symlink(f.source, `${f.source}/tree/loop`);
    let scans = 0;
    const source = wrap(f.local, {
      statOrNull: async (p) => {
        scans++;
        return f.local.statOrNull(p);
      },
    });
    let updates = 0;
    const h = harness(source, f.local, "replace", () => updates++);
    const result = await h.run(f.source, f.dest, ["tree", "tree"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.equal(result.doneFiles, 2100);
    assert.equal(result.totalFiles, 2100);
    assert.equal(result.skippedFiles, 1);
    assert.equal(
      result.doneBytes,
      files.reduce((sum, [, b]) => sum + b.length, 0),
    );
    assert.equal(scans, 4201, "readdir metadata should avoid re-statting each child while scanning");
    assert(updates < 200, "per-file completion must not flood renderer IPC");
    assert((await fs.stat(`${f.dest}/tree/empty`)).isDirectory());
    for (const [name, bytes] of files) assert.deepEqual(await fs.readFile(`${f.dest}/tree/${name}`), bytes);
    assert(!(await fs.readdir(`${f.dest}/tree`)).some((name) => name.endsWith(".pallet-part")));
  } finally {
    await f.cleanup();
  }
});

test("failed concurrent file cannot erase another file's completed bytes", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/good`, Buffer.alloc(8192, 7));
    await fs.writeFile(`${f.source}/bad`, Buffer.alloc(4096, 8));
    const source = wrap(f.local, {
      createReadStream: async (p, options) =>
        p.endsWith("/bad")
          ? Readable.from(
              (async function* () {
                yield Buffer.alloc(2048);
                await new Promise((r) => setTimeout(r, 50));
                throw new Error("Disk read failed");
              })(),
            )
          : f.local.createReadStream(p, options),
    });
    const result = await harness(source, f.local).run(f.source, f.dest, ["bad", "good"]);
    assert.equal(result.state, "failed");
    assert.equal(result.doneFiles, 1);
    assert.equal(result.doneBytes, 8192);
    assert.deepEqual(await fs.readdir(f.dest), ["good"]);
  } finally {
    await f.cleanup();
  }
});

test("verification failure preserves existing destination and unrelated staging file", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, "new content");
    await fs.writeFile(`${f.dest}/a`, "original");
    await fs.writeFile(`${f.dest}/a.pallet-part`, "belongs to somebody else");
    const dest = wrap(f.local, {
      createWriteStream: async () =>
        new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
    });
    const result = await harness(f.local, dest).run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "failed");
    assert.equal(await fs.readFile(`${f.dest}/a`, "utf8"), "original");
    assert.equal(await fs.readFile(`${f.dest}/a.pallet-part`, "utf8"), "belongs to somebody else");
    assert.equal(result.doneBytes, 0);
  } finally {
    await f.cleanup();
  }
});

test("large-file retry resumes at last acknowledged chunk, and keep-both name is stable", async () => {
  const f = await fixture();
  try {
    const payload = randomBytes(CHUNK * 2 + 17003);
    await fs.writeFile(`${f.source}/large`, payload);
    await fs.writeFile(`${f.dest}/large`, "original");
    const starts: number[] = [];
    let failed = false;
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        starts.push(options?.start ?? 0);
        if (options?.start === CHUNK && !failed) {
          failed = true;
          return Readable.from(
            (async function* () {
              yield payload.subarray(CHUNK, CHUNK + 4096);
              throw Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
            })(),
          );
        }
        return f.local.createReadStream(p, options);
      },
    });
    const result = await harness(source, f.local, "keepBoth").run(f.source, f.dest, ["large"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.deepEqual(starts, [0, CHUNK, CHUNK, CHUNK * 2]);
    assert.equal(result.doneBytes, payload.length);
    assert.deepEqual(await fs.readFile(`${f.dest}/large (2)`), payload);
    assert.equal(await fs.readFile(`${f.dest}/large`, "utf8"), "original");
    assert.deepEqual((await fs.readdir(f.dest)).sort(), ["large", "large (2)"]);
  } finally {
    await f.cleanup();
  }
});

test("source change rejects mixed-version upload and keeps original", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, "new content");
    await fs.writeFile(`${f.dest}/a`, "original");
    let calls = 0;
    const source = wrap(f.local, {
      statOrNull: async (p) => {
        const stat = await f.local.statOrNull(p);
        return stat && ++calls >= 3 ? { ...stat, mtimeMs: stat.mtimeMs + 1000 } : stat;
      },
    });
    const result = await harness(source, f.local).run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "failed");
    assert.match(result.errors[0].message, /Source changed/);
    assert.equal(await fs.readFile(`${f.dest}/a`, "utf8"), "original");
  } finally {
    await f.cleanup();
  }
});

test("permission errors fail closed instead of treating a destination as empty", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, "new");
    await fs.writeFile(`${f.dest}/a`, "original");
    const dest = wrap(f.local, {
      listEntries: async () => {
        throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      },
    });
    const result = await harness(f.local, dest).run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "failed");
    assert.equal(await fs.readFile(`${f.dest}/a`, "utf8"), "original");
  } finally {
    await f.cleanup();
  }
});

test("keep-both reserves names of incoming files too", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, "first");
    await fs.writeFile(`${f.source}/a (2)`, "second");
    await fs.writeFile(`${f.dest}/a`, "original");
    const result = await harness(f.local, f.local, "keepBoth").run(f.source, f.dest, ["a", "a (2)"]);
    assert.equal(result.state, "completed");
    assert.equal(await fs.readFile(`${f.dest}/a (2)`, "utf8"), "second");
    assert.equal(await fs.readFile(`${f.dest}/a (3)`, "utf8"), "first");
  } finally {
    await f.cleanup();
  }
});

test("metadata timeout during enumeration retries without losing files", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(`${f.source}/folder`);
    await fs.writeFile(`${f.source}/folder/a`, "data");
    let calls = 0;
    const source = wrap(f.local, {
      listEntries: async (p) => {
        if (++calls === 1) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        return f.local.listEntries(p);
      },
    });
    const result = await harness(source, f.local).run(f.source, f.dest, ["folder"]);
    assert.equal(result.state, "completed");
    assert.equal(result.totalFiles, 1);
  } finally {
    await f.cleanup();
  }
});

test("jobs sharing a session run within one connection budget", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, "data");
    let active = 0;
    let peak = 0;
    const dest = wrap(f.local, {
      createWriteStream: async (p, mode, options) => {
        active++;
        peak = Math.max(active, peak);
        await new Promise((r) => setTimeout(r, 25));
        const stream = await f.local.createWriteStream(p, mode, options);
        stream.once("close", () => active--);
        return stream;
      },
    });
    const h = harness(f.local, dest);
    const results = await Promise.all([h.run(f.source, `${f.dest}/one`, ["a"]), h.run(f.source, `${f.dest}/two`, ["a"])]);
    assert(results.every((r) => r.state === "completed"));
    assert.equal(peak, 1);
  } finally {
    await f.cleanup();
  }
});

test("pause during chunk two resumes from checkpoint without a second keep-both name", async () => {
  const f = await fixture();
  try {
    const payload = Buffer.alloc(CHUNK * 2 + 99, 27);
    await fs.writeFile(`${f.source}/a`, payload);
    let paused = false;
    const starts: number[] = [];
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        starts.push(options?.start ?? 0);
        if (options?.start === CHUNK && !paused) {
          paused = true;
          const id = h.queue.snapshots()[0].id;
          h.queue.pause(id);
          setTimeout(() => h.queue.resume(id), 20);
        }
        return f.local.createReadStream(p, options);
      },
    });
    const h = harness(source, f.local);
    const result = await h.run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.equal(result.doneBytes, payload.length);
    assert.deepEqual(starts, [0, CHUNK, CHUNK, CHUNK * 2]);
    assert.deepEqual(await fs.readFile(`${f.dest}/a`), payload);
  } finally {
    await f.cleanup();
  }
});

test("cancel after checkpoint cleans staging and leaves old destination intact", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, Buffer.alloc(CHUNK * 2, 27));
    await fs.writeFile(`${f.dest}/a`, "original");
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        if (options?.start === CHUNK) h.queue.cancel(h.queue.snapshots()[0].id);
        return f.local.createReadStream(p, options);
      },
    });
    const h = harness(source, f.local);
    const result = await h.run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "canceled");
    assert.equal(result.doneBytes, 0);
    assert.deepEqual(await fs.readdir(f.dest), ["a"]);
    assert.equal(await fs.readFile(`${f.dest}/a`, "utf8"), "original");
  } finally {
    await f.cleanup();
  }
});

test("ambiguous rename is reported once, without deleting or retrying destination", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, "new content");
    await fs.writeFile(`${f.dest}/a`, "old");
    let calls = 0;
    const dest = wrap(f.local, {
      renameReplacing: async (from, to) => {
        calls++;
        await f.local.renameReplacing(from, to);
        throw Object.assign(new Error("No response"), { code: "ETIMEDOUT" });
      },
    });
    const result = await harness(f.local, dest).run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "failed");
    assert.equal(calls, 1);
    assert.match(result.errors[0].message, /Could not confirm/);
    assert.equal(await fs.readFile(`${f.dest}/a`, "utf8"), "new content");
  } finally {
    await f.cleanup();
  }
});

test("destination folder symlinks are not followed during recursive copies", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(`${f.source}/tree`);
    await fs.writeFile(`${f.source}/tree/a`, "new");
    await fs.mkdir(`${f.root}/outside`);
    await fs.symlink(`${f.root}/outside`, `${f.dest}/tree`);
    const result = await harness(f.local, f.local).run(f.source, f.dest, ["tree"]);
    assert.equal(result.state, "failed");
    assert.deepEqual(await fs.readdir(`${f.root}/outside`), []);
  } finally {
    await f.cleanup();
  }
});

test("FTP timestamp verification uses a consistent precise baseline", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, "data");
    const stat = await f.local.statOrNull(`${f.source}/a`);
    let calls = 0;
    const source = wrap(f.local, {
      statOrNull: async (p) => {
        const st = await f.local.statOrNull(p);
        return st ? { ...st, mtimeMs: 0 } : st;
      },
      fileVersion: async () => {
        calls++;
        return { size: 4, mtimeMs: stat!.mtimeMs };
      },
    });
    const result = await harness(source, f.local).run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "completed");
    assert.equal(calls, 2);
    assert.equal(await fs.readFile(`${f.dest}/a`, "utf8"), "data");
  } finally {
    await f.cleanup();
  }
});

test("running jobs are re-broadcast with live true-counter progress", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    // Local copies finish inside one 100 ms tick, so throttle the source:
    // 512 KiB every 50 ms keeps the job "running" across several ticks.
    await fs.writeFile(`${f.source}/a`, Buffer.alloc(8 * 1024 * 1024, 33));
    const source = wrap(f.local, {
      createReadStream: async () =>
        // Synthetic 512 KiB reads every 50 ms. Content matches the source fill (0x21).
        Readable.from(
          (async function* () {
            for (let i = 0; i < 16; i++) {
              yield Buffer.alloc(512 * 1024, 33);
              await new Promise((r) => setTimeout(r, 50));
            }
          })(),
        ),
    });
    const updates: TransferJobSnapshot[] = [];
    const h = harness(source, f.local, "replace", (s) => {
      if (s.state === "running") updates.push(s);
    });
    const result = await h.run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    // The view must carry the real counter at sub-chunk granularity: the
    // throttled emits alone would only ever step by whole chunks.
    const deltas = updates.slice(1).map((s, i) => s.doneBytes - updates[i].doneBytes);
    assert(
      deltas.some((d) => d > 0 && d < CHUNK),
      "expected progress steps smaller than one 8 MiB chunk",
    );
    // The bar shows bytes actually transferred: never backwards, never past
    // the total, and it must spend most of the run below 100%. The counter
    // legitimately reaches totalBytes during the brief commit phase (verify,
    // setMeta, rename) while state is still "running", so allow a tick or two
    // of that — but the overshoot bug sat at 100% for the entire upload.
    const atTotal = updates.filter((s) => s.doneBytes >= s.totalBytes).length;
    assert(atTotal <= 2, `bar sat at 100% for ${atTotal} ticks while bytes remained`);
    assert(updates.length - atTotal >= 3, "expected mostly partial progress");
    // Terminal record shows the true final counters.
    const record = h.records[0];
    assert.equal(record.doneBytes, result.totalBytes);
  } finally {
    await f.cleanup();
  }
});
