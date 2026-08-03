/**
 * §7 DoD: a connection drop mid-transfer must never leave a corrupted
 * destination file. The server is restarted under a running upload; the job
 * has to auto-pause, reconnect, restage via `.pallet-part`, and finish with
 * byte-identical content.
 *
 * Runs under **Node**, not `bun test`, and is bundled by `bun run
 * test:resilience`. Pallet ships on Electron (Node), and ssh2's streams do
 * not behave the same way on Bun's runtime — a dead channel's callbacks
 * never fire there, so the reconnect path stalls in a way it never does in
 * the real app. Testing the runtime we ship on is the point.
 */
import { execSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionManager } from "../../src/main/services/session-manager";
import { TransferQueue } from "../../src/main/services/transfer/queue";
import { HARNESS, restartServer, startServer, stopServer } from "../integration/harness";
import { ensureDockerAvailable, withDeadline } from "../support/docker";

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ""): void {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures.push(label);
  console.log(`${status} ${label}${detail && !condition ? ` — ${detail}` : ""}`);
}

function sh(cmd: string): string {
  return execSync(`docker exec -u testuser pallet-openssh-test-run sh -c ${JSON.stringify(cmd)}`, {
    encoding: "utf8",
  });
}

const sessions = new SessionManager({
  verifyHostKey: async () => true,
  onStatus: (event) => queue.handleSessionStatus(event),
});
const queue = new TransferQueue(sessions, { onUpdate: () => {}, onConflict: () => {} });

async function main(): Promise<void> {
  ensureDockerAvailable();
  await startServer();
  const { sessionId } = await sessions.connect({
    host: HARNESS.host,
    port: HARNESS.port,
    username: HARNESS.username,
    auth: { method: "password", password: HARNESS.password },
  });
  const base = mkdtempSync(join(tmpdir(), "pallet-drop-"));

  try {
    // Big enough to still be in flight when the server dies, and filled with
    // a position-dependent pattern so a spliced file cannot hash correctly.
    const payload = Buffer.alloc(512 * 1024 * 1024);
    for (let i = 0; i + 4 <= payload.length; i += 4096) payload.writeUInt32LE(i, i);
    writeFileSync(join(base, "big.bin"), payload);
    const wantSha = createHash("sha256").update(payload).digest("hex");

    const id = queue.enqueue({
      from: { kind: "local" },
      to: { kind: "sftp", sessionId },
      sourceBase: base,
      names: ["big.bin"],
      destDir: "/home/testuser/dropzone",
    });
    const snapshotOf = (): ReturnType<TransferQueue["snapshots"]>[number] => {
      const found = queue.snapshots().find((s) => s.id === id);
      if (!found) throw new Error("job vanished");
      return found;
    };

    // Kill the server once bytes are actually moving.
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000 && snapshotOf().doneBytes < 10 * 1024 * 1024) {
      await new Promise((r) => setTimeout(r, 50));
    }
    check("transfer started before the drop", snapshotOf().doneBytes >= 10 * 1024 * 1024);
    await restartServer();

    const deadline = Date.now() + 180_000;
    const statesSeen = new Set<string>();
    let state = "";
    while (Date.now() < deadline) {
      const snapshot = snapshotOf();
      state = snapshot.state;
      statesSeen.add(state);
      if (["completed", "failed", "canceled"].includes(state)) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    check("job recovered and completed", state === "completed", `ended in ${state}`);
    check("job auto-paused during the outage", statesSeen.has("paused"));
    check("no .pallet-part debris left behind", sh("ls /home/testuser/dropzone").trim() === "big.bin");
    const gotSha = sh("sha256sum /home/testuser/dropzone/big.bin").split(" ")[0];
    check("destination file is byte-identical", gotSha === wantSha, `got ${gotSha}`);
  } finally {
    sessions.disconnectAll();
    stopServer();
    rmSync(base, { recursive: true, force: true });
  }
}

withDeadline(main(), 10 * 60_000, "drop-resilience suite").then(
  () => {
    console.log(failures.length === 0 ? "\nAll resilience checks passed." : "\nFAILED");
    process.exit(failures.length === 0 ? 0 : 1);
  },
  (err) => {
    console.error("resilience run crashed:", err instanceof Error ? err.message : err);
    stopServer();
    process.exit(1);
  },
);
