/**
 * Transfer throughput benchmark: Pallet's queue + ssh2 endpoints vs the
 * OpenSSH `sftp` CLI, against the local Docker test server.
 *
 * Run `bun run server` first, then `bun run test-server/bench-transfers.ts`.
 * The container's PALLET_TEST_NETWORK profile applies; switch it mid-flight
 * with `docker compose exec -e PALLET_TEST_NETWORK=optimal sftp test-server-network`.
 *
 * Env knobs:
 *   BENCH_SIZE_MB    big-file size (default 256)
 *   BENCH_MANY_COUNT small files (default 1000)
 *   BENCH_MANY_KB    small-file size in KiB (default 64)
 *   BENCH_CONCURRENCY transfer streams (default 4)
 *   BENCH_ONLY       "cli" | "pallet" | "raw" (default: all)
 *   BENCH_SFTP_ARGS  extra args for the sftp CLI, e.g. "-R 64 -B 262144"
 */
import type { TransferJobSnapshot, TransferRequest } from "../src/shared/transfer/transfer.types";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import type { ConnectProfile } from "../src/shared/sftp/sftp.types";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import { TransferQueue } from "../src/main/services/transfer/transfer-queue";
import { makeEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const PORT = Number(process.env.PALLET_TEST_SERVER_PORT ?? 2222);
const PASSWORD = process.env.PALLET_TEST_PASSWORD ?? "pallet";
const SIZE_MB = Number(process.env.BENCH_SIZE_MB ?? 256);
const MANY_COUNT = Number(process.env.BENCH_MANY_COUNT ?? 1000);
const MANY_KB = Number(process.env.BENCH_MANY_KB ?? 64);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 4);
const ONLY = process.env.BENCH_ONLY ?? "";
const SFTP_ARGS = process.env.BENCH_SFTP_ARGS ?? "";

const bigSize = SIZE_MB * 1024 * 1024;
const manyBytes = MANY_COUNT * MANY_KB * 1024;
const fmtSize = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const fmtRate = (bytes: number, ms: number): string => `${(bytes / 1024 / 1024 / (ms / 1000)).toFixed(1)} MiB/s`;

const sessions = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
const records = new Map<string, (job: TransferJobSnapshot) => void>();
const queue = new TransferQueue(
  sessions,
  {
    onUpdate: () => {},
    onConflict: (prompt) => queue.resolveConflict(prompt.jobId, "replace", true),
    record: (job) => records.get(job.id)?.(job),
  },
  CONCURRENCY,
);

function run(request: TransferRequest): Promise<TransferJobSnapshot> {
  return new Promise((resolve, reject) => {
    const id = queue.enqueue(request);
    const timer = setTimeout(() => {
      queue.cancel(id);
      reject(new Error(`deadline: ${id}`));
    }, 900_000);
    records.set(id, (job) => {
      clearTimeout(timer);
      records.delete(id);
      if (job.state !== "completed") reject(new Error(JSON.stringify(job.errors)));
      else resolve(job);
    });
  });
}

/** Drive the interactive sftp CLI through expect; commands are sent one by one. */
function sftpCli(commands: string[], label: string): void {
  const lines = [
    "set timeout 900",
    `spawn /usr/bin/sftp -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ${SFTP_ARGS} -P ${PORT} pallet@127.0.0.1`,
    "expect {",
    '  -re "password:" { send "pallet\\r" }',
    `  timeout { puts "AUTH-${label}"; exit 1 }`,
    "}",
    "expect {",
    '  -re "sftp>" {}',
    `  timeout { puts "PROMPT-${label}"; exit 1 }`,
    "}",
  ];
  for (const command of commands) {
    lines.push(`send "${command}\\r"`, "expect {", '  -re "sftp>" {}', `  timeout { puts "CMD-${label}"; exit 1 }`, "}");
  }
  lines.push('send "quit\\r"', "expect eof", "exit 0");
  const result = spawnSync("expect", ["-c", lines.join("\n")], { encoding: "utf8", timeout: 900_000 });
  if (result.status !== 0) throw new Error(`expect failed (${label}): ${result.stdout}\n${result.stderr}`);
}

const root = await fs.mkdtemp(`${tmpdir()}/pallet-bench-`);
try {
  const profile: ConnectProfile = {
    protocol: "sftp",
    host: "127.0.0.1",
    port: PORT,
    username: "pallet",
    auth: { method: "password", password: PASSWORD },
    concurrency: CONCURRENCY,
  };
  const { sessionId, initialPath } = await sessions.connect(profile);
  const ref = { kind: "sftp" as const, sessionId };
  const base = `${initialPath === "/" ? "" : initialPath}/.pallet-bench-${Date.now()}`;
  console.log(
    `payload: ${fmtSize(bigSize)} big + ${MANY_COUNT} x ${MANY_KB} KiB (${fmtSize(manyBytes)}); concurrency=${CONCURRENCY}` +
      (SFTP_ARGS ? `; sftp args: ${SFTP_ARGS}` : ""),
  );

  const bigLocal = `${root}/big.bin`;
  {
    const handle = await fs.open(bigLocal, "w");
    await handle.truncate(bigSize);
    await handle.close();
    const manyDir = `${root}/many`;
    await fs.mkdir(manyDir, { recursive: true });
    const chunk = Buffer.alloc(MANY_KB * 1024, 5);
    await Promise.all(
      Array.from({ length: MANY_COUNT }, (_, i) => fs.writeFile(`${manyDir}/f-${String(i).padStart(4, "0")}.bin`, chunk)),
    );
  }

  const endpoint = makeEndpoint(sessions, ref);
  const localEndpoint = makeEndpoint(sessions, { kind: "local" });

  if (ONLY === "" || ONLY === "cli") {
    sftpCli([`mkdir ${base}`], "mkdir");
    let start = Date.now();
    sftpCli([`put ${bigLocal} ${base}/cli-big.bin`], "big-put");
    console.log(`cli    big upload    ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(bigSize, Date.now() - start)}`);
    start = Date.now();
    sftpCli([`get ${base}/cli-big.bin ${root}/cli-big.bin`], "big-get");
    console.log(`cli    big download  ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(bigSize, Date.now() - start)}`);
    sftpCli([`mkdir ${base}/cli-many`], "mkdir-many");
    start = Date.now();
    sftpCli([`put -r ${root}/many/* ${base}/cli-many/`], "many-put");
    console.log(`cli    many upload   ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(manyBytes, Date.now() - start)}`);
  }

  if (ONLY === "" || ONLY === "raw") {
    const remote = await endpoint.createWriteStream(`${base}/raw-big.bin`);
    let start = Date.now();
    await pipeline(createReadStream(bigLocal), remote);
    console.log(`raw    big upload    ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(bigSize, Date.now() - start)}`);
    const source = await endpoint.createReadStream(`${base}/raw-big.bin`);
    start = Date.now();
    await pipeline(source, createWriteStream(`${root}/raw-big.bin`));
    console.log(`raw    big download  ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(bigSize, Date.now() - start)}`);
  }

  if (ONLY === "" || ONLY === "pallet") {
    let start = Date.now();
    const up = await run({ from: { kind: "local" }, to: ref, sourceBase: root, destDir: base, names: ["big.bin"] });
    console.log(`pallet big upload    ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(bigSize, Date.now() - start)}`);
    start = Date.now();
    const down = await run({ from: ref, to: { kind: "local" }, sourceBase: base, destDir: `${root}/dl`, names: ["big.bin"] });
    console.log(`pallet big download  ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(bigSize, Date.now() - start)}`);
    if (up.doneBytes !== bigSize || down.doneBytes !== bigSize) throw new Error("size mismatch");
    start = Date.now();
    const upMany = await run({
      from: { kind: "local" },
      to: ref,
      sourceBase: root,
      destDir: `${base}/pallet-many`,
      names: ["many"],
    });
    console.log(
      `pallet many upload   ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(manyBytes, Date.now() - start)} (${upMany.doneFiles}/${MANY_COUNT})`,
    );
    start = Date.now();
    await run({
      from: ref,
      to: { kind: "local" },
      sourceBase: `${base}/pallet-many`,
      destDir: `${root}/many-dl`,
      names: ["many"],
    });
    console.log(`pallet many download ${((Date.now() - start) / 1000).toFixed(2)}s  ${fmtRate(manyBytes, Date.now() - start)}`);
    // Sanity: digests of the first and last small file.
    const bytes = await fs.readFile(`${root}/many-dl/many/f-0000.bin`);
    if (bytes.length !== MANY_KB * 1024) throw new Error("small-file download size mismatch");
    localEndpoint.dispose();
  }

  endpoint.dispose();
  sessions.disconnect(sessionId);
} finally {
  sessions.disconnectAll();
  await fs.rm(root, { recursive: true, force: true });
}
