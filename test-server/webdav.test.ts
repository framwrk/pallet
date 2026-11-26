import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import {
  WebDavConnection,
  hrefFor,
  parseMultistatus,
  webdavConfigFromProfile,
} from "../src/main/services/webdav/webdav-client";
import { afterEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { ConnectProfile } from "../src/shared/sftp/sftp.types";
import { Readable } from "node:stream";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import { WebDavEndpoint } from "../src/main/services/webdav/webdav-endpoint";
import { WebDavService } from "../src/main/services/webdav/webdav.service";
import { pipeline } from "node:stream/promises";

const ROOT = "/dav/files/alice";
const AUTH = `Basic ${Buffer.from("alice:secret").toString("base64")}`;

/** Minimal in-memory WebDAV server, closer to Apache mod_dav than to a mock. */
class FakeDav {
  readonly dirs = new Set<string>([ROOT]);
  readonly files = new Map<string, { body: Buffer; mtime: number }>();
  readonly methods: string[] = [];
  putStatus: number | null = null;
  server: Server;
  port = 0;

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private key(url: string): string {
    const path = decodeURIComponent(new URL(url, "http://x").pathname);
    return path.length > 1 ? path.replace(/\/$/, "") : path;
  }

  private parent(path: string): string {
    return path.slice(0, path.lastIndexOf("/"));
  }

  private children(path: string): string[] {
    return [...this.dirs, ...this.files.keys()].filter((p) => p !== path && this.parent(p) === path);
  }

  private href(path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return this.dirs.has(path) ? `${encoded}/` : encoded;
  }

  private propXml(path: string, absolute: boolean): string {
    const file = this.files.get(path);
    const href = absolute ? `http://127.0.0.1:${this.port}${this.href(path)}` : this.href(path);
    const props = file
      ? `<lp1:resourcetype/><lp1:getcontentlength>${file.body.length}</lp1:getcontentlength>` +
        `<lp1:getlastmodified>${new Date(file.mtime).toUTCString()}</lp1:getlastmodified>`
      : "<lp1:resourcetype><D:collection/></lp1:resourcetype>";
    return (
      `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop>` +
      "<D:status>HTTP/1.1 200 OK</D:status></D:propstat>" +
      "<D:propstat><D:prop><D:quota-used-bytes/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>" +
      "</D:response>"
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const method = req.method ?? "";
    this.methods.push(method);
    const send = (status: number, text = ""): void => {
      res.writeHead(status, { "Content-Length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (req.headers.authorization !== AUTH) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="dav"', "Content-Length": 0 });
      res.end();
      return;
    }
    const path = this.key(req.url ?? "/");
    const exists = this.dirs.has(path) || this.files.has(path);
    if (method === "PROPFIND") {
      if (!exists) return send(404);
      const depth = req.headers.depth === "0" ? [] : this.dirs.has(path) ? this.children(path) : [];
      const xml =
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:lp1="DAV:">' +
        [path, ...depth].map((p, i) => this.propXml(p, i % 2 === 1)).join("") +
        "</D:multistatus>";
      res.writeHead(207, { "Content-Type": 'application/xml; charset="utf-8"' });
      res.end(xml);
      return;
    }
    if (method === "GET") {
      const file = this.files.get(path);
      if (!file) return send(404);
      const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
      if (range) {
        const slice = file.body.subarray(Number(range[1]), Number(range[2]) + 1);
        res.writeHead(206, { "Content-Length": slice.length });
        res.end(slice);
        return;
      }
      res.writeHead(200, { "Content-Length": file.body.length });
      res.end(file.body);
      return;
    }
    if (method === "PUT") {
      if (this.putStatus) return send(this.putStatus);
      if (!this.dirs.has(this.parent(path))) return send(409);
      this.files.set(path, { body, mtime: 1_700_000_000_000 });
      return send(201);
    }
    if (method === "MKCOL") {
      if (exists) return send(405);
      if (!this.dirs.has(this.parent(path))) return send(409);
      this.dirs.add(path);
      return send(201);
    }
    if (method === "DELETE") {
      if (!exists) return send(404);
      for (const p of [...this.dirs, ...this.files.keys()]) {
        if (p === path || p.startsWith(`${path}/`)) {
          this.dirs.delete(p);
          this.files.delete(p);
        }
      }
      return send(204);
    }
    if (method === "MOVE") {
      if (!exists) return send(404);
      const to = this.key(String(req.headers.destination));
      const replacing = this.dirs.has(to) || this.files.has(to);
      if (replacing && req.headers.overwrite === "F") return send(412);
      for (const p of [...this.dirs]) {
        if (p === path || p.startsWith(`${path}/`)) {
          this.dirs.delete(p);
          this.dirs.add(to + p.slice(path.length));
        }
      }
      for (const [p, file] of [...this.files]) {
        if (p === path || p.startsWith(`${path}/`)) {
          this.files.delete(p);
          this.files.set(to + p.slice(path.length), file);
        }
      }
      return send(replacing ? 204 : 201);
    }
    send(405);
  }
}

let dav: FakeDav | null = null;
let manager: SessionManager | null = null;

afterEach(async () => {
  manager?.disconnectAll();
  manager = null;
  await dav?.stop();
  dav = null;
});

function profile(port: number, overrides: Partial<ConnectProfile> = {}): ConnectProfile {
  return {
    protocol: "webdav",
    host: "127.0.0.1",
    port,
    username: "alice",
    auth: { method: "password", password: "secret" },
    webdav: { root: ROOT },
    ...overrides,
  };
}

async function connected(overrides: Partial<ConnectProfile> = {}): Promise<{
  fake: FakeDav;
  sessions: SessionManager;
  sessionId: string;
  initialPath: string;
}> {
  const fake = new FakeDav();
  await fake.start();
  dav = fake;
  const sessions = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
  manager = sessions;
  const { sessionId, initialPath } = await sessions.connect(profile(fake.port, overrides));
  return { fake, sessions, sessionId, initialPath };
}

describe("WebDAV paths and listings", () => {
  test("config takes the scheme from the protocol and keeps the server path decoded", () => {
    const config = webdavConfigFromProfile({
      ...profile(0),
      protocol: "webdavs",
      port: 0,
      webdav: { root: "/remote.php/dav/files/My%20Name/" },
    });
    expect(config).toMatchObject({ secure: true, port: 443, root: "/remote.php/dav/files/My Name" });
    expect(() => webdavConfigFromProfile({ ...profile(80), host: "https://cloud.example" })).toThrow(/without a scheme/);
  });

  test("request paths are percent-encoded per segment under the root", () => {
    expect(hrefFor("/dav/My Files", "/a#b/c d.txt")).toBe("/dav/My%20Files/a%23b/c%20d.txt");
    expect(hrefFor("", "/", true)).toBe("/");
    expect(hrefFor("/dav", "/", true)).toBe("/dav/");
  });

  test("multistatus parsing ignores namespace prefixes, failed propstats, and hrefs outside the root", () => {
    const xml =
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://h/dav/a%20b/</d:href><d:propstat><d:prop>' +
      "<d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" +
      "<d:response><d:href>/dav/a%20b/f.txt</d:href><d:propstat><d:prop><d:resourcetype/>" +
      "<d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Tue, 14 Nov 2023 22:13:20 GMT</d:getlastmodified>" +
      "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>" +
      "<d:response><d:href>/elsewhere/x</d:href></d:response></d:multistatus>";
    expect(parseMultistatus(xml, "/dav")).toEqual([
      { path: "/a b", isDir: true, size: 0, mtimeMs: 0 },
      { path: "/a b/f.txt", isDir: false, size: 12, mtimeMs: 1_700_000_000_000 },
    ]);
    expect(() => parseMultistatus("<html>login</html>", "")).toThrow(/WebDAV server/);
  });
});

describe("WebDAV sessions", () => {
  test("wrong credentials fail the connect with a sign-in error", async () => {
    const fake = new FakeDav();
    await fake.start();
    dav = fake;
    manager = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
    const err = await manager
      .connect(profile(fake.port, { auth: { method: "password", password: "nope" } }))
      .catch((e: unknown) => e as NodeJS.ErrnoException);
    expect(err).toMatchObject({ code: "EAUTH" });
  });

  test("browses, creates, renames, and deletes under the server path", async () => {
    const { fake, sessions, sessionId, initialPath } = await connected({ remotePath: "/missing" });
    expect(initialPath).toBe("/");
    const service = new WebDavService(sessions);
    await service.mkdir(sessionId, "/Photos 2024");
    fake.files.set(`${ROOT}/Photos 2024/a#1.txt`, { body: Buffer.from("hello world"), mtime: 1_700_000_000_000 });

    const listing = await service.list(sessionId, "/Photos 2024");
    expect(listing.entries.map((e) => [e.name, e.kind, e.size])).toEqual([["a#1.txt", "file", 11]]);
    expect((await service.stat(sessionId, "/Photos 2024")).kind).toBe("dir");
    expect((await service.readBytes(sessionId, "/Photos 2024/a#1.txt", 5)).toString()).toBe("hello");
    expect(await service.folderSize(sessionId, "/")).toBe(11);

    fake.files.set(`${ROOT}/taken.txt`, { body: Buffer.from("x"), mtime: 0 });
    await expect(service.rename(sessionId, "/Photos 2024/a#1.txt", "/taken.txt")).rejects.toMatchObject({
      code: "EEXIST",
    });
    await service.rename(sessionId, "/Photos 2024", "/Photos");
    expect(fake.files.has(`${ROOT}/Photos/a#1.txt`)).toBe(true);

    await service.removeRecursive(sessionId, "/Photos");
    expect(fake.dirs.has(`${ROOT}/Photos`)).toBe(false);
    await expect(service.removeRecursive(sessionId, "/")).rejects.toMatchObject({ code: "EINVAL" });
    await expect(service.chmod()).rejects.toMatchObject({ code: "ENOTSUP" });
  });

  test("the endpoint stages an upload, confirms it, and replaces the destination", async () => {
    const { fake, sessions, sessionId } = await connected();
    const endpoint = new WebDavEndpoint(sessions, sessionId);
    await endpoint.mkdirp("/a/b");
    expect(fake.dirs.has(`${ROOT}/a/b`)).toBe(true);
    fake.files.set(`${ROOT}/a/b/file.bin`, { body: Buffer.from("old"), mtime: 0 });

    const payload = Buffer.alloc(256 * 1024, 7);
    await pipeline(Readable.from([payload]), await endpoint.createWriteStream("/a/b/.file.bin.part"));
    await endpoint.renameReplacing("/a/b/.file.bin.part", "/a/b/file.bin");
    expect(fake.files.get(`${ROOT}/a/b/file.bin`)?.body.equals(payload)).toBe(true);
    expect(await endpoint.listNames("/a/b")).toEqual(["file.bin"]);

    const chunks: Buffer[] = [];
    for await (const chunk of await endpoint.createReadStream("/a/b/file.bin", { end: 9 })) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).length).toBe(10);
    await endpoint.removeFile("/a/b/file.bin");
    await endpoint.removeFile("/a/b/file.bin");
    expect(await endpoint.statOrNull("/a/b/file.bin")).toBeNull();
  });

  test("a rejected upload fails the write stream instead of finishing", async () => {
    const { fake, sessions, sessionId } = await connected();
    fake.putStatus = 507;
    const endpoint = new WebDavEndpoint(sessions, sessionId);
    const upload = pipeline(Readable.from([Buffer.from("data")]), await endpoint.createWriteStream("/x.part"));
    await expect(upload).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fake.files.size).toBe(0);
  });

  test("a request that never answers times out and closing fails what is in flight", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connection = new WebDavConnection(webdavConfigFromProfile(profile((server.address() as AddressInfo).port)));
    await expect(connection.request("PROPFIND", "/", { timeoutMs: 50 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    const pending = connection.request("PROPFIND", "/");
    await new Promise((resolve) => setTimeout(resolve, 20));
    connection.close();
    await expect(pending).rejects.toMatchObject({ code: "ENOTCONN" });
    await expect(connection.request("GET", "/")).rejects.toMatchObject({ code: "ENOTCONN" });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
