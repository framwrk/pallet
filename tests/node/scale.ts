/**
 * §7 DoD scale checks: a large file, a 10,000-file directory, and a
 * non-ASCII name — in both directions, verified by hash and by count.
 *
 * Runs under Node (see drop-resilience.ts for why). The large-file size is
 * configurable so routine runs can stay quick:
 *   PALLET_SCALE_GB=5 bun run test:scale
 */
import { execSync } from "child_process";
import { createHash } from "crypto";
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionManager } from "../../src/main/services/session-manager";
import { TransferQueue } from "../../src/main/services/transfer/queue";
import type { TransferJobSnapshot } from "../../src/shared/transfers";
import { HARNESS, startServer, stopServer } from "../integration/harness";
import { ensureDockerAvailable, withDeadline } from "../support/docker";

const LARGE_GB = Number(process.env.PALLET_SCALE_GB ?? "5");
const FILE_COUNT = Number(process.env.PALLET_SCALE_FILES ?? "10000");

const failures: string[] = [];
function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) failures.push(label);
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail && !condition ? ` — ${detail}` : ""}`);
}

function sh(cmd: string): string {
  return execSync(`docker exec -u testuser pallet-openssh-test-run sh -c ${JSON.stringify(cmd)}`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const sessions = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
const queue = new TransferQueue(sessions, { onUpdate: () => {}, onConflict: () => {} });

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function runJob(
  label: string,
  request: Parameters<TransferQueue["enqueue"]>[0],
  timeoutMs: number,
): Promise<TransferJobSnapshot> {
  const started = Date.now();
  const id = queue.enqueue(request);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = queue.snapshots().find((s) => s.id === id);
    if (!snapshot) throw new Error("job vanished");
    if (["completed", "failed", "canceled"].includes(snapshot.state)) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const mb = (snapshot.doneBytes / 1e6).toFixed(0);
      console.log(`  ${label}: ${snapshot.state} — ${mb} MB in ${secs}s`);
      return snapshot;
    }
    if (Date.now() > deadline) throw new Error(`${label} timed out in ${snapshot.state}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main(): Promise<void> {
  ensureDockerAvailable();
  await startServer();
  const { sessionId } = await sessions.connect({
    host: HARNESS.host,
    port: HARNESS.port,
    username: HARNESS.username,
    auth: { method: "password", password: HARNESS.password },
  });
  const base = mkdtempSync(join(tmpdir(), "pallet-scale-"));

  try {
    // --- large file, both directions -------------------------------------
    const largeDir = join(base, "large");
    mkdirSync(largeDir, { recursive: true });
    const largePath = join(largeDir, "large.bin");
    console.log(`Building a ${LARGE_GB} GB test file…`);
    // Position-dependent pattern: a spliced or truncated copy cannot match.
    const chunk = Buffer.alloc(64 * 1024 * 1024);
    writeFileSync(largePath, Buffer.alloc(0));
    const { appendFileSync } = await import("fs");
    for (let written = 0; written < LARGE_GB * 1e9; written += chunk.length) {
      for (let i = 0; i + 4 <= chunk.length; i += 65536) chunk.writeUInt32LE((written + i) >>> 0, i);
      appendFileSync(largePath, chunk);
    }
    const largeSha = await sha256OfFile(largePath);

    const up = await runJob(
      `upload ${LARGE_GB} GB`,
      {
        from: { kind: "local" },
        to: { kind: "sftp", sessionId },
        sourceBase: largeDir,
        names: ["large.bin"],
        destDir: "/home/testuser/scale",
      },
      30 * 60_000,
    );
    check(`${LARGE_GB} GB upload completed`, up.state === "completed");
    check(`${LARGE_GB} GB upload is byte-identical`, sh("sha256sum /home/testuser/scale/large.bin").split(" ")[0] === largeSha);

    const backDir = join(base, "large-back");
    mkdirSync(backDir, { recursive: true });
    const down = await runJob(
      `download ${LARGE_GB} GB`,
      {
        from: { kind: "sftp", sessionId },
        to: { kind: "local" },
        sourceBase: "/home/testuser/scale",
        names: ["large.bin"],
        destDir: backDir,
      },
      30 * 60_000,
    );
    check(`${LARGE_GB} GB download completed`, down.state === "completed");
    check(`${LARGE_GB} GB download is byte-identical`, (await sha256OfFile(join(backDir, "large.bin"))) === largeSha);

    rmSync(largePath, { force: true });
    rmSync(join(backDir, "large.bin"), { force: true });
    sh("rm -f /home/testuser/scale/large.bin");

    // --- 10,000-file directory, both directions --------------------------
    console.log(`Building a ${FILE_COUNT}-file directory…`);
    const manyDir = join(base, "many");
    mkdirSync(manyDir, { recursive: true });
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(manyDir, `file-${String(i).padStart(5, "0")}.txt`), `payload ${i}\n`);
    }
    // A non-ASCII name rides along in the same batch.
    writeFileSync(join(manyDir, "naïve Dätei 文件.txt"), "unicode payload\n");

    const upMany = await runJob(
      `upload ${FILE_COUNT} files`,
      {
        from: { kind: "local" },
        to: { kind: "sftp", sessionId },
        sourceBase: base,
        names: ["many"],
        destDir: "/home/testuser/scale",
      },
      30 * 60_000,
    );
    check(`${FILE_COUNT}-file upload completed`, upMany.state === "completed");
    check("every uploaded file arrived", Number(sh("ls -1 /home/testuser/scale/many | wc -l").trim()) === FILE_COUNT + 1);
    check(
      "non-ASCII name survived the upload",
      sh('cat "/home/testuser/scale/many/naïve Dätei 文件.txt"') === "unicode payload\n",
    );

    const manyBack = join(base, "many-back");
    mkdirSync(manyBack, { recursive: true });
    const downMany = await runJob(
      `download ${FILE_COUNT} files`,
      {
        from: { kind: "sftp", sessionId },
        to: { kind: "local" },
        sourceBase: "/home/testuser/scale",
        names: ["many"],
        destDir: manyBack,
      },
      30 * 60_000,
    );
    check(`${FILE_COUNT}-file download completed`, downMany.state === "completed");
    const backNames = readdirSync(join(manyBack, "many"));
    check("every downloaded file arrived", backNames.length === FILE_COUNT + 1);
    check("non-ASCII name survived the download", backNames.includes("naïve Dätei 文件.txt"));
    check(
      "no .pallet-part debris in either direction",
      !backNames.some((n) => n.endsWith(".pallet-part")) &&
        sh('find /home/testuser/scale -name "*.pallet-part" | wc -l').trim() === "0",
    );
  } finally {
    sessions.disconnectAll();
    stopServer();
    rmSync(base, { recursive: true, force: true });
  }
}

withDeadline(main(), 60 * 60_000, "scale suite").then(
  () => {
    console.log(failures.length === 0 ? "\nAll scale checks passed." : `\nFAILED: ${failures}`);
    process.exit(failures.length === 0 ? 0 : 1);
  },
  (err) => {
    console.error("scale run crashed:", err instanceof Error ? err.message : err);
    stopServer();
    process.exit(1);
  },
);
