import {
  type ClientRequest,
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
} from "http";
import { Agent as HttpsAgent, request as httpsRequest } from "https";
import { type Readable, Writable } from "stream";
import type { ConnectProfile } from "@shared/sftp/sftp.types";
import { XMLParser } from "fast-xml-parser";

export const WEBDAV_DIR_MODE = 0o040755;
export const WEBDAV_FILE_MODE = 0o100644;
export const WEBDAV_REQUEST_TIMEOUT_MS = 20_000;
/** Streams idle while the other end of a transfer is slow, and servers may assemble large uploads before answering. */
export const WEBDAV_STREAM_TIMEOUT_MS = 120_000;

export interface ResolvedWebDavConfig {
  secure: boolean;
  host: string;
  port: number;
  /** Server path that the pane's "/" maps to; "" for the server root. */
  root: string;
  username: string;
  password: string;
  rejectUnauthorized: boolean;
}

export interface WebDavResource {
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface WebDavResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  body?: string;
  dir?: boolean;
  timeoutMs?: number;
}

export function webdavError(code: string, message: string, status?: number): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException & { status?: number } = new Error(message);
  err.code = code;
  if (status !== undefined) err.status = status;
  return err;
}

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function decodedPath(p: string): string {
  return normalizePath(p.split("/").map(decodeSegment).join("/"));
}

export function webdavConfigFromProfile(profile: ConnectProfile): ResolvedWebDavConfig {
  if (profile.auth.method !== "password") throw webdavError("EINVAL", "WebDAV requires password authentication");
  const secure = profile.protocol === "webdavs";
  const host = profile.host.trim();
  if (!host) throw webdavError("EINVAL", "WebDAV server is required");
  if (/[\\/\s]/.test(host)) throw webdavError("EINVAL", `Enter only the server name, without a scheme or path: ${host}`);
  const root = decodedPath(profile.webdav?.root ?? "/");
  return {
    secure,
    host,
    port: profile.port || (secure ? 443 : 80),
    root: root === "/" ? "" : root,
    username: profile.username,
    password: profile.auth.password,
    rejectUnauthorized: profile.tlsRejectUnauthorized !== false,
  };
}

/** Encoded request path for a pane path; collections get a trailing slash. */
export function hrefFor(root: string, p: string, dir = false): string {
  const full = `${root}${normalizePath(p) === "/" ? "" : normalizePath(p)}`;
  const encoded = full
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (!encoded) return "/";
  return dir ? `${encoded}/` : encoded;
}

/** Pane path for a multistatus href, or null when it lies outside the root. */
export function paneSubpath(root: string, href: string): string | null {
  let pathname = href;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) {
    try {
      pathname = new URL(href).pathname;
    } catch {
      return null;
    }
  }
  const path = decodedPath(pathname);
  if (!root) return path;
  if (path === root) return "/";
  if (!path.startsWith(`${root}/`)) return null;
  return path.slice(root.length);
}

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "response" || name === "propstat",
});

type XmlNode = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) return text((value as XmlNode)["#text"]);
  return "";
}

function okProps(response: XmlNode): XmlNode {
  const merged: XmlNode = {};
  for (const propstat of (response.propstat as XmlNode[] | undefined) ?? []) {
    if (!/\s2\d\d(\s|$)/.test(text(propstat.status))) continue;
    if (propstat.prop && typeof propstat.prop === "object") Object.assign(merged, propstat.prop);
  }
  return merged;
}

export function parseMultistatus(xml: string, root: string): WebDavResource[] {
  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch {
    throw webdavError("EPROTO", "The WebDAV server sent an unreadable folder listing");
  }
  const multistatus = doc.multistatus as XmlNode | undefined;
  if (!multistatus || typeof multistatus !== "object") {
    throw webdavError("EPROTO", "The server did not answer like a WebDAV server");
  }
  const resources: WebDavResource[] = [];
  for (const response of (multistatus.response as XmlNode[] | undefined) ?? []) {
    const path = paneSubpath(root, text(response.href));
    if (path === null) continue;
    const props = okProps(response);
    const resourcetype = props.resourcetype;
    const isDir = !!resourcetype && typeof resourcetype === "object" && "collection" in resourcetype;
    const size = Number.parseInt(text(props.getcontentlength), 10);
    const mtimeMs = Date.parse(text(props.getlastmodified));
    resources.push({
      path,
      isDir,
      size: isDir || !Number.isFinite(size) ? 0 : size,
      mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
    });
  }
  return resources;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>";

export function statusError(status: number, headers: IncomingHttpHeaders, what: string): NodeJS.ErrnoException {
  if (status === 401) {
    const challenge = String(headers["www-authenticate"] ?? "");
    if (challenge && !/basic/i.test(challenge)) {
      return webdavError("EAUTH", "The WebDAV server requires a sign-in method Pallet does not support yet", status);
    }
    return webdavError("EAUTH", "WebDAV sign-in failed. Check the username and password.", status);
  }
  if (status === 403) return webdavError("EACCES", `Permission denied: ${what}`, status);
  if (status === 404 || status === 410) return webdavError("ENOENT", `Not found: ${what}`, status);
  if (status === 409) return webdavError("ENOENT", `The parent folder does not exist: ${what}`, status);
  if (status === 412) return webdavError("EEXIST", `Already exists: ${what}`, status);
  if (status === 423) return webdavError("EBUSY", `Locked on the server: ${what}`, status);
  if (status === 507) return webdavError("ENOSPC", "The WebDAV server is out of storage space", status);
  if (status >= 300 && status < 400) {
    return webdavError("EPROTO", `The server redirected the request (HTTP ${status}). Check the server path.`, status);
  }
  return webdavError("EIO", `WebDAV request failed (HTTP ${status}): ${what}`, status);
}

const CONNECTIVITY_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTCONN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
]);

export function isConnectivityError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && CONNECTIVITY_CODES.has(code);
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * One WebDAV server scoped to a root path. HTTP has no session to watch, so
 * every request gets a socket timeout, and close() fails whatever is in flight.
 */
export class WebDavConnection {
  private agent: HttpAgent;
  private inflight = new Set<ClientRequest>();
  closed = false;

  constructor(readonly config: ResolvedWebDavConfig) {
    this.agent = config.secure
      ? new HttpsAgent({ keepAlive: true, rejectUnauthorized: config.rejectUnauthorized })
      : new HttpAgent({ keepAlive: true });
  }

  private origin(): string {
    const host = this.config.host.includes(":") ? `[${this.config.host}]` : this.config.host;
    const standard = this.config.port === (this.config.secure ? 443 : 80);
    return `${this.config.secure ? "https" : "http"}://${host}${standard ? "" : `:${this.config.port}`}`;
  }

  /** Absolute URL, as the MOVE Destination header requires. */
  url(p: string, dir = false): string {
    return `${this.origin()}${hrefFor(this.config.root, p, dir)}`;
  }

  private open(method: string, p: string, options: RequestOptions): ClientRequest {
    if (this.closed) throw webdavError("ENOTCONN", "Not connected");
    const auth = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
    const request = (this.config.secure ? httpsRequest : httpRequest)({
      host: this.config.host,
      port: this.config.port,
      method,
      path: hrefFor(this.config.root, p, options.dir),
      agent: this.agent,
      headers: { Authorization: `Basic ${auth}`, ...options.headers },
    });
    request.on("error", () => {});
    this.inflight.add(request);
    request.once("close", () => this.inflight.delete(request));
    request.setTimeout(options.timeoutMs ?? WEBDAV_REQUEST_TIMEOUT_MS, () => {
      request.destroy(webdavError("ETIMEDOUT", "WebDAV request timed out"));
    });
    return request;
  }

  private response(request: ClientRequest): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    });
  }

  async request(method: string, p: string, options: RequestOptions = {}): Promise<WebDavResponse> {
    const request = this.open(method, p, {
      ...options,
      headers: {
        ...(options.body !== undefined
          ? { "Content-Type": "application/xml; charset=utf-8", "Content-Length": String(Buffer.byteLength(options.body)) }
          : {}),
        ...options.headers,
      },
    });
    const responded = this.response(request);
    request.end(options.body);
    const response = await responded;
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    return { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) };
  }

  async propfind(p: string, depth: 0 | 1, dir = false): Promise<WebDavResource[]> {
    let response = await this.request("PROPFIND", p, { headers: { Depth: String(depth) }, body: PROPFIND_BODY, dir });
    if (!dir && (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308)) {
      response = await this.request("PROPFIND", p, { headers: { Depth: String(depth) }, body: PROPFIND_BODY, dir: true });
    }
    if (response.status !== 207) throw statusError(response.status, response.headers, normalizePath(p));
    return parseMultistatus(response.body.toString("utf8"), this.config.root);
  }

  /** Expects an ok status and drains the body; maps anything else to an errno-style error. */
  async expectOk(method: string, p: string, options: RequestOptions = {}): Promise<void> {
    const response = await this.request(method, p, options);
    if (!isOk(response.status)) throw statusError(response.status, response.headers, normalizePath(p));
  }

  async openRead(p: string, range?: { end: number }): Promise<Readable> {
    const request = this.open("GET", p, {
      headers: range ? { Range: `bytes=0-${range.end}` } : {},
      timeoutMs: WEBDAV_STREAM_TIMEOUT_MS,
    });
    const responded = this.response(request);
    request.end();
    const response = await responded;
    const status = response.statusCode ?? 0;
    if (status !== 200 && status !== 206) {
      response.resume();
      throw statusError(status, response.headers, normalizePath(p));
    }
    return response;
  }

  /** PUT stream; it finishes only after the server confirms the upload. */
  openWrite(p: string): Writable {
    const request = this.open("PUT", p, {
      headers: { "Content-Type": "application/octet-stream" },
      timeoutMs: WEBDAV_STREAM_TIMEOUT_MS,
    });
    const responded = this.response(request);
    const path = normalizePath(p);
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (request.write(chunk)) callback();
        else request.once("drain", () => callback());
      },
      final(callback) {
        request.end();
        responded.then(
          (response) => {
            response.resume();
            const status = response.statusCode ?? 0;
            callback(isOk(status) ? null : statusError(status, response.headers, path));
          },
          (err: Error) => callback(err),
        );
      },
      destroy(err, callback) {
        if (err || !request.writableFinished) request.destroy();
        callback(err);
      },
    });
    responded.then(
      (response) => {
        const status = response.statusCode ?? 0;
        if (!isOk(status) && !stream.writableFinished) stream.destroy(statusError(status, response.headers, path));
      },
      (err: Error) => stream.destroy(err),
    );
    return stream;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of [...this.inflight]) request.destroy(webdavError("ENOTCONN", "Disconnected"));
    this.agent.destroy();
  }
}

export async function openWebDavConnection(profile: ConnectProfile): Promise<WebDavConnection> {
  const connection = new WebDavConnection(webdavConfigFromProfile(profile));
  try {
    const [root] = await connection.propfind("/", 0, true);
    if (root && !root.isDir) throw webdavError("ENOTDIR", "The WebDAV server path is a file, not a folder");
    return connection;
  } catch (err) {
    connection.close();
    throw err;
  }
}
