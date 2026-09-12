import type { ConnectProfile, ConnectionProtocol } from "../src/shared/sftp/sftp.types";
import type { TransferJobSnapshot, TransferRequest } from "../src/shared/transfer/transfer.types";
import { Readable } from "node:stream";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import { SftpService } from "../src/main/services/sftp/sftp.service";
import { TransferQueue } from "../src/main/services/transfer/transfer-queue";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { makeEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { tmpdir } from "node:os";

const CHUNK = 8 * 1024 * 1024;
const profiles: { protocol: ConnectionProtocol; port: number; remotePath: string; tlsRejectUnauthorized?: boolean }[] = [
  { protocol: "sftp", port: Number(process.env.PALLET_TEST_SERVER_PORT ?? 2222), remotePath: "/home/pallet" },
  { protocol: "ftp", port: Number(process.env.PALLET_TEST_FTP_PORT ?? 2121), remotePath: "/" },
  { protocol: "ftps", port: Number(process.env.PALLET_TEST_FTPS_PORT ?? 2122), remotePath: "/", tlsRejectUnauthorized: false },
];
const records = new Map<string, (job: TransferJobSnapshot) => void>();
const sessions = new SessionManager({ verifyHostKey: async () => true, onStatus: (event) => queue.handleSessionStatus(event) });
const service = new SftpService(sessions);
let injected = false;
let activeSessionId = "";
const starts: number[] = [];
const queue = new TransferQueue(
  sessions,
  {
    onUpdate: () => {},
    onConflict: (prompt) => queue.resolveConflict(prompt.jobId, "replace", true),
    record: (job) => records.get(job.id)?.(job),
  },
  7,
  (manager, ref) => {
    const endpoint = makeEndpoint(manager, ref);
    if (ref.kind !== "local") return endpoint;
    const read = endpoint.createReadStream.bind(endpoint);
    endpoint.createReadStream = async (p, options) => {
      if (p.endsWith("/large.bin")) {
        starts.push(options?.start ?? 0);
        if (options?.start === CHUNK && !injected) {
          injected = true;
          if (process.env.PALLET_TEST_DISCONNECT === "1") {
            // Fault injection touches only the session created by this test.
            const internal = sessions as unknown as { sessions: Map<string, { client: { destroy(): void } }> };
            internal.sessions.get(activeSessionId)!.client.destroy();
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return Readable.from(
            (async function* () {
              yield Buffer.alloc(4096, 37);
              throw Object.assign(new Error("Injected connection reset after checkpoint"), { code: "ECONNRESET" });
            })(),
          );
        }
      }
      return read(p, options);
    };
    return endpoint;
  },
);
function run(request: TransferRequest): Promise<TransferJobSnapshot> {
  return new Promise((resolve, reject) => {
    const id = queue.enqueue(request);
    const timer = setTimeout(
      () => {
        queue.cancel(id);
        reject(new Error(`Transfer deadline exceeded: ${id}`));
      },
      Number(process.env.PALLET_TEST_TRANSFER_TIMEOUT_MS ?? 180_000),
    );
    records.set(id, (job) => {
      clearTimeout(timer);
      records.delete(id);
      if (job.state !== "completed") reject(new Error(JSON.stringify(job)));
      else resolve(job);
    });
  });
}
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
const root = await fs.mkdtemp(`${tmpdir()}/pallet-real-transfers-`);
try {
  for (const profile of profiles) {
    if (process.env.PALLET_TEST_PROTOCOL && profile.protocol !== process.env.PALLET_TEST_PROTOCOL) continue;
    const config: ConnectProfile = {
      ...profile,
      host: "127.0.0.1",
      username: "pallet",
      auth: { method: "password", password: process.env.PALLET_TEST_PASSWORD ?? "pallet" },
      concurrency: 1,
    };
    const { sessionId, initialPath } = await sessions.connect(config);
    activeSessionId = sessionId;
    const ref = { kind: "sftp" as const, sessionId };
    const remote = `${initialPath === "/" ? "" : initialPath}/.pallet-transfers-${Date.now()}`;
    const source = `${root}/${profile.protocol}`;
    const download = `${root}/${profile.protocol}-download`;
    await fs.mkdir(`${source}/tree/empty`, { recursive: true });
    const count = Number(process.env.PALLET_TEST_FILE_COUNT ?? 12);
    const expected = new Map<string, Buffer>();
    for (let i = 0; i < count; i++) expected.set(`file-${i}`, Buffer.alloc(i * 37, i % 256));
    if (profile.protocol === "sftp" && process.env.PALLET_TEST_LARGE_FILE !== "0")
      expected.set("large.bin", Buffer.alloc(CHUNK * 2 + 39001, 37));
    for (const [name, data] of expected) await fs.writeFile(`${source}/tree/${name}`, data);
    try {
      const request: TransferRequest = {
        from: { kind: "local" },
        to: ref,
        sourceBase: source,
        destDir: remote,
        names: ["tree"],
      };
      const uploaded = await run(request);
      console.log(`✓ ${profile.protocol}: uploaded ${uploaded.doneFiles} files`);
      assert.equal(uploaded.doneFiles, expected.size);
      // Repeat overwrites real existing files through each protocol's safe rename path.
      await run({ ...request, sourceBase: `${source}/tree`, destDir: `${remote}/tree`, names: ["file-1"] });
      const result = await run({ from: ref, to: { kind: "local" }, sourceBase: remote, destDir: download, names: ["tree"] });
      assert.equal(result.doneBytes, uploaded.doneBytes);
      for (const [name, data] of expected)
        assert.equal(digest(await fs.readFile(`${download}/tree/${name}`)), digest(data), `${profile.protocol}: ${name}`);
      assert((await fs.stat(`${download}/tree/empty`)).isDirectory());
      // Two stream leases on the smallest pool, with two jobs competing for it.
      await Promise.all(
        [1, 2].map((n) =>
          run({
            from: ref,
            to: ref,
            sourceBase: `${remote}/tree`,
            destDir: `${remote}/copy-${n}`,
            names: ["file-1", "file-2"],
          }),
        ),
      );
      if (expected.has("large.bin")) assert.deepEqual(starts, [0, CHUNK, CHUNK, CHUNK * 2]);
      console.log(
        `✓ ${profile.protocol}: ${expected.size} files round-trip with SHA-256 equality, empty folder, replacement, concurrent jobs and same-session copy at concurrency=1`,
      );
    } finally {
      await service.removeRecursive(sessionId, remote).catch(() => {});
      sessions.disconnect(sessionId);
    }
  }
} finally {
  sessions.disconnectAll();
  await fs.rm(root, { recursive: true, force: true });
}
console.log("Transfer queue integration verification passed.");
