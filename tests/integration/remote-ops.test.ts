/** M6 remote write ops against real OpenSSH: mkdir/rename/rm -r/chmod/read. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { SessionManager } from "../../src/main/services/session-manager";
import { SftpService } from "../../src/main/services/sftp-service";
import { HARNESS, startServer, stopServer } from "./harness";

const sessions = new SessionManager({
  verifyHostKey: async () => true,
  onStatus: () => {},
});
const svc = new SftpService(sessions);
let sid = "";

function sh(cmd: string): string {
  return execSync(`docker exec -u testuser pallet-openssh-test-run sh -c ${JSON.stringify(cmd)}`, {
    encoding: "utf8",
  });
}

beforeAll(async () => {
  await startServer();
  sid = (
    await sessions.connect({
      host: HARNESS.host,
      port: HARNESS.port,
      username: HARNESS.username,
      auth: { method: "password", password: HARNESS.password },
    })
  ).sessionId;
}, 120_000);

afterAll(() => {
  sessions.disconnectAll();
  stopServer();
});

describe("remote ops", () => {
  test("mkdirUnique numbers itself", async () => {
    sh("mkdir -p /home/testuser/ops");
    expect(await svc.mkdirUnique(sid, "/home/testuser/ops")).toBe("untitled folder");
    expect(await svc.mkdirUnique(sid, "/home/testuser/ops")).toBe("untitled folder 2");
  }, 30_000);

  test("rename refuses to overwrite", async () => {
    sh("printf a > /home/testuser/ops/a.txt && printf b > /home/testuser/ops/b.txt");
    await expect(svc.rename(sid, "/home/testuser/ops/a.txt", "/home/testuser/ops/b.txt")).rejects.toThrow(/already exists/);
    await svc.rename(sid, "/home/testuser/ops/a.txt", "/home/testuser/ops/c.txt");
    expect(sh("cat /home/testuser/ops/c.txt")).toBe("a");
  }, 30_000);

  test("recursive delete removes trees but never follows symlinks", async () => {
    sh(
      "mkdir -p /home/testuser/ops/tree/deep && printf x > /home/testuser/ops/tree/f.txt && " +
        "printf y > /home/testuser/ops/tree/deep/g.txt && mkdir -p /home/testuser/keepme && " +
        "printf keep > /home/testuser/keepme/safe.txt && ln -s /home/testuser/keepme /home/testuser/ops/tree/link",
    );
    await svc.removeRecursive(sid, "/home/testuser/ops/tree");
    expect(sh("ls /home/testuser/ops")).not.toContain("tree");
    // The symlink target survives untouched.
    expect(sh("cat /home/testuser/keepme/safe.txt")).toBe("keep");
  }, 30_000);

  test("chmod round-trips through stat", async () => {
    sh("printf z > /home/testuser/ops/perm.txt && chmod 644 /home/testuser/ops/perm.txt");
    await svc.chmod(sid, "/home/testuser/ops/perm.txt", 0o750);
    const entry = await svc.stat(sid, "/home/testuser/ops/perm.txt");
    expect(entry.mode & 0o7777).toBe(0o750);
  }, 30_000);

  test("readBytes respects maxBytes", async () => {
    sh("head -c 4096 /dev/urandom > /home/testuser/ops/blob.bin");
    const all = await svc.readBytes(sid, "/home/testuser/ops/blob.bin", 1024 * 1024);
    expect(all.length).toBe(4096);
    const capped = await svc.readBytes(sid, "/home/testuser/ops/blob.bin", 1000);
    expect(capped.length).toBe(1000);
  }, 30_000);
});
