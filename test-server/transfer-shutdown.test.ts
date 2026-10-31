/**
 * Quitting must not leave `.pallet-part` staging files behind. Shutdown
 * cancels active jobs, aborts their streams, and waits for the run cleanup
 * that removes staged files, bounded so a dead destination cannot block exit.
 */
import { Readable } from "node:stream";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import type { TransferEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { TransferQueue } from "../src/main/services/transfer/transfer-queue";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { makeEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { test } from "node:test";
import { tmpdir } from "node:os";

const CHUNK = 8 * 1024 * 1024;
const sessions = { status: () => "connected", transferConcurrency: () => 3 } as unknown as SessionManager;

interface Fixture {
  root: string;
  source: string;
  dest: string;
  local: TransferEndpoint;
  cleanup: () => Promise<void>;
}

interface ShutdownResult {
  timedOut: boolean;
  remaining: number;
}

function wrap(endpoint: TransferEndpoint, overrides: Partial<TransferEndpoint>): TransferEndpoint {
  return new Proxy(endpoint, {
    get(target, key) {
      const value = key in overrides ? Reflect.get(overrides, key) : Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(`${tmpdir()}/pallet-shutdown-`);
  const source = `${root}/source`;
  const dest = `${root}/dest`;
  await fs.mkdir(source);
  await fs.mkdir(dest);
  const local = makeEndpoint(sessions, { kind: "local" });
  return { root, source, dest, local, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function harness(source: TransferEndpoint, dest: TransferEndpoint): TransferQueue {
  const queue = new TransferQueue(
    sessions,
    {
      onUpdate: () => {},
      onConflict: (prompt) => queue.resolveConflict(prompt.jobId, "replace", true),
    },
    3,
    (_sessions, ref) => (ref.kind === "local" ? source : dest),
  );
  return queue;
}

/** Calls `onHalf` once the first chunk of a large file has been read. */
function stopAtHalfChunk(local: TransferEndpoint, onHalf: () => void): TransferEndpoint {
  let first = true;
  return wrap(local, {
    createReadStream: async (p, options) => {
      const read = await local.createReadStream(p, options);
      if (!first) return read;
      first = false;
      return Readable.from(
        (async function* () {
          let emitted = 0;
          for await (const chunk of read) {
            emitted += chunk.length;
            yield chunk;
            if (emitted >= CHUNK) {
              onHalf();
              break;
            }
          }
        })(),
      );
    },
  });
}

function enqueue(queue: TransferQueue, sourceBase: string, destDir: string): void {
  queue.enqueue({
    from: { kind: "local" },
    to: { kind: "sftp", sessionId: "test" },
    sourceBase,
    destDir,
    names: ["a"],
  });
}

/** Shut the queue down after the first chunk of a two-chunk file was copied. */
async function shutdownMidFile(
  f: Fixture,
  dest: TransferEndpoint,
  timeoutMs?: number,
): Promise<{ queue: TransferQueue; result: ShutdownResult }> {
  await fs.writeFile(`${f.source}/a`, Buffer.alloc(CHUNK * 2, 27));
  const control: { queue?: TransferQueue; shutdown?: Promise<ShutdownResult>; release?: () => void } = {};
  const halfway = new Promise<void>((resolve) => (control.release = resolve));
  const source = stopAtHalfChunk(f.local, () => {
    if (!control.queue) throw new Error("queue not ready");
    assert.equal(control.queue.hasActiveTransfers(), true, "the job is still copying");
    control.shutdown = control.queue.shutdown(timeoutMs);
    control.release?.();
  });
  const queue = harness(source, dest);
  control.queue = queue;
  enqueue(queue, f.source, f.dest);

  await halfway;
  assert.ok(control.shutdown, "shutdown must have started");
  return { queue, result: await control.shutdown };
}

test("shutdown mid-file cancels the job and removes its staging file", async () => {
  const f = await fixture();
  try {
    const { queue, result } = await shutdownMidFile(f, f.local);

    assert.deepEqual(result, { timedOut: false, remaining: 0 });
    assert.equal(queue.hasActiveTransfers(), false);
    assert.equal(queue.snapshots()[0].state, "canceled");
    assert.deepEqual(await fs.readdir(f.dest), [], "no staging file may survive the quit");
  } finally {
    await f.cleanup();
  }
});

test("shutdown with no active transfers returns immediately", async () => {
  const f = await fixture();
  try {
    const queue = harness(f.local, f.local);
    assert.equal(queue.hasActiveTransfers(), false);
    assert.deepEqual(await queue.shutdown(5000), { timedOut: false, remaining: 0 });
  } finally {
    await f.cleanup();
  }
});

test("shutdown stops waiting when staging cleanup hangs", async () => {
  const f = await fixture();
  try {
    // A destination that never answers a remove: quitting must not hang on it.
    const dest = wrap(f.local, { removeFile: () => new Promise<void>(() => {}) });
    const { result } = await shutdownMidFile(f, dest, 25);

    assert.equal(result.timedOut, true);
    assert.equal(result.remaining, 1);
  } finally {
    await f.cleanup();
  }
});
