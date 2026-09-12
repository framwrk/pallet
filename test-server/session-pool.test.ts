import { PassThrough, Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import type { SFTPWrapper } from "ssh2";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import assert from "node:assert/strict";
import { makeEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";

function poolFixture(): {
  manager: SessionManager;
  session: { generation: number; pool: { total: number; free: SFTPWrapper[]; waiters: unknown[] } };
} {
  const manager = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
  const session = {
    id: "test",
    generation: 1,
    status: "connected",
    closing: false,
    profile: { concurrency: 1, protocol: "sftp" },
    pool: { total: 0, free: [] as SFTPWrapper[], waiters: [] },
    client: {
      sftp(callback: (err: Error | null, channel: unknown) => void) {
        const channel = Object.assign(new EventEmitter(), { end: () => {} });
        callback(null, channel);
      },
    },
  };
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set("test", session);
  return { manager, session };
}

test("broken channel wakes pooled waiters, and release is idempotent", async () => {
  const { manager, session } = poolFixture();
  const first = await manager.acquireTransferChannel("test");
  const second = await manager.acquireTransferChannel("test");
  const waiting = manager.acquireTransferChannel("test");
  const rejected = assert.rejects(waiting, /Channel closed/);
  first.release(true);
  first.release(true);
  await rejected;
  assert.equal(session.pool.total, 1);
  const replacement = await manager.acquireTransferChannel("test");
  assert.equal(session.pool.total, 2);
  replacement.release();
  second.release();
  second.release();
  assert.equal(session.pool.free.length, 2);
});

test("old-generation channel cannot enter the new connection pool", async () => {
  const { manager, session } = poolFixture();
  const old = await manager.acquireTransferChannel("test");
  session.generation++;
  session.pool.total = 0;
  const current = await manager.acquireTransferChannel("test");
  old.release(true);
  assert.equal(session.pool.total, 1);
  current.release();
  assert.equal(session.pool.free.length, 1);
});

test("FTP download waits for server confirmation after data EOF", async () => {
  let broken = false;
  const manager = {
    protocol: () => "ftp",
    acquireFtpClient: async () => ({
      client: {
        downloadTo: async (sink: PassThrough) => {
          sink.end(Buffer.from("payload"));
          await new Promise((r) => setTimeout(r, 10));
          throw new Error("426 Transfer aborted by server");
        },
      },
      release: (failed = false) => {
        broken ||= failed;
      },
    }),
  } as unknown as SessionManager;
  const endpoint = makeEndpoint(manager, { kind: "sftp", sessionId: "ftp" });
  const stream = await endpoint.createReadStream("/file");
  await assert.rejects(async () => {
    for await (const chunk of stream) void chunk;
  }, /426/);
  assert(broken);
});

test("canceling an FTP stream disposes its connection without waiting for a reply", async () => {
  let disposed = false;
  const manager = {
    protocol: () => "ftp",
    acquireFtpClient: async () => ({
      client: { downloadTo: () => new Promise(() => {}) },
      release: (broken = false) => {
        disposed ||= broken;
      },
    }),
  } as unknown as SessionManager;
  const endpoint = makeEndpoint(manager, { kind: "sftp", sessionId: "ftp" });
  const controller = new AbortController();
  const stream = await endpoint.createReadStream("/file", { signal: controller.signal });
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  controller.abort();
  await closed;
  assert(disposed);
});

test("SFTP metadata distinguishes permissions from missing files", async () => {
  let errorCode = 3;
  const manager = {
    protocol: () => "sftp",
    acquireTransferChannel: async () => ({
      sftp: {
        lstat: (_p: string, callback: (err: Error) => void) =>
          callback(Object.assign(new Error("Permission denied"), { code: errorCode })),
      },
      release: () => {},
    }),
  } as unknown as SessionManager;
  const endpoint = makeEndpoint(manager, { kind: "sftp", sessionId: "sftp" });
  await assert.rejects(endpoint.statOrNull("/file"), /Permission/);
  errorCode = 2;
  assert.equal(await endpoint.statOrNull("/missing"), null);
});

test("SFTP replacement never unlinks the original when atomic rename fails", async () => {
  let unlinks = 0;
  let renames = 0;
  const manager = {
    protocol: () => "sftp",
    acquireTransferChannel: async () => ({
      sftp: {
        ext_openssh_rename: () => {
          throw new Error("Server does not support this extended request");
        },
        rename: (_from: string, _to: string, callback: (err: Error) => void) => {
          renames++;
          callback(new Error("Destination exists"));
        },
        unlink: () => {
          unlinks++;
        },
      },
      release: () => {},
    }),
  } as unknown as SessionManager;
  const endpoint = makeEndpoint(manager, { kind: "sftp", sessionId: "sftp" });
  await assert.rejects(endpoint.renameReplacing("/part", "/original"), /Destination exists/);
  assert.equal(renames, 1);
  assert.equal(unlinks, 0);
});

test("SFTP upload waits for CLOSE and propagates a late server error", async () => {
  let broken = false;
  const inner = new Writable({
    autoDestroy: false,
    write(_chunk, _encoding, callback) {
      callback();
    },
    final(callback) {
      callback();
      setTimeout(() => inner.destroy(new Error("Disk quota exceeded on CLOSE")), 10);
    },
  });
  const manager = {
    protocol: () => "sftp",
    acquireTransferChannel: async () => ({
      sftp: { createWriteStream: () => inner },
      release: (failed = false) => {
        broken ||= failed;
      },
    }),
  } as unknown as SessionManager;
  const endpoint = makeEndpoint(manager, { kind: "sftp", sessionId: "sftp" });
  await assert.rejects(pipeline(Readable.from(Buffer.from("data")), await endpoint.createWriteStream("/part")), /quota/);
  assert(broken);
});
