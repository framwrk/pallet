import type { Readable, Writable } from "stream";
import { Client } from "smb3-client";
import type { ConnectProfile } from "@shared/sftp/sftp.types";
import type { EventEmitter } from "events";

export const SMB_DIR_MODE = 0o040755;
export const SMB_FILE_MODE = 0o100644;
export const SMB_REQUEST_TIMEOUT_MS = 20_000;

export interface SmbStats {
  size: number;
  mtime: Date;
  isDirectory(): boolean;
}

export interface SmbDirent extends SmbStats {
  name: string;
}

/** The smb3-client surface Pallet uses; paths are "share/rest/of/path". */
export interface SmbLike {
  readdir(path: string, options: { withFileTypes: true }): Promise<SmbDirent[]>;
  stat(path: string): Promise<{ size: number; mtime: Date; isDirectory: boolean }>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  rename(from: string, to: string, options?: { replace?: boolean }): Promise<void>;
  createReadStream(path: string): Readable;
  createWriteStream(path: string): Writable;
  close(): Promise<void>;
}

export interface ResolvedSmbConfig {
  host: string;
  port: number;
  share: string;
  domain: string;
  username: string;
  password: string;
}

export function smbError(code: string, message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  return err;
}

export function smbConfigFromProfile(profile: ConnectProfile): ResolvedSmbConfig {
  if (profile.auth.method !== "password") throw smbError("EINVAL", "SMB requires password authentication");
  const host = profile.host.trim();
  const share = profile.smb?.share.trim().replace(/^[\\/]+|[\\/]+$/g, "") ?? "";
  if (!host) throw smbError("EINVAL", "SMB server is required");
  if (/[\\/\s]/.test(host)) throw smbError("EINVAL", `Invalid SMB server: ${host}`);
  if (!share) throw smbError("EINVAL", "SMB share is required");
  if (/[\\/]/.test(share)) throw smbError("EINVAL", "Enter only the share name, without slashes");
  return {
    host,
    port: profile.port || 445,
    share,
    domain: profile.smb?.domain?.trim() ?? "",
    username: profile.username.trim(),
    password: profile.auth.password,
  };
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

/** Library path for a pane path: "/a/b" in share "Public" becomes "Public/a/b". */
export function sharePath(share: string, p: string): string {
  const normalized = normalizePath(p);
  if (normalized.includes("\\")) throw smbError("EINVAL", `SMB names cannot contain a backslash: ${p}`);
  return `${share}${normalized === "/" ? "" : normalized}`;
}

const STATUS_ERRORS: Record<string, { code: string; message: string }> = {
  STATUS_LOGON_FAILURE: { code: "EAUTH", message: "SMB sign-in failed. Check the username, password, and domain." },
  STATUS_ACCOUNT_DISABLED: { code: "EAUTH", message: "The SMB account is disabled" },
  STATUS_ACCOUNT_RESTRICTION: { code: "EAUTH", message: "The SMB account is not allowed to sign in" },
  STATUS_PASSWORD_EXPIRED: { code: "EAUTH", message: "The SMB account password has expired" },
  STATUS_BAD_NETWORK_NAME: { code: "ENOENT", message: "The SMB share was not found on the server" },
  STATUS_SHARING_VIOLATION: { code: "EBUSY", message: "The file is open in another program on the server" },
  STATUS_NETWORK_NAME_DELETED: { code: "ECONNRESET", message: "The SMB share connection was lost" },
  STATUS_USER_SESSION_DELETED: { code: "ECONNRESET", message: "The SMB session ended" },
  STATUS_NETWORK_SESSION_EXPIRED: { code: "ECONNRESET", message: "The SMB session expired" },
};

export function normalizeSmbError(err: unknown): NodeJS.ErrnoException {
  const e = (err instanceof Error ? err : new Error(String(err))) as NodeJS.ErrnoException & { statusName?: string };
  if (e.statusName === undefined) return e;
  const mapped = STATUS_ERRORS[e.statusName];
  if (mapped) return Object.assign(new Error(mapped.message), { code: mapped.code, statusName: e.statusName });
  if (e.name === "SmbProtocolError" && /connection closed/i.test(e.message)) {
    return Object.assign(new Error("SMB connection lost"), { code: "ECONNRESET" });
  }
  if (e.name === "SmbAuthError") return Object.assign(new Error(`SMB sign-in failed: ${e.message}`), { code: "EAUTH" });
  if (!e.code) e.code = e.statusName;
  return e;
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

/**
 * One SMB session to one share. smb3-client has no request timeout, so every
 * request here gets one, and a dropped connection fails whatever is in flight.
 */
export class SmbConnection {
  private pending = new Set<(err: Error) => void>();
  private streams = new Set<Readable | Writable>();
  private closeListeners: (() => void)[] = [];
  closed = false;

  constructor(
    private client: SmbLike,
    readonly share: string,
    transport?: EventEmitter,
  ) {
    transport?.on("error", () => {});
    transport?.once("close", () => this.markClosed(smbError("ECONNRESET", "SMB connection lost")));
  }

  path(p: string): string {
    return sharePath(this.share, p);
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  run<T>(fn: (client: SmbLike) => Promise<T>, timeoutMs = SMB_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(smbError("ENOTCONN", "Not connected"));
    return new Promise<T>((resolve, reject) => {
      const fail = (err: Error): void => {
        settle();
        reject(err);
      };
      const timer = setTimeout(() => fail(smbError("ETIMEDOUT", "SMB request timed out")), timeoutMs);
      const settle = (): void => {
        clearTimeout(timer);
        this.pending.delete(fail);
      };
      this.pending.add(fail);
      Promise.resolve()
        .then(() => fn(this.client))
        .then(
          (value) => {
            settle();
            resolve(value);
          },
          (err) => fail(normalizeSmbError(err)),
        );
    });
  }

  openRead(p: string): Readable {
    return this.track(this.client.createReadStream(this.path(p)));
  }

  openWrite(p: string): Writable {
    return this.track(this.client.createWriteStream(this.path(p)));
  }

  private track<S extends Readable | Writable>(stream: S): S {
    if (this.closed) {
      stream.destroy(smbError("ENOTCONN", "Not connected"));
      return stream;
    }
    this.streams.add(stream);
    stream.once("close", () => this.streams.delete(stream));
    return stream;
  }

  close(): void {
    if (this.closed) return;
    this.markClosed(smbError("ENOTCONN", "Disconnected"));
    void this.client.close().catch(() => {});
  }

  private markClosed(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const fail of [...this.pending]) fail(err);
    for (const stream of [...this.streams]) stream.destroy(err);
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}

export async function openSmbConnection(profile: ConnectProfile): Promise<SmbConnection> {
  const config = smbConfigFromProfile(profile);
  const client = new Client({
    host: config.host,
    port: config.port,
    domain: config.domain,
    username: config.username,
    password: config.password,
    connectTimeout: SMB_REQUEST_TIMEOUT_MS,
  });
  let connection: SmbConnection | null = null;
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(smbError("ETIMEDOUT", "SMB connection timed out")), SMB_REQUEST_TIMEOUT_MS);
    client.connect().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        reject(normalizeSmbError(err));
      },
    );
  });
  try {
    await connected;
    const transport = (client as unknown as { conn?: EventEmitter }).conn;
    connection = new SmbConnection(client as unknown as SmbLike, config.share, transport);
    await connection.run((smb) => smb.readdir(config.share, { withFileTypes: true }));
    return connection;
  } catch (err) {
    if (connection) connection.close();
    else void client.close().catch(() => {});
    throw err;
  }
}
