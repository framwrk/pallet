/**
 * Edit sessions poll the local copy and re-upload through a staging file. These
 * tests use a fake endpoint and a slow in-place writer to prove that only the
 * settled content is uploaded, that a stalled channel times out instead of
 * wedging `uploading`, and that close/disconnect removes the temp directory.
 */
import type { EditEvent, EditSessions as EditSessionsClass } from "../src/main/services/edit-sessions";
import {
  type EndpointStat,
  type TransferEndpoint,
  type TransferWriteStream,
} from "../src/main/services/transfer/transfer-endpoint";
import { Readable, Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { PART_SUFFIX } from "../src/shared/transfer/transfer.constants";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import { tmpdir } from "node:os";

const REMOTE = "/remote/notes.txt";
const tempRoot = mkdtempSync(join(tmpdir(), "pallet-edits-"));

class FakeEndpoint implements TransferEndpoint {
  kind = "sftp" as const;
  files = new Map<string, Buffer>();
  parts = new Map<string, Buffer>();
  uploads: Buffer[] = [];
  removed: string[] = [];
  disposed = false;
  stallNextWrite = false;
  writeStarts = 0;
  onUpload: ((data: Buffer) => void) | null = null;

  async statOrNull(p: string): Promise<EndpointStat | null> {
    const data = this.files.get(p);
    if (!data) return null;
    return { size: data.length, mtimeMs: 0, mode: 0o100644, isDir: false, isSymlink: false };
  }

  async listNames(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async listEntries(): Promise<{ name: string; stat: EndpointStat }[]> {
    return [];
  }

  async mkdirp(): Promise<void> {
    // The fake remote has no directories.
  }

  async createReadStream(p: string): Promise<Readable> {
    const data = this.files.get(p);
    if (!data) throw new Error(`Missing remote file: ${p}`);
    return Readable.from([data]);
  }

  async createWriteStream(p: string): Promise<TransferWriteStream> {
    this.writeStarts += 1;
    if (this.stallNextWrite) {
      this.stallNextWrite = false;
      // A dead channel: the write callback is never called.
      return new Writable({
        write() {
          // Deliberately never calls back.
        },
      }) as TransferWriteStream;
    }
    const chunks: Buffer[] = [];
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        const data = Buffer.concat(chunks);
        this.parts.set(p, data);
        this.uploads.push(data);
        this.onUpload?.(data);
        callback();
      },
    }) as TransferWriteStream;
  }

  async setMeta(): Promise<void> {
    // The fake endpoint keeps no metadata.
  }

  async renameReplacing(from: string, to: string): Promise<void> {
    const data = this.parts.get(from);
    if (!data) throw new Error(`Missing staged file: ${from}`);
    this.parts.delete(from);
    this.files.set(to, data);
  }

  async removeFile(p: string): Promise<void> {
    this.removed.push(p);
    this.parts.delete(p);
  }

  dispose(): void {
    this.disposed = true;
  }
}

let endpoint: FakeEndpoint;
let events: EditEvent[];
let editSessions: EditSessionsClass;
let EditSessions: typeof EditSessionsClass;
let onOpen: ((localPath: string) => void) | null;

mock.module("electron", () => ({
  app: { getPath: () => tempRoot },
  shell: {
    openPath: async (localPath: string) => {
      onOpen?.(localPath);
      return "";
    },
  },
}));
mock.module("../src/main/services/transfer/transfer-endpoint", () => ({
  makeEndpoint: () => endpoint,
}));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await delay(10);
  }
}

beforeAll(async () => {
  ({ EditSessions } = await import("../src/main/services/edit-sessions"));
});

beforeEach(() => {
  endpoint = new FakeEndpoint();
  endpoint.files.set(REMOTE, Buffer.from("original"));
  events = [];
  onOpen = null;
  editSessions = new EditSessions({} as SessionManager, (event) => events.push(event), {
    saveDebounceMs: 250,
    pollIntervalMs: 20,
    uploadTimeoutMs: 300,
  });
});

afterEach(async () => {
  await editSessions.closeAll();
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  mock.restore();
});

test("uploads saves made immediately as the external editor opens", async () => {
  const count = 50;
  onOpen = (localPath) => writeFileSync(localPath, "immediate edit");

  for (let i = 0; i < count; i++) await editSessions.open(`s${i}`, REMOTE);

  await waitFor(() => events.length === count);
  expect(endpoint.uploads.map((data) => data.toString())).toEqual(Array<string>(count).fill("immediate edit"));
  expect(events).toHaveLength(count);
  expect(events.every((event) => event.kind === "uploaded")).toBe(true);
});

test("an unchanged file is not uploaded after opening", async () => {
  await editSessions.open("s1", REMOTE);

  await delay(400);
  expect(endpoint.writeStarts).toBe(0);
  expect(events).toEqual([]);
});

test("polling continues after an editor removes and replaces the local file", async () => {
  const localPath = await editSessions.open("s1", REMOTE);
  const replacement = `${localPath}.new`;
  writeFileSync(replacement, "replacement content");
  rmSync(localPath);
  await delay(60);
  renameSync(replacement, localPath);

  await waitFor(() => events.some((event) => event.kind === "uploaded"));
  expect(endpoint.files.get(REMOTE)?.toString()).toBe("replacement content");
  expect(endpoint.uploads.map((data) => data.toString())).toEqual(["replacement content"]);
  expect(events).toHaveLength(1);
});

test("waits for a slow in-place writer and uploads only the final content", async () => {
  const localPath = await editSessions.open("s1", REMOTE);
  const uploaded: string[] = [];
  let finalWritten = false;
  endpoint.onUpload = (data) => {
    expect(finalWritten).toBe(true);
    uploaded.push(data.toString());
  };

  writeFileSync(localPath, "partial");
  await delay(80);
  writeFileSync(localPath, "final stable content");
  finalWritten = true;

  await waitFor(() => uploaded.length > 0);
  await delay(350);
  expect(uploaded).toEqual(["final stable content"]);
  expect(endpoint.files.get(REMOTE)?.toString()).toBe("final stable content");
});

test("close removes the temp directory and cancels a pending upload", async () => {
  const localPath = await editSessions.open("s1", REMOTE);
  const tempDir = dirname(localPath);
  const uploaded: string[] = [];
  endpoint.onUpload = (data) => uploaded.push(data.toString());

  writeFileSync(localPath, "pending change");
  await delay(60);
  await editSessions.close(localPath);

  expect(existsSync(tempDir)).toBe(false);
  expect(endpoint.disposed).toBe(true);
  await delay(400);
  expect(uploaded).toEqual([]);
});

test("disconnect closes the session and stops uploads", async () => {
  const localPath = await editSessions.open("s1", REMOTE);
  const tempDir = dirname(localPath);
  const uploaded: string[] = [];
  endpoint.onUpload = (data) => uploaded.push(data.toString());

  writeFileSync(localPath, "change before disconnect");
  await delay(60);
  await editSessions.closeSession("s1");

  expect(existsSync(tempDir)).toBe(false);
  await delay(400);
  expect(uploaded).toEqual([]);
});

test("close aborts an in-flight upload", async () => {
  const localPath = await editSessions.open("s1", REMOTE);
  const tempDir = dirname(localPath);
  endpoint.stallNextWrite = true;

  writeFileSync(localPath, "stalled content");
  await waitFor(() => endpoint.writeStarts === 1);
  await editSessions.close(localPath);

  await delay(400);
  expect(endpoint.uploads).toEqual([]);
  expect(events).toEqual([]);
  expect(existsSync(tempDir)).toBe(false);
});

test("a stalled upload times out, cleans up its part, and allows the next save", async () => {
  const localPath = await editSessions.open("s1", REMOTE);
  endpoint.stallNextWrite = true;

  writeFileSync(localPath, "stalled content");
  await waitFor(() => events.some((event) => event.kind === "error"));

  expect(events.find((event) => event.kind === "error")?.message).toContain("timed out");
  expect(endpoint.removed).toHaveLength(1);
  expect(endpoint.removed[0]).toMatch(/^\/remote\/\.pallet-.+\.pallet-part$/);
  expect(endpoint.uploads).toEqual([]);

  writeFileSync(localPath, "recovered content");
  await waitFor(() => endpoint.uploads.length === 1);
  expect(endpoint.uploads[0]?.toString()).toBe("recovered content");
});

test("closeAll removes every session's temp directory", async () => {
  const first = await editSessions.open("s1", REMOTE);
  endpoint.files.set("/remote/other.txt", Buffer.from("other"));
  const second = await editSessions.open("s2", "/remote/other.txt");

  await editSessions.closeAll();

  expect(existsSync(dirname(first))).toBe(false);
  expect(existsSync(dirname(second))).toBe(false);
});

test("a missing remote file leaves no local temp directory or endpoint", async () => {
  const before = readdirSync(join(tempRoot, "pallet-edits"));
  await expect(editSessions.open("s1", "/remote/missing.txt")).rejects.toThrow("Remote file not found");
  expect(readdirSync(join(tempRoot, "pallet-edits"))).toEqual(before);
  expect(endpoint.disposed).toBe(true);
});

test("a failed download leaves no local temp directory or endpoint", async () => {
  const before = readdirSync(join(tempRoot, "pallet-edits"));
  endpoint.createReadStream = async () =>
    Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("Download interrupted");
      })(),
    );
  await expect(editSessions.open("s1", REMOTE)).rejects.toThrow("Download interrupted");
  expect(readdirSync(join(tempRoot, "pallet-edits"))).toEqual(before);
  expect(endpoint.disposed).toBe(true);
});

test("saving an edit preserves an unrelated .pallet-part file", async () => {
  const foreignPart = `${REMOTE}${PART_SUFFIX}`;
  endpoint.parts.set(foreignPart, Buffer.from("unrelated content"));
  const localPath = await editSessions.open("s1", REMOTE);
  writeFileSync(localPath, "saved edit");
  await waitFor(() => events.some((event) => event.kind === "uploaded"));

  expect(endpoint.files.get(REMOTE)?.toString()).toBe("saved edit");
  expect(endpoint.parts.get(foreignPart)?.toString()).toBe("unrelated content");
});
