import { PassThrough, type Readable, Writable } from "node:stream";
import {
  SmbConnection,
  type SmbDirent,
  type SmbLike,
  isConnectivityError,
  normalizeSmbError,
  sharePath,
  smbConfigFromProfile,
} from "../src/main/services/smb/smb-client";
import { describe, expect, test } from "bun:test";
import type { ConnectProfile } from "../src/shared/sftp/sftp.types";
import { EventEmitter } from "node:events";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import { SmbEndpoint } from "../src/main/services/smb/smb-endpoint";
import { SmbService } from "../src/main/services/smb/smb.service";

function statusError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function smbLibraryError(statusName: string, name = "SmbError", message = statusName): Error {
  return Object.assign(new Error(message), { name, statusName, status: 1 });
}

class FakeSmb implements SmbLike {
  readonly dirs = new Set<string>(["Public"]);
  readonly files = new Map<string, Buffer>();
  readonly calls: string[] = [];

  private parent(path: string): string {
    return path.slice(0, path.lastIndexOf("/"));
  }

  private exists(path: string): boolean {
    return this.dirs.has(path) || this.files.has(path);
  }

  private children(path: string): string[] {
    return [...this.dirs, ...this.files.keys()].filter((child) => child.includes("/") && this.parent(child) === path);
  }

  async readdir(path: string): Promise<SmbDirent[]> {
    this.calls.push(`readdir ${path}`);
    if (!this.dirs.has(path)) throw statusError("ENOENT");
    return this.children(path).map((child) => {
      const isDir = this.dirs.has(child);
      return {
        name: child.slice(child.lastIndexOf("/") + 1),
        size: this.files.get(child)?.length ?? 0,
        mtime: new Date(1_700_000_000_000),
        isDirectory: () => isDir,
      };
    });
  }

  async stat(path: string): Promise<{ size: number; mtime: Date; isDirectory: boolean }> {
    if (!this.exists(path)) throw statusError("ENOENT");
    return { size: this.files.get(path)?.length ?? 0, mtime: new Date(1_700_000_000_000), isDirectory: this.dirs.has(path) };
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir ${path}`);
    if (this.exists(path)) throw statusError("EEXIST");
    if (!this.dirs.has(this.parent(path))) throw statusError("ENOENT");
    this.dirs.add(path);
  }

  async rmdir(path: string): Promise<void> {
    this.calls.push(`rmdir ${path}`);
    if (this.children(path).length > 0) throw statusError("ENOTEMPTY");
    this.dirs.delete(path);
  }

  async rm(path: string): Promise<void> {
    this.calls.push(`rm ${path}`);
    if (!this.files.delete(path)) throw statusError("ENOENT");
  }

  async rename(from: string, to: string, options?: { replace?: boolean }): Promise<void> {
    this.calls.push(`rename ${from} ${to}${options?.replace ? " replace" : ""}`);
    if (this.exists(to) && !options?.replace) throw statusError("EEXIST");
    const body = this.files.get(from);
    if (body === undefined) throw statusError("ENOENT");
    this.files.delete(from);
    this.files.set(to, body);
  }

  createReadStream(path: string): Readable {
    const stream = new PassThrough();
    const body = this.files.get(path);
    if (body === undefined) queueMicrotask(() => stream.destroy(statusError("ENOENT")));
    else stream.end(body);
    return stream;
  }

  createWriteStream(path: string): Writable {
    const chunks: Buffer[] = [];
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        chunks.push(chunk);
        callback();
      },
      final: (callback) => {
        this.files.set(path, Buffer.concat(chunks));
        callback();
      },
    });
  }

  async close(): Promise<void> {
    this.calls.push("close");
  }
}

function harness(): {
  fake: FakeSmb;
  connection: SmbConnection;
  socket: EventEmitter;
  failures: unknown[];
  sessions: SessionManager;
} {
  const fake = new FakeSmb();
  const socket = new EventEmitter();
  const connection = new SmbConnection(fake, "Public", socket);
  const failures: unknown[] = [];
  const sessions = {
    smbConnection: () => connection,
    noteSmbFailure: (_id: string, err: unknown) => failures.push(err),
  } as unknown as SessionManager;
  return { fake, connection, socket, failures, sessions };
}

function profile(overrides: Partial<ConnectProfile> = {}): ConnectProfile {
  return {
    protocol: "smb",
    host: "nas.local",
    port: 445,
    username: "pallet",
    auth: { method: "password", password: "secret" },
    smb: { share: "Public" },
    ...overrides,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
  return undefined;
}

describe("SMB paths and config", () => {
  test("pane paths map to share-prefixed library paths", () => {
    expect(sharePath("Public", "/")).toBe("Public");
    expect(sharePath("Public", "/a/b.txt")).toBe("Public/a/b.txt");
    expect(sharePath("Public", "//a/./c/../b/")).toBe("Public/a/b");
    expect(sharePath("Public", "/../../x")).toBe("Public/x");
    expect(code(() => sharePath("Public", "/a\\b"))).toBe("EINVAL");
  });

  test("config requires a share, a password, and a plain host", () => {
    expect(smbConfigFromProfile(profile({ smb: { share: "\\Public\\" } })).share).toBe("Public");
    expect(smbConfigFromProfile(profile({ port: 0 })).port).toBe(445);
    expect(code(() => smbConfigFromProfile(profile({ smb: { share: " " } })))).toBe("EINVAL");
    expect(code(() => smbConfigFromProfile(profile({ smb: { share: "a/b" } })))).toBe("EINVAL");
    expect(code(() => smbConfigFromProfile(profile({ host: "nas\\x" })))).toBe("EINVAL");
    expect(code(() => smbConfigFromProfile(profile({ auth: { method: "agent" } })))).toBe("EINVAL");
  });

  test("library errors become actionable errno codes", () => {
    const logon = normalizeSmbError(smbLibraryError("STATUS_LOGON_FAILURE", "SmbAuthError"));
    expect(logon.code).toBe("EAUTH");
    expect(logon.message).toContain("username, password, and domain");
    expect(normalizeSmbError(smbLibraryError("STATUS_BAD_NETWORK_NAME")).message).toContain("share was not found");
    expect(normalizeSmbError(smbLibraryError("STATUS_USER_SESSION_DELETED")).code).toBe("ECONNRESET");
    expect(normalizeSmbError(smbLibraryError("0x00000000", "SmbProtocolError", "connection closed")).code).toBe("ECONNRESET");
    expect(normalizeSmbError(smbLibraryError("STATUS_SOMETHING_ELSE")).code).toBe("STATUS_SOMETHING_ELSE");
    const passthrough = statusError("ENOENT");
    expect(normalizeSmbError(passthrough)).toBe(passthrough);
    expect(isConnectivityError(statusError("ECONNRESET"))).toBe(true);
    expect(isConnectivityError(statusError("EAUTH"))).toBe(false);
  });
});

describe("SmbConnection", () => {
  test("a request that never answers times out", async () => {
    const { connection } = harness();
    const pending = connection.run(() => new Promise<never>(() => {}), 10);
    await expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });

  test("a dropped socket fails in-flight requests and streams, then reports the drop", async () => {
    const { connection, socket } = harness();
    let dropped = false;
    connection.onClose(() => (dropped = true));
    const pending = connection.run(() => new Promise<never>(() => {}));
    const stream = connection.openWrite("/out.bin");
    const streamError = new Promise<Error>((resolve) => stream.once("error", resolve));
    socket.emit("close");
    await expect(pending).rejects.toMatchObject({ code: "ECONNRESET" });
    expect((await streamError).message).toBe("SMB connection lost");
    expect(dropped).toBe(true);
    await expect(connection.run((client) => client.stat("Public"))).rejects.toMatchObject({ code: "ENOTCONN" });
  });
});

describe("SmbService", () => {
  test("lists, stats, and previews files", async () => {
    const { fake, sessions } = harness();
    fake.dirs.add("Public/docs");
    fake.files.set("Public/docs/a.txt", Buffer.from("hello world"));
    const service = new SmbService(sessions);
    const listing = await service.list("s1", "/docs");
    expect(listing.entries.map((entry) => [entry.path, entry.kind, entry.size])).toEqual([["/docs/a.txt", "file", 11]]);
    expect((await service.stat("s1", "/")).kind).toBe("dir");
    expect((await service.stat("s1", "/docs")).kind).toBe("dir");
    expect((await service.readBytes("s1", "/docs/a.txt", 5)).toString()).toBe("hello");
    expect(await service.realpath("s1", "/docs/../docs")).toBe("/docs");
    await expect(service.stat("s1", "/missing")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rename refuses to overwrite and recursive delete empties folders first", async () => {
    const { fake, sessions, failures } = harness();
    fake.dirs.add("Public/d");
    fake.dirs.add("Public/d/e");
    fake.files.set("Public/d/e/f.txt", Buffer.from("x"));
    fake.files.set("Public/g.txt", Buffer.from("y"));
    const service = new SmbService(sessions);
    await expect(service.rename("s1", "/g.txt", "/d")).rejects.toMatchObject({ code: "EEXIST" });
    await service.removeRecursive("s1", "/d");
    expect(fake.dirs.has("Public/d")).toBe(false);
    expect(fake.calls.filter((call) => /^(rm|rmdir) /.test(call))).toEqual([
      "rm Public/d/e/f.txt",
      "rmdir Public/d/e",
      "rmdir Public/d",
    ]);
    expect(await service.folderSize("s1", "/")).toBe(1);
    expect(failures).toHaveLength(1);
    await expect(service.chmod()).rejects.toMatchObject({ code: "ENOTSUP" });
  });
});

describe("SmbEndpoint", () => {
  test("creates parents, writes, and replaces on rename", async () => {
    const { fake, sessions } = harness();
    fake.files.set("Public/dest/file.txt", Buffer.from("old"));
    fake.dirs.add("Public/dest");
    const endpoint = new SmbEndpoint(sessions, "s1");
    await endpoint.mkdirp("/dest/sub/deeper");
    expect(fake.dirs.has("Public/dest/sub/deeper")).toBe(true);
    await expect(endpoint.mkdirp("/dest/file.txt")).rejects.toMatchObject({ code: "EEXIST" });

    const writer = await endpoint.createWriteStream("/dest/file.txt.part");
    await new Promise<void>((resolve, reject) =>
      writer.end(Buffer.from("new"), (err?: Error | null) => (err ? reject(err) : resolve())),
    );
    await endpoint.renameReplacing("/dest/file.txt.part", "/dest/file.txt");
    expect(fake.files.get("Public/dest/file.txt")?.toString()).toBe("new");
    expect(fake.calls).toContain("rename Public/dest/file.txt.part Public/dest/file.txt replace");

    const reader = await endpoint.createReadStream("/dest/file.txt");
    const chunks: Buffer[] = [];
    for await (const chunk of reader) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("new");

    await expect(endpoint.createReadStream("/dest/file.txt", { start: 1 })).rejects.toMatchObject({ code: "ENOTSUP" });
    const bounded = await endpoint.createReadStream("/dest/file.txt", { start: 0, end: 1 });
    const boundedChunks: Buffer[] = [];
    for await (const chunk of bounded) boundedChunks.push(chunk as Buffer);
    expect(Buffer.concat(boundedChunks).toString()).toBe("ne");
    expect(await endpoint.statOrNull("/nope")).toBeNull();
    expect(await endpoint.listNames("/nope")).toEqual([]);
    await endpoint.removeFile("/nope");
    expect((await endpoint.listEntries("/dest")).map((entry) => [entry.name, entry.stat.isDir])).toEqual([
      ["sub", true],
      ["file.txt", false],
    ]);
  });

  test("an aborted read is destroyed", async () => {
    const { fake, sessions } = harness();
    fake.files.set("Public/a.bin", Buffer.alloc(4));
    const controller = new AbortController();
    const reader = await new SmbEndpoint(sessions, "s1").createReadStream("/a.bin", { signal: controller.signal });
    const failed = new Promise<Error>((resolve) => reader.once("error", resolve));
    controller.abort();
    expect((await failed).message).toBe("Transfer interrupted");
  });
});
