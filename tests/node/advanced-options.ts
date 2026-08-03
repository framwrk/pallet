/**
 * The connect dialog's Advanced disclosure (§4): keepalive, compression, and
 * concurrency. These reach ssh2's handshake and the channel pool, where a
 * wrong value fails as a hang or a refused connection rather than a type
 * error — so they need a real server to mean anything.
 *
 * Runs under Node (see drop-resilience.ts for why).
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionManager } from "../../src/main/services/session-manager";
import { SftpService } from "../../src/main/services/sftp-service";
import { TransferQueue } from "../../src/main/services/transfer/queue";
import { HARNESS, startServer, stopServer } from "../integration/harness";
import { ensureDockerAvailable, withDeadline } from "../support/docker";

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) failures.push(label);
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail && !condition ? ` — ${detail}` : ""}`);
}

const sessions = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
const svc = new SftpService(sessions);
const queue = new TransferQueue(sessions, { onUpdate: () => {}, onConflict: () => {} });

const CASES = [
  { label: "compression on, concurrency 1", compression: true, concurrency: 1 },
  { label: "compression off, concurrency 7 (the cap)", compression: false, concurrency: 7 },
  { label: "concurrency above the cap is clamped", compression: false, concurrency: 999 },
  { label: "concurrency below 1 is clamped", compression: true, concurrency: 0 },
] as const;

async function main(): Promise<void> {
  ensureDockerAvailable();
  await startServer();
  const base = mkdtempSync(join(tmpdir(), "pallet-advanced-"));
  // Large enough that compression and channel count actually engage.
  writeFileSync(join(base, "payload.txt"), "compressible ".repeat(40_000));

  try {
    for (const testCase of CASES) {
      const { sessionId, initialPath } = await sessions.connect({
        host: HARNESS.host,
        port: HARNESS.port,
        username: HARNESS.username,
        auth: { method: "password", password: HARNESS.password },
        keepaliveIntervalMs: 5000,
        compression: testCase.compression,
        concurrency: testCase.concurrency,
      });
      try {
        const listing = await svc.list(sessionId, initialPath);
        check(`${testCase.label}: connects and lists`, listing.entries.length > 0);

        const destDir = `/home/testuser/adv-${testCase.concurrency}-${testCase.compression}`;
        const id = queue.enqueue({
          from: { kind: "local" },
          to: { kind: "sftp", sessionId },
          sourceBase: base,
          names: ["payload.txt"],
          destDir,
        });
        const deadline = Date.now() + 60_000;
        let state = "";
        for (;;) {
          const snapshot = queue.snapshots().find((s) => s.id === id);
          state = snapshot?.state ?? "";
          if (["completed", "failed", "canceled"].includes(state)) break;
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        check(`${testCase.label}: transfer completes`, state === "completed", `ended in ${state}`);

        if (state === "completed") {
          const written = await svc.stat(sessionId, `${destDir}/payload.txt`);
          check(`${testCase.label}: destination size is correct`, written.size === 520_000);
        }
      } finally {
        sessions.disconnect(sessionId);
      }
    }
  } finally {
    sessions.disconnectAll();
    stopServer();
    rmSync(base, { recursive: true, force: true });
  }
}

withDeadline(main(), 15 * 60_000, "advanced-options suite").then(
  () => {
    console.log(failures.length === 0 ? "\nAll advanced-option checks passed." : `\nFAILED: ${failures}`);
    process.exit(failures.length === 0 ? 0 : 1);
  },
  (err) => {
    console.error("advanced-options run crashed:", err instanceof Error ? err.message : err);
    stopServer();
    process.exit(1);
  },
);
