/**
 * Transfer queue integration tests against the Dockerized OpenSSH server:
 * upload/download (files + trees), .pallet-part staging, conflicts with
 * apply-to-all, keep-both, cancel cleanup, and unicode names.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import type { ConflictPrompt, TransferJobSnapshot } from "../../src/shared/transfers";
import { SessionManager } from "../../src/main/services/session-manager";
import { TransferQueue } from "../../src/main/services/transfer/queue";
import { HARNESS, startServer, stopServer } from "./harness";

let sessionId = "";
const updates: TransferJobSnapshot[] = [];
let conflictPrompts: ConflictPrompt[] = [];
let conflictResponder: ((prompt: ConflictPrompt) => void) | null = null;

const sessions = new SessionManager({
  verifyHostKey: async () => true,
  onStatus: () => {},
});

const queue = new TransferQueue(sessions, {
  onUpdate: (s) => updates.push(s),
  onConflict: (prompt) => {
    conflictPrompts.push(prompt);
    conflictResponder?.(prompt);
  },
});

function latest(id: string): TransferJobSnapshot {
  const snapshot = queue.snapshots().find((s) => s.id === id);
  if (!snapshot) throw new Error("missing job " + id);
  return snapshot;
}

async function waitDone(id: string, timeoutMs = 30_000): Promise<TransferJobSnapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = latest(id);
    if (["completed", "failed", "canceled"].includes(snapshot.state)) return snapshot;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${snapshot.state}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

let localBase = "";

function sftpExec(cmd: string): string {
  return execSync(`docker exec -u testuser pallet-openssh-test-run sh -c ${JSON.stringify(cmd)}`, {
    encoding: "utf8",
  });
}

beforeAll(async () => {
  await startServer();
  const result = await sessions.connect({
    host: HARNESS.host,
    port: HARNESS.port,
    username: HARNESS.username,
    auth: { method: "password", password: HARNESS.password },
  });
  sessionId = result.sessionId;
  localBase = mkdtempSync(join(tmpdir(), "pallet-m5-"));
}, 120_000);

afterAll(() => {
  sessions.disconnectAll();
  stopServer();
  rmSync(localBase, { recursive: true, force: true });
});

describe("upload", () => {
  test("directory tree with unicode names uploads atomically", async () => {
    const src = join(localBase, "up");
    mkdirSync(join(src, "nested", "deep"), { recursive: true });
    writeFileSync(join(src, "a.txt"), "alpha");
    writeFileSync(join(src, "naïve 文件.txt"), "unicode content");
    writeFileSync(join(src, "nested", "b.txt"), "bravo");
    writeFileSync(join(src, "nested", "deep", "c.txt"), "charlie");

    const id = queue.enqueue({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId },
      sourceBase: localBase,
      names: ["up"],
      destDir: "/home/testuser/dest",
    });
    const done = await waitDone(id);
    expect(done.state).toBe("completed");
    expect(done.doneFiles).toBe(4);
    expect(done.totalBytes).toBe(done.doneBytes);

    expect(sftpExec("cat /home/testuser/dest/up/a.txt")).toBe("alpha");
    expect(sftpExec("cat /home/testuser/dest/up/nested/deep/c.txt")).toBe("charlie");
    expect(sftpExec('cat "/home/testuser/dest/up/naïve 文件.txt"')).toBe("unicode content");
    // No staging debris.
    expect(sftpExec('find /home/testuser/dest -name "*.pallet-part" | wc -l').trim()).toBe("0");
  }, 60_000);

  test("mtime is preserved on upload", () => {
    const localMtime = Math.floor(statSync(join(localBase, "up", "a.txt")).mtimeMs / 1000);
    const remoteMtime = Number.parseInt(sftpExec("stat -c %Y /home/testuser/dest/up/a.txt").trim(), 10);
    expect(Math.abs(remoteMtime - localMtime)).toBeLessThanOrEqual(1);
  });
});

describe("download", () => {
  test("fixtures download; symlinks are skipped not followed", async () => {
    const dest = join(localBase, "down");
    mkdirSync(dest, { recursive: true });
    const id = queue.enqueue({
      from: { kind: "sftp", sessionId },
      to: { kind: "local" },
      sourceBase: "/home/testuser",
      names: ["fixtures"],
      destDir: dest,
    });
    const done = await waitDone(id);
    expect(done.state).toBe("completed");
    expect(readFileSync(join(dest, "fixtures", "hello.txt"), "utf8")).toBe("hello world\n");
    expect(readFileSync(join(dest, "fixtures", "naïve Dätei 文件.txt"), "utf8")).toBe("unicode\n");
    // 3 symlinks in fixtures are skipped.
    expect(done.skippedFiles).toBe(3);
    expect(readdirSync(join(dest, "fixtures")).some((n) => n.includes("link"))).toBe(false);
  }, 60_000);
});

describe("conflicts", () => {
  function makeConflictSources(tag: string): string {
    const src = join(localBase, `conf-${tag}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "x.txt"), `new-x-${tag}`);
    writeFileSync(join(src, "y.txt"), `new-y-${tag}`);
    return src;
  }

  test("replace with apply-to-all", async () => {
    const src = makeConflictSources("replace");
    sftpExec(
      "mkdir -p /home/testuser/conf && printf old-x > /home/testuser/conf/x.txt && printf old-y > /home/testuser/conf/y.txt",
    );

    conflictResponder = (prompt) => queue.resolveConflict(prompt.jobId, "replace", true);
    const id = queue.enqueue({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId },
      sourceBase: src,
      names: ["x.txt", "y.txt"],
      destDir: "/home/testuser/conf",
    });
    const done = await waitDone(id);
    conflictResponder = null;
    expect(done.state).toBe("completed");
    // Apply-to-all: exactly one prompt for two conflicts.
    expect(conflictPrompts.length).toBe(1);
    expect(conflictPrompts[0].remaining).toBe(2);
    expect(sftpExec("cat /home/testuser/conf/x.txt")).toBe("new-x-replace");
    expect(sftpExec("cat /home/testuser/conf/y.txt")).toBe("new-y-replace");
  }, 60_000);

  test("skip leaves the destination untouched", async () => {
    conflictPrompts = [];
    const src = makeConflictSources("skip");
    conflictResponder = (prompt) => queue.resolveConflict(prompt.jobId, "skip", true);
    const id = queue.enqueue({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId },
      sourceBase: src,
      names: ["x.txt", "y.txt"],
      destDir: "/home/testuser/conf",
    });
    const done = await waitDone(id);
    conflictResponder = null;
    expect(done.state).toBe("completed");
    expect(done.skippedFiles).toBe(2);
    expect(sftpExec("cat /home/testuser/conf/x.txt")).toBe("new-x-replace");
  }, 60_000);

  test('keep both creates "(2)" names', async () => {
    conflictPrompts = [];
    const src = makeConflictSources("keep");
    conflictResponder = (prompt) => queue.resolveConflict(prompt.jobId, "keepBoth", true);
    const id = queue.enqueue({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId },
      sourceBase: src,
      names: ["x.txt", "y.txt"],
      destDir: "/home/testuser/conf",
    });
    const done = await waitDone(id);
    conflictResponder = null;
    expect(done.state).toBe("completed");
    expect(sftpExec('cat "/home/testuser/conf/x (2).txt"')).toBe("new-x-keep");
    expect(sftpExec("cat /home/testuser/conf/x.txt")).toBe("new-x-replace");
  }, 60_000);

  test("per-file decisions without apply-to-all prompt once per conflict", async () => {
    conflictPrompts = [];
    const src = makeConflictSources("mixed");
    const actions: ("replace" | "skip")[] = ["replace", "skip"];
    conflictResponder = (prompt) => queue.resolveConflict(prompt.jobId, actions[conflictPrompts.length - 1], false);
    const id = queue.enqueue({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId },
      sourceBase: src,
      names: ["x.txt", "y.txt"],
      destDir: "/home/testuser/conf",
    });
    const done = await waitDone(id);
    conflictResponder = null;
    expect(done.state).toBe("completed");
    expect(conflictPrompts.length).toBe(2);
  }, 60_000);
});

describe("local ↔ local through the queue", () => {
  test("local copy uses the same staging path", async () => {
    const src = join(localBase, "ll-src");
    const dst = join(localBase, "ll-dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(src, "f.bin"), Buffer.alloc(1024 * 1024, 7));

    const id = queue.enqueue({
      from: { kind: "local" },
      to: { kind: "local" },
      sourceBase: src,
      names: ["f.bin"],
      destDir: dst,
    });
    const done = await waitDone(id);
    expect(done.state).toBe("completed");
    expect(readFileSync(join(dst, "f.bin")).length).toBe(1024 * 1024);
    expect(readdirSync(dst).some((n) => n.endsWith(".pallet-part"))).toBe(false);
  }, 30_000);
});

describe("cancel", () => {
  test("cancel mid-transfer leaves no .pallet-part debris", async () => {
    const src = join(localBase, "big");
    mkdirSync(src, { recursive: true });
    // 64 MB so there is time to cancel.
    writeFileSync(join(src, "big.bin"), Buffer.alloc(64 * 1024 * 1024, 1));

    const id = queue.enqueue({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId },
      sourceBase: src,
      names: ["big.bin"],
      destDir: "/home/testuser/cancel-test",
    });
    // Wait until bytes start moving, then cancel.
    const deadline = Date.now() + 15_000;
    while (latest(id).doneBytes === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    queue.cancel(id);
    const done = await waitDone(id);
    expect(done.state).toBe("canceled");
    await new Promise((r) => setTimeout(r, 500));
    expect(sftpExec("ls /home/testuser/cancel-test 2>/dev/null || true").trim()).toBe("");
  }, 60_000);
});
