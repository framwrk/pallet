/**
 * Transfer history should carry the real enqueue/terminal timestamps plus
 * structured endpoints, instead of two Date.now() calls and a human label.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Readable } from "node:stream";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import type { TransferEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import type { TransferJobSnapshot } from "../src/shared/transfer/transfer.types";
import { TransferQueue } from "../src/main/services/transfer/transfer-queue";
import { join } from "node:path";
import { makeEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "pallet-transfer-history-"));
const databaseFile = join(dir, "pallet.db");

const sessions = { status: () => "connected", transferConcurrency: () => 1 } as unknown as SessionManager;

let db: Database.Database;
let recordTransferHistory: typeof import("../src/main/services/transfer/transfer-history").recordTransferHistory;
let transferDirection: typeof import("../src/main/services/transfer/transfer-history").transferDirection;

beforeAll(async () => {
  db = new Database(databaseFile);
  const { initializeDatabase } = await import("../src/main/services/database-schema");
  initializeDatabase(db);
  mock.module("../src/main/services/database", () => ({ getDb: () => db }));
  ({ recordTransferHistory, transferDirection } = await import("../src/main/services/transfer/transfer-history"));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

/** Pace the first chunk so the job takes measurable time to finish. */
function pacedSource(local: TransferEndpoint): TransferEndpoint {
  let paced = false;
  return wrap(local, {
    createReadStream: async (path, options) => {
      const stream = await local.createReadStream(path, options);
      return Readable.from(
        (async function* () {
          for await (const chunk of stream) {
            yield chunk;
            if (!paced) {
              paced = true;
              await new Promise((resolve) => setTimeout(resolve, 40));
            }
          }
        })(),
      );
    },
  });
}

/** Let one method be overridden while the rest of the endpoint keeps its prototype. */
function wrap(endpoint: TransferEndpoint, overrides: Partial<TransferEndpoint>): TransferEndpoint {
  return new Proxy(endpoint, {
    get(target, key) {
      const value = key in overrides ? Reflect.get(overrides, key) : Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function runUpload(
  source: TransferEndpoint,
  dest: TransferEndpoint,
  sourceBase: string,
  destDir: string,
  names: string[],
): Promise<TransferJobSnapshot> {
  return new Promise((resolve) => {
    const queue = new TransferQueue(
      sessions,
      {
        onUpdate: () => {},
        onConflict: (prompt) => queue.resolveConflict(prompt.jobId, "replace", true),
        record: (job, request) => {
          recordTransferHistory(job, request);
          resolve(job);
        },
      },
      1,
      (_sessions, ref) => (ref.kind === "local" ? source : dest),
    );
    queue.enqueue({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId: "test" },
      sourceBase,
      destDir,
      names,
    });
  });
}

test("records real timestamps, direction, and structured endpoints for an upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "pallet-history-run-"));
  const sourceDir = join(root, "source");
  const destDir = join(root, "dest");
  mkdirSync(sourceDir);
  mkdirSync(destDir);
  const payload = Buffer.alloc(256 * 1024, 7);
  writeFileSync(join(sourceDir, "a"), payload);
  const local = makeEndpoint(sessions, { kind: "local" });
  try {
    const snapshot = await runUpload(pacedSource(local), local, sourceDir, destDir, ["a"]);
    const row = db
      .prepare(
        `SELECT direction, source, dest, bytes, status, error, started_at, finished_at
         FROM transfer_history ORDER BY id DESC LIMIT 1`,
      )
      .get() as {
      direction: string;
      source: string;
      dest: string;
      bytes: number;
      status: string;
      error: string | null;
      started_at: number;
      finished_at: number;
    };

    expect(snapshot.state).toBe("completed");
    expect(row.status).toBe("completed");
    expect(row.error).toBeNull();
    expect(row.bytes).toBe(payload.length);
    expect(row.started_at).toBe(snapshot.startedAt);
    expect(row.finished_at).toBeGreaterThan(row.started_at);
    expect(row.direction).toBe("upload");
    expect(JSON.parse(row.source)).toEqual({ kind: "local", path: sourceDir });
    expect(JSON.parse(row.dest)).toEqual({ kind: "sftp", sessionId: "test", path: destDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("derives direction from the endpoint kinds", () => {
  expect(transferDirection({ kind: "local" }, { kind: "sftp", sessionId: "x" })).toBe("upload");
  expect(transferDirection({ kind: "sftp", sessionId: "x" }, { kind: "local" })).toBe("download");
  expect(transferDirection({ kind: "sftp", sessionId: "a" }, { kind: "sftp", sessionId: "b" })).toBe("remote-to-remote");
  expect(transferDirection({ kind: "local" }, { kind: "local" })).toBe("local");
});
