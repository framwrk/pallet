/**
 * §7 DoD: "at least one non-OpenSSH SFTP server". SFTPGo is an independent
 * Go implementation, so it exercises protocol assumptions that a second
 * OpenSSH instance never would.
 *
 * Runs under Node (see drop-resilience.ts for why).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { SessionManager } from "../../src/main/services/session-manager";
import { SftpService } from "../../src/main/services/sftp-service";
import { TransferQueue } from "../../src/main/services/transfer/queue";
import { dockerOrThrow, ensureDockerAvailable, removeContainer, withDeadline } from "../support/docker";

const CONTAINER = "pallet-sftpgo-test-run";
const PORT = 2224;

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) failures.push(label);
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail && !condition ? ` — ${detail}` : ""}`);
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate the repo root");
    dir = parent;
  }
  return dir;
}

const sessions = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
const svc = new SftpService(sessions);
const queue = new TransferQueue(sessions, { onUpdate: () => {}, onConflict: () => {} });

/**
 * Retry the real SSH handshake rather than probing for a banner: SFTPGo
 * accepts TCP connections a little before it will complete key exchange,
 * and the handshake is the thing we actually need working.
 */
async function connectWithRetry(timeoutMs: number): Promise<{
  sessionId: string;
  initialPath: string;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;
  for (;;) {
    try {
      return await sessions.connect({
        host: "127.0.0.1",
        port: PORT,
        username: "testuser",
        auth: { method: "password", password: "testpass" },
      });
    } catch (err) {
      lastError = err as Error;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`SFTPGo never accepted a connection: ${lastError?.message}`);
}

async function runJob(request: Parameters<TransferQueue["enqueue"]>[0]): Promise<string> {
  const id = queue.enqueue(request);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const snapshot = queue.snapshots().find((s) => s.id === id);
    if (!snapshot) throw new Error("job vanished");
    if (["completed", "failed", "canceled"].includes(snapshot.state)) return snapshot.state;
    if (Date.now() > deadline) throw new Error(`job stuck in ${snapshot.state}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function main(): Promise<void> {
  ensureDockerAvailable();
  // Wait for a previous run's container to be fully gone; otherwise the new
  // one either fails to bind the port or we connect to the corpse's proxy.
  removeContainer(CONTAINER);
  dockerOrThrow(
    [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-p",
      `127.0.0.1:${PORT}:2022`,
      "-v",
      `${join(repoRoot(), "tests", "node", "docker-sftpgo", "dump.json")}:/srv/dump.json:ro`,
      "-e",
      "SFTPGO_LOADDATA_FROM=/srv/dump.json",
      "drakkan/sftpgo:latest",
    ],
    300_000,
  );
  const base = mkdtempSync(join(tmpdir(), "pallet-interop-"));
  try {
    const { sessionId, initialPath } = await connectWithRetry(90_000);
    check("password auth against SFTPGo", true);

    const listing = await svc.list(sessionId, initialPath);
    check("directory listing works", Array.isArray(listing.entries));

    writeFileSync(join(base, "roundtrip.txt"), "via sftpgo");
    const upState = await runJob({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId },
      sourceBase: base,
      names: ["roundtrip.txt"],
      destDir: initialPath,
    });
    check("upload completed", upState === "completed", `ended in ${upState}`);

    await svc.mkdir(sessionId, `${initialPath}/subdir`);
    check("mkdir works", (await svc.stat(sessionId, `${initialPath}/subdir`)).kind === "dir");

    await svc.rename(sessionId, `${initialPath}/roundtrip.txt`, `${initialPath}/renamed.txt`);
    check("rename works", (await svc.stat(sessionId, `${initialPath}/renamed.txt`)).size === 10);

    const downState = await runJob({
      from: { kind: "sftp", sessionId },
      to: { kind: "local" },
      sourceBase: initialPath,
      names: ["renamed.txt"],
      destDir: base,
    });
    check("download completed", downState === "completed", `ended in ${downState}`);
    check("round-tripped content is intact", readFileSync(join(base, "renamed.txt"), "utf8") === "via sftpgo");

    await svc.removeRecursive(sessionId, `${initialPath}/subdir`);
    await svc.removeRecursive(sessionId, `${initialPath}/renamed.txt`);
    check("recursive delete works", !(await svc.list(sessionId, initialPath)).entries.some((e) => e.name === "subdir"));
  } finally {
    sessions.disconnectAll();
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }
}

/** Teardown must never throw and mask the real failure. */
function cleanup(): void {
  try {
    removeContainer(CONTAINER);
  } catch {
    // The original error matters more.
  }
}

withDeadline(main(), 10 * 60_000, "interop suite").then(
  () => {
    console.log(failures.length === 0 ? "\nAll interop checks passed." : `\nFAILED: ${failures}`);
    process.exit(failures.length === 0 ? 0 : 1);
  },
  (err) => {
    console.error("interop run crashed:", err instanceof Error ? err.message : err);
    cleanup();
    process.exit(1);
  },
);
