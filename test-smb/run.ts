import type { ConnectProfile, SessionStatusEvent } from "../src/shared/sftp/sftp.types";
import type { TransferJobSnapshot, TransferRequest } from "../src/shared/transfer/transfer.types";
import { FolderSizes } from "../src/main/services/folder-size.service";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import { SftpService } from "../src/main/services/sftp/sftp.service";
import { TransferQueue } from "../src/main/services/transfer/transfer-queue";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";

const profile: ConnectProfile = {
  protocol: "smb",
  host: "127.0.0.1",
  port: Number(process.env.PALLET_SMB_TEST_PORT ?? 1445),
  username: "pallet",
  auth: { method: "password", password: process.env.PALLET_TEST_PASSWORD ?? "pallet" },
  smb: { share: "pallet" },
  concurrency: 4,
};

const statuses: SessionStatusEvent[] = [];
const records = new Map<string, (job: TransferJobSnapshot) => void>();
const sessions = new SessionManager({
  verifyHostKey: async () => true,
  onStatus: (event) => {
    statuses.push(event);
    queue.handleSessionStatus(event);
  },
});
const service = new SftpService(sessions);
const sizes = new FolderSizes(sessions);
const queue = new TransferQueue(
  sessions,
  {
    onUpdate: () => {},
    onConflict: (prompt) => queue.resolveConflict(prompt.jobId, "replace", true),
    record: (job) => records.get(job.id)?.(job),
  },
  7,
);

function run(request: TransferRequest): Promise<TransferJobSnapshot> {
  return new Promise((resolve, reject) => {
    const id = queue.enqueue({ ...request, verification: "sha256" });
    const timer = setTimeout(() => {
      queue.cancel(id);
      reject(new Error(`Transfer deadline exceeded: ${id}`));
    }, 120_000);
    records.set(id, (job) => {
      clearTimeout(timer);
      records.delete(id);
      if (job.state === "completed") resolve(job);
      else reject(new Error(JSON.stringify(job)));
    });
  });
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function step(message: string): void {
  console.log(`✓ ${message}`);
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<string> {
  try {
    await promise;
  } catch (err) {
    assert.equal((err as NodeJS.ErrnoException).code, code, (err as Error).message);
    return (err as Error).message;
  }
  throw new Error(`Expected ${code}`);
}

await rejectsWith(sessions.connect({ ...profile, auth: { method: "password", password: "wrong" } }), "EAUTH");
await rejectsWith(sessions.connect({ ...profile, smb: { share: "missing" } }), "ENOENT");
step("wrong password and missing share fail with actionable errors");

const { sessionId, initialPath } = await sessions.connect(profile);
assert.equal(initialPath, "/");
const ref = { kind: "sftp" as const, sessionId };
const remote = `/pallet-smb-check-${Date.now()}`;
const local = await fs.mkdtemp(`${tmpdir()}/pallet-smb-check-`);
try {
  await service.mkdir(sessionId, remote);
  const expected = new Map<string, Buffer>([
    ["empty.txt", Buffer.alloc(0)],
    ["small.txt", Buffer.from("hello from pallet")],
    ["café ünïcode.txt", Buffer.from("utf-16 names")],
    ["large.bin", Buffer.alloc(12 * 1024 * 1024 + 4099, 7)],
  ]);
  for (let i = 0; i < 40; i++) expected.set(`many/file-${i}.txt`, Buffer.from(`file ${i}`));
  await fs.mkdir(`${local}/up/tree/many`, { recursive: true });
  await fs.mkdir(`${local}/up/tree/empty-folder`);
  for (const [name, data] of expected) await fs.writeFile(`${local}/up/tree/${name}`, data);

  const uploadStarted = Date.now();
  const uploaded = await run({ from: { kind: "local" }, to: ref, sourceBase: `${local}/up`, destDir: remote, names: ["tree"] });
  assert.equal(uploaded.doneFiles, expected.size);
  step(`uploaded ${uploaded.doneFiles} files with SHA-256 verification in ${Date.now() - uploadStarted} ms`);

  const listing = await service.list(sessionId, `${remote}/tree`);
  const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("large.bin")?.size, expected.get("large.bin")!.length);
  assert.equal(byName.get("many")?.kind, "dir");
  assert.equal(byName.get("empty-folder")?.kind, "dir");
  assert(byName.get("small.txt")!.mtimeMs > Date.now() - 600_000, "listing carries modification times");
  assert.equal((await service.list(sessionId, `${remote}/tree/many`)).entries.length, 40);
  step("listings carry sizes, kinds, and dates");

  assert.equal((await service.readBytes(sessionId, `${remote}/tree/small.txt`, 5)).toString(), "hello");
  const total = [...expected.values()].reduce((sum, data) => sum + data.length, 0);
  assert.equal(await sizes.get(ref, `${remote}/tree`), total);
  step("preview reads and folder sizes work");

  await fs.writeFile(`${local}/up/tree/small.txt`, "replaced contents");
  expected.set("small.txt", Buffer.from("replaced contents"));
  await run({
    from: { kind: "local" },
    to: ref,
    sourceBase: `${local}/up/tree`,
    destDir: `${remote}/tree`,
    names: ["small.txt"],
  });
  assert.equal((await service.readBytes(sessionId, `${remote}/tree/small.txt`, 100)).toString(), "replaced contents");
  step("conflict replacement overwrites through the staged rename");

  const downloadStarted = Date.now();
  const downloaded = await run({
    from: ref,
    to: { kind: "local" },
    sourceBase: remote,
    destDir: `${local}/down`,
    names: ["tree"],
  });
  for (const [name, data] of expected) {
    assert.equal(digest(await fs.readFile(`${local}/down/tree/${name}`)), digest(data), name);
  }
  assert((await fs.stat(`${local}/down/tree/empty-folder`)).isDirectory());
  step(`downloaded ${downloaded.doneFiles} files with matching SHA-256 in ${Date.now() - downloadStarted} ms`);

  await run({ from: ref, to: ref, sourceBase: `${remote}/tree`, destDir: `${remote}/copy`, names: ["small.txt", "many"] });
  assert.equal((await service.list(sessionId, `${remote}/copy/many`)).entries.length, 40);
  step("same-session remote copy works");

  await rejectsWith(service.rename(sessionId, `${remote}/copy/small.txt`, `${remote}/tree/small.txt`), "EEXIST");
  await service.rename(sessionId, `${remote}/copy/small.txt`, `${remote}/copy/renamed.txt`);
  assert.equal((await service.stat(sessionId, `${remote}/copy/renamed.txt`)).kind, "file");
  await rejectsWith(service.chmod(sessionId, `${remote}/copy/renamed.txt`, 0o644), "ENOTSUP");
  step("rename refuses to overwrite, renames otherwise; chmod reports ENOTSUP");

  const internal = sessions as unknown as {
    sessions: Map<string, { smb: { client: { conn: { transport: { socket: { destroy(): void } } } } } | null }>;
  };
  internal.sessions.get(sessionId)!.smb!.client.conn.transport.socket.destroy();
  const deadline = Date.now() + 15_000;
  while (sessions.status(sessionId) !== "connected" || !statuses.some((event) => event.status === "reconnecting")) {
    if (Date.now() > deadline) throw new Error(`No reconnect: ${JSON.stringify(statuses.slice(-3))}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await service.list(sessionId, `${remote}/tree/many`)).entries.length, 40);
  step("a dropped connection reconnects and browsing resumes");
} finally {
  await service.removeRecursive(sessionId, remote).catch((err) => console.error("cleanup failed:", err));
  await rejectsWith(service.stat(sessionId, remote), "ENOENT").catch((err) => console.error(err));
  sessions.disconnectAll();
  await fs.rm(local, { recursive: true, force: true });
}
step("recursive delete removed the check folder");
console.log("SMB live check passed.");
process.exit(0);
