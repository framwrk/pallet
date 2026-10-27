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
/** Models the SFTP channel pool: a stream holds one channel until it closes. */
function withChannelPool(endpoint: TransferEndpoint, capacity: number): TransferEndpoint {
  let used = 0;
  const waiters: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (used >= capacity) await new Promise<void>((resolve) => waiters.push(resolve));
    used++;
  };
  const release = (): void => {
    used--;
    waiters.shift()?.();
  };
  const hold = (stream: Readable | Writable): void => void stream.once("close", release);
  return wrap(endpoint, {
    createReadStream: async (p, options) => {
      await acquire();
      try {
        const stream = await endpoint.createReadStream(p, options);
        hold(stream);
        return stream;
      } catch (err) {
        release();
        throw err;
      }
    },
    createWriteStream: async (p, mode, options) => {
      await acquire();
      try {
        const stream = await endpoint.createWriteStream(p, mode, options);
        hold(stream);
        return stream;
      } catch (err) {
        release();
        throw err;
      }
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
  concurrency = 3,
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
    concurrency,
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

/**
 * Remote-to-remote harness: two distinct sessions and endpoints, so the queue
 * exercises the same path as copying between two servers.
 */
function remoteHarness(
  source: TransferEndpoint,
  dest: TransferEndpoint,
  action = "replace",
  onUpdate?: (s: TransferJobSnapshot, q: TransferQueue) => void,
  concurrency = 3,
): {
  queue: TransferQueue;
  run: (sourceBase: string, destDir: string, names: string[]) => Promise<TransferJobSnapshot>;
} {
  const waiters = new Map<string, (s: TransferJobSnapshot) => void>();
  const queue = new TransferQueue(
    sessions,
    {
      onUpdate: (s) => onUpdate?.(s, queue),
      onConflict: (p) => queue.resolveConflict(p.jobId, action as "replace" | "keepBoth", true),
      record: (s) => waiters.get(s.id)?.(s),
    },
    concurrency,
    (_sessions, ref) => (ref.kind === "sftp" && ref.sessionId === "dest" ? dest : source),
  );
  return {
    queue,
    run(sourceBase: string, destDir: string, names: string[]) {
      const id = queue.enqueue({
        from: { kind: "sftp", sessionId: "source" },
        to: { kind: "sftp", sessionId: "dest" },
        sourceBase,
        destDir,
        names,
      });
      return new Promise<TransferJobSnapshot>((resolve) => waiters.set(id, resolve));
    },
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

test("large-file retry resumes at the last acknowledged offset, and keep-both name is stable", async () => {
  const f = await fixture();
  try {
    const payload = randomBytes(CHUNK * 2 + 17003);
    await fs.writeFile(`${f.source}/large`, payload);
    await fs.writeFile(`${f.dest}/large`, "original");
    const starts: number[] = [];
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        starts.push(options?.start ?? 0);
        if (starts.length === 1) {
          // Fail after enough real data has flowed for the destination to have
          // confirmed part of it, so the retry must resume at that offset.
          const inner = await f.local.createReadStream(p, options);
          return Readable.from(
            (async function* () {
              let emitted = 0;
              for await (const chunk of inner) {
                emitted += chunk.length;
                yield chunk;
                if (emitted > CHUNK) break;
              }
              throw Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
            })(),
          );
        }
        return f.local.createReadStream(p, options);
      },
    });
    const result = await harness(source, f.local, "keepBoth").run(f.source, f.dest, ["large"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.equal(starts.length, 2);
    assert.equal(starts[0], 0);
    assert(starts[1] > 0 && starts[1] <= CHUNK + 256 * 1024, "retry must resume at the confirmed offset");
    assert.equal(result.doneBytes, payload.length);
    assert.deepEqual(await fs.readFile(`${f.dest}/large (2)`), payload);
    assert.equal(await fs.readFile(`${f.dest}/large`, "utf8"), "original");
    assert.deepEqual((await fs.readdir(f.dest)).sort(), ["large", "large (2)"]);
  } finally {
    await f.cleanup();
  }
});

test("a channel error during commit retries the whole small file", async () => {
  const f = await fixture();
  try {
    const payload = Buffer.alloc(8192, 9);
    await fs.writeFile(`${f.source}/a`, payload);
    let calls = 0;
    const dest = wrap(f.local, {
      setMeta: async (p, meta) => {
        if (++calls === 1) throw Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
        return f.local.setMeta(p, meta);
      },
    });
    const result = await harness(f.local, dest).run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.equal(calls, 2);
    assert.deepEqual(await fs.readFile(`${f.dest}/a`), payload);
    assert.deepEqual(
      (await fs.readdir(f.dest)).filter((name) => name.endsWith(".pallet-part")),
      [],
    );
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

test("pause mid-file resumes from the confirmed offset without a second keep-both name", async () => {
  const f = await fixture();
  try {
    const payload = Buffer.alloc(CHUNK * 2 + 99, 27);
    await fs.writeFile(`${f.source}/a`, payload);
    let paused = false;
    const starts: number[] = [];
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        starts.push(options?.start ?? 0);
        const read = await f.local.createReadStream(p, options);
        if (starts.length > 1 || paused) return read;
        paused = true;
        return Readable.from(
          (async function* () {
            let emitted = 0;
            for await (const chunk of read) {
              emitted += chunk.length;
              yield chunk;
              if (emitted > CHUNK) {
                const id = h.queue.snapshots()[0].id;
                h.queue.pause(id);
                setTimeout(() => h.queue.resume(id), 20);
                break;
              }
            }
          })(),
        );
      },
    });
    const h = harness(source, f.local);
    const result = await h.run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.equal(result.doneBytes, payload.length);
    assert.equal(starts[0], 0);
    assert(starts.length >= 2 && starts[1] > 0, "resume starts at the confirmed offset");
    assert.deepEqual(await fs.readdir(f.dest), ["a"], "a paused retry must not allocate a keep-both name");
    assert.deepEqual(await fs.readFile(`${f.dest}/a`), payload);
  } finally {
    await f.cleanup();
  }
});

test("cancel mid-file cleans staging and leaves old destination intact", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, Buffer.alloc(CHUNK * 2, 27));
    await fs.writeFile(`${f.dest}/a`, "original");
    let canceled = false;
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        const read = await f.local.createReadStream(p, options);
        if (canceled) return read;
        canceled = true;
        return Readable.from(
          (async function* () {
            let emitted = 0;
            for await (const chunk of read) {
              emitted += chunk.length;
              yield chunk;
              if (emitted >= CHUNK) {
                h.queue.cancel(h.queue.snapshots()[0].id);
                break;
              }
            }
          })(),
        );
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

test("small-file reads are bounded to the enumerated size", async () => {
  const f = await fixture();
  try {
    const payload = Buffer.alloc(4096, 3);
    await fs.writeFile(`${f.source}/a`, payload);
    const ends: (number | undefined)[] = [];
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        ends.push(options?.end);
        return f.local.createReadStream(p, options);
      },
    });
    const result = await harness(source, f.local).run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    // Without the bound the SFTP reader probes EOF at offset size, a wasted RTT.
    assert.deepEqual(ends, [payload.length - 1]);
    assert.deepEqual(await fs.readFile(`${f.dest}/a`), payload);
  } finally {
    await f.cleanup();
  }
});

test("a worker starts the next file before the previous commit finishes", { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, Buffer.alloc(4096, 1));
    await fs.writeFile(`${f.source}/b`, Buffer.alloc(4096, 2));
    let commits = 0;
    let writes = 0;
    let releaseFirstCommit: (() => void) | null = null;
    const secondWriteStarted = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });
    const dest = wrap(f.local, {
      setMeta: async (p, meta) => {
        // Block the first commit until the second file is already streaming.
        if (commits++ === 0) await secondWriteStarted;
        return f.local.setMeta(p, meta);
      },
      createWriteStream: async (p, mode, options) => {
        const stream = await f.local.createWriteStream(p, mode, options);
        if (++writes === 2) releaseFirstCommit?.();
        return stream;
      },
    });
    // One worker: only the one-deep pipeline can overlap the second file.
    const h = harness(f.local, dest, "replace", undefined, 1);
    const result = await h.run(f.source, f.dest, ["a", "b"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.equal(result.doneFiles, 2);
    assert.deepEqual(await fs.readdir(f.dest), ["a", "b"]);
  } finally {
    await f.cleanup();
  }
});

test("same-session copies do not deadlock the shared channel pool", { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, Buffer.alloc(4096, 1));
    await fs.writeFile(`${f.source}/b`, Buffer.alloc(4096, 2));
    // Pool fits exactly one file's read + write pair. Pipelining a second file
    // would hold both reads and wait forever for the writes.
    const pooled = withChannelPool(f.local, 2);
    const waiters = new Map<string, (s: TransferJobSnapshot) => void>();
    const queue = new TransferQueue(
      { status: () => "connected", transferConcurrency: () => 1 } as unknown as SessionManager,
      {
        onUpdate: () => {},
        onConflict: (p) => queue.resolveConflict(p.jobId, "replace", true),
        record: (s) => waiters.get(s.id)?.(s),
      },
      1,
      () => pooled,
    );
    const id = queue.enqueue({
      from: { kind: "sftp", sessionId: "same" },
      to: { kind: "sftp", sessionId: "same" },
      sourceBase: f.source,
      destDir: f.dest,
      names: ["a", "b"],
    });
    const result = await new Promise<TransferJobSnapshot>((resolve) => waiters.set(id, resolve));
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.deepEqual((await fs.readdir(f.dest)).sort(), ["a", "b"]);
  } finally {
    await f.cleanup();
  }
});

test("remote-to-remote transfers report live progress and complete", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const payload = Buffer.alloc(CHUNK / 2, 41);
    await fs.writeFile(`${f.source}/a`, payload);
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        const read = await f.local.createReadStream(p, options);
        // Pace the reads so several 100 ms progress ticks land mid-file.
        return Readable.from(
          (async function* () {
            for await (const chunk of read) {
              yield chunk;
              await new Promise((r) => setTimeout(r, 20));
            }
          })(),
        );
      },
    });
    const updates: TransferJobSnapshot[] = [];
    const h = remoteHarness(source, f.local, "replace", (s) => {
      if (s.state === "running") updates.push(s);
    });
    const result = await h.run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.equal(result.doneBytes, payload.length);
    assert(
      updates.some((s) => s.doneBytes > 0 && s.doneBytes < s.totalBytes),
      "expected progress before the remote-to-remote file finished",
    );
    assert.deepEqual(await fs.readFile(`${f.dest}/a`), payload);
    assert(!(await fs.readdir(f.dest)).some((name) => name.endsWith(".pallet-part")));
  } finally {
    await f.cleanup();
  }
});

test("remote-to-remote cancel mid-file cleans destination staging and keeps the original", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, Buffer.alloc(CHUNK * 2, 27));
    await fs.writeFile(`${f.dest}/a`, "original");
    let canceled = false;
    const source = wrap(f.local, {
      createReadStream: async (p, options) => {
        const read = await f.local.createReadStream(p, options);
        if (canceled) return read;
        canceled = true;
        return Readable.from(
          (async function* () {
            let emitted = 0;
            for await (const chunk of read) {
              emitted += chunk.length;
              yield chunk;
              if (emitted >= CHUNK / 2) {
                h.queue.cancel(h.queue.snapshots()[0].id);
                break;
              }
            }
          })(),
        );
      },
    });
    const h = remoteHarness(source, f.local);
    const result = await h.run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "canceled");
    assert.equal(result.doneBytes, 0);
    assert.deepEqual(await fs.readdir(f.dest), ["a"]);
    assert.equal(await fs.readFile(`${f.dest}/a`, "utf8"), "original");
    assert(!(await fs.readdir(f.dest)).some((name) => name.endsWith(".pallet-part")));
  } finally {
    await f.cleanup();
  }
});

test("remote-to-remote conflicts keep both files", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/a`, "new");
    await fs.writeFile(`${f.dest}/a`, "original");
    const result = await remoteHarness(f.local, f.local, "keepBoth").run(f.source, f.dest, ["a"]);
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.deepEqual((await fs.readdir(f.dest)).sort(), ["a", "a (2)"]);
    assert.equal(await fs.readFile(`${f.dest}/a`, "utf8"), "original");
    assert.equal(await fs.readFile(`${f.dest}/a (2)`, "utf8"), "new");
  } finally {
    await f.cleanup();
  }
});

test("remote-to-remote cancel stops conflict detection instead of scanning every folder", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    for (const name of ["a", "b", "c"]) {
      await fs.mkdir(`${f.source}/tree/${name}`, { recursive: true });
      await fs.writeFile(`${f.source}/tree/${name}/file`, name);
      // Existing destination folders get listed during conflict detection.
      await fs.mkdir(`${f.dest}/tree/${name}`, { recursive: true });
    }
    let destLists = 0;
    const dest = wrap(f.local, {
      listEntries: async (p) => {
        destLists++;
        // dest root, then "tree", then "tree/a": cancel partway through.
        if (destLists === 3) h.queue.cancel(h.queue.snapshots()[0].id);
        return f.local.listEntries(p);
      },
    });
    const h = remoteHarness(f.local, dest);
    const result = await h.run(f.source, f.dest, ["tree"]);
    assert.equal(result.state, "canceled");
    assert.equal(destLists, 3, "conflict detection must stop at the cancellation point");
    assert.deepEqual(await fs.readdir(`${f.dest}/tree/a`), [], "no file may be copied after cancellation");
  } finally {
    await f.cleanup();
  }
});

test("remote-to-remote partial failure keeps completed files and removes staging", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.source}/bad`, Buffer.alloc(4096, 8));
    await fs.writeFile(`${f.source}/good`, Buffer.alloc(8192, 7));
    const source = wrap(f.local, {
      createReadStream: async (p, options) =>
        p.endsWith("/bad")
          ? Readable.from(
              (async function* () {
                yield Buffer.alloc(2048);
                await new Promise((r) => setTimeout(r, 20));
                throw new Error("Remote read failed");
              })(),
            )
          : f.local.createReadStream(p, options),
    });
    const result = await remoteHarness(source, f.local).run(f.source, f.dest, ["good", "bad"]);
    assert.equal(result.state, "failed");
    assert.equal(result.doneFiles, 1);
    assert.equal(result.doneBytes, 8192, "the failed file's rolled-back bytes must not count");
    assert.deepEqual((await fs.readdir(f.dest)).sort(), ["good"]);
    assert(!(await fs.readdir(f.dest)).some((name) => name.endsWith(".pallet-part")));
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
