import { type BaseAgent, type ConnectConfig, type SFTPWrapper, Client as SshClient, createAgent } from "ssh2";
import type {
  ConnectProfile,
  ConnectResult,
  ConnectionProtocol,
  SessionStatus,
  SessionStatusEvent,
} from "@shared/sftp/sftp.types";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "@shared/prefs/prefs.constants";
import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { type S3Like, type S3Target } from "../s3/s3-ops";
import {
  type SmbConnection,
  isConnectivityError as isSmbConnectivityError,
  normalizePath as normalizeSmbPath,
  openSmbConnection,
} from "../smb/smb-client";
import {
  type WebDavConnection,
  isConnectivityError as isWebDavConnectivityError,
  normalizePath as normalizeWebDavPath,
  openWebDavConnection,
} from "../webdav/webdav-client";
import {
  createS3Client,
  credentialsFromProfile,
  isConnectivityError,
  normalizeS3Error,
  s3ConfigFromProfile,
} from "../s3/s3-client";
import { ftpTlsMode, isWebDav } from "@shared/sftp/sftp.utils";
import { locationFor, prefixForPath } from "../s3/s3-path";
import { Client as FtpClient } from "basic-ftp";
import { createHash } from "crypto";
import { promises as fs } from "fs";

export interface HostKeyDecisionInput {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

export interface SessionManagerHooks {
  /** Resolve true to trust the presented host key. */
  verifyHostKey(input: HostKeyDecisionInput): Promise<boolean>;
  onStatus(event: SessionStatusEvent): void;
}

export interface SessionManagerOptions {
  /** Reconnect dropped sessions with backoff instead of disconnecting. */
  autoReconnect?: boolean;
}

interface ChannelPool {
  free: SFTPWrapper[];
  total: number;
  waiters: { resolve: (sftp: SFTPWrapper) => void; reject: (err: Error) => void }[];
}

interface FtpPool {
  free: FtpClient[];
  total: number;
  waiters: { resolve: (client: FtpClient) => void; reject: (err: Error) => void }[];
}

interface Session {
  id: string;
  profile: ConnectProfile;
  generation: number;
  client: SshClient | null;
  ftp: FtpClient | null;
  s3: S3Client | null;
  s3Target: S3Target | null;
  smb: SmbConnection | null;
  webdav: WebDavConnection | null;
  sftp: SFTPWrapper | null;
  pool: ChannelPool;
  ftpPool: FtpPool;
  status: SessionStatus;
  closing: boolean;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  dropNotified: boolean;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

function boundedAcquire<T>(pending: Promise<T>, discard: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(Object.assign(new Error("Transfer connection timed out"), { code: "ETIMEDOUT" }));
    }, 20_000);
    pending.then(
      (value) => {
        clearTimeout(timer);
        if (expired) discard(value);
        else resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function onceRelease(fn: (broken: boolean) => void): (broken?: boolean) => void {
  let released = false;
  return (broken = false) => {
    if (!released) {
      released = true;
      fn(broken);
    }
  };
}

export function parseKeyType(keyBlob: Buffer): string {
  try {
    const len = keyBlob.readUInt32BE(0);
    return keyBlob.subarray(4, 4 + len).toString("ascii");
  } catch {
    return "unknown";
  }
}

export function protocolOf(profile: ConnectProfile): ConnectionProtocol {
  if (
    profile.protocol === "ftp" ||
    profile.protocol === "ftps" ||
    profile.protocol === "ftps-implicit" ||
    profile.protocol === "s3" ||
    profile.protocol === "smb" ||
    profile.protocol === "webdav" ||
    profile.protocol === "webdavs"
  ) {
    return profile.protocol;
  }
  return "sftp";
}

function poolSizeFor(profile: ConnectProfile): number {
  const requested = profile.concurrency ?? DEFAULT_CONCURRENCY;
  const streams = Number.isFinite(requested)
    ? Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(requested)))
    : DEFAULT_CONCURRENCY;
  return streams + 1;
}

export function fingerprintOf(keyBlob: Buffer): string {
  return "SHA256:" + createHash("sha256").update(keyBlob).digest("base64").replace(/=+$/, "");
}

/**
 * ssh2 reports exhausted credentials as "All configured authentication
 * methods failed", which reads like an internal fault rather than a failed
 * connection attempt. Keep the error code, replace the wording.
 */
function connectionError(err: Error): Error {
  if (!err.message.includes("All configured authentication methods failed")) return err;
  return Object.assign(new Error("The connection isn't reachable"), {
    code: (err as NodeJS.ErrnoException).code,
  });
}

async function resolveSshAgent(): Promise<BaseAgent> {
  const socketPath = process.env.SSH_AUTH_SOCK;
  if (!socketPath?.trim()) {
    const err: NodeJS.ErrnoException = new Error("SSH agent authentication is unavailable: SSH_AUTH_SOCK is not set");
    err.code = "ENOAGENT";
    throw err;
  }
  const agent = createAgent(socketPath);
  const keys = await new Promise<unknown[]>((resolve, reject) => {
    agent.getIdentities((error, identities) => {
      if (error) {
        const err: NodeJS.ErrnoException = new Error(`Unable to connect to the SSH agent at ${socketPath}: ${error.message}`);
        err.code = "ENOAGENT";
        reject(err);
        return;
      }
      resolve(identities ?? []);
    });
  });
  if (keys.length === 0) {
    const err: NodeJS.ErrnoException = new Error(
      `The SSH agent at ${socketPath} has no usable keys. Add a key to the agent and try again.`,
    );
    err.code = "ENOAGENT";
    throw err;
  }
  return agent;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private seq = 0;
  private attempts = new Map<string, () => void>();

  constructor(
    private hooks: SessionManagerHooks,
    private getOptions: () => SessionManagerOptions = () => ({}),
  ) {}

  private setStatus(session: Session, status: SessionStatus, detail?: string): void {
    session.status = status;
    this.hooks.onStatus({ sessionId: session.id, status, detail });
  }

  private async buildConnectConfig(profile: ConnectProfile): Promise<Parameters<SshClient["connect"]>[0]> {
    const base: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      keepaliveInterval: profile.keepaliveIntervalMs ?? 15000,
      keepaliveCountMax: 3,
      readyTimeout: 20000,
      // ssh2 offers compression only when asked; 'none' stays in the list so a
      // server that refuses zlib can still complete the handshake.
      ...(profile.compression ? { algorithms: { compress: ["zlib@openssh.com", "zlib", "none"] } } : {}),
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
        this.hooks
          .verifyHostKey({
            host: profile.host,
            port: profile.port,
            keyType: parseKeyType(key),
            fingerprint: fingerprintOf(key),
          })
          .then(verify, () => verify(false));
      },
    };
    if (profile.auth.method === "password") {
      return { ...base, password: profile.auth.password };
    }
    if (profile.auth.method === "agent") {
      return { ...base, agent: await resolveSshAgent() };
    }
    if (profile.auth.method !== "key") {
      throw new Error("S3 sessions do not use SSH authentication");
    }
    const privateKey = await fs.readFile(profile.auth.keyPath);
    return {
      ...base,
      privateKey,
      ...(profile.auth.passphrase ? { passphrase: profile.auth.passphrase } : {}),
    };
  }

  /**
   * Dial a second, independent SSH connection for an interactive terminal.
   * The returned client is not tracked here; TerminalSessions owns its
   * lifetime. Credentials stay in the main process either way.
   */
  async openTerminalClient(sessionId: string): Promise<SshClient> {
    const session = this.mustGet(sessionId);
    if (protocolOf(session.profile) !== "sftp") {
      const err: NodeJS.ErrnoException = new Error("Terminal is available for SFTP connections only");
      err.code = "ENOTSSH";
      throw err;
    }
    if (session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    const config = await this.buildConnectConfig(session.profile);
    const client = new SshClient();
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        cleanup();
        reject(connectionError(err));
      };
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        client.removeListener("ready", onReady);
        client.removeListener("error", onError);
      };
      client.once("ready", onReady);
      client.once("error", onError);
      client.connect(config);
    });
    // Post-handshake errors must not become uncaught exceptions.
    client.on("error", () => {});
    return client;
  }

  /** Open the connection and the dedicated browse channel. */
  async connect(profile: ConnectProfile, attemptId?: string): Promise<ConnectResult> {
    const id = `s${++this.seq}`;
    const session: Session = {
      id,
      profile,
      generation: 0,
      client: protocolOf(profile) === "sftp" ? new SshClient() : null,
      ftp: null,
      s3: null,
      s3Target: null,
      smb: null,
      webdav: null,
      sftp: null,
      pool: { free: [], total: 0, waiters: [] },
      ftpPool: { free: [], total: 0, waiters: [] },
      status: "connecting",
      closing: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      dropNotified: false,
    };
    this.sessions.set(id, session);
    this.setStatus(session, "connecting");

    const open = async (): Promise<ConnectResult> => {
      try {
        await this.dial(session);
      } catch (err) {
        this.sessions.delete(id);
        throw err;
      }
      session.client?.on("close", () => this.handleDrop(session));
      this.watchFtpDrop(session);
      const initialPath = await this.resolveInitialPath(session);
      return { sessionId: id, initialPath };
    };
    if (!attemptId) return open();

    let cancelled = false;
    const aborted = new Promise<never>((_, reject) => {
      this.attempts.set(attemptId, () => {
        cancelled = true;
        this.abandon(session);
        reject(Object.assign(new Error("Connection cancelled"), { code: "ECANCELED" }));
      });
    });
    const opening = open();
    opening.then(
      () => cancelled && this.abandon(session),
      () => {},
    );
    try {
      return await Promise.race([opening, aborted]);
    } finally {
      this.attempts.delete(attemptId);
    }
  }

  /** Abandon a connect that is still opening; a no-op once it has settled. */
  cancelConnect(attemptId: string): void {
    this.attempts.get(attemptId)?.();
  }

  private abandon(session: Session): void {
    session.closing = true;
    session.client?.destroy();
    session.ftp?.close();
    session.s3?.destroy();
    session.s3 = null;
    this.closeSmb(session);
    this.closeWebDav(session);
    session.generation++;
    this.resetPool(session, new Error("Connection cancelled"));
    this.resetFtpPool(session, new Error("Connection cancelled"));
    if (this.sessions.delete(session.id)) this.setStatus(session, "disconnected", "Connection cancelled");
  }

  private async dial(session: Session): Promise<void> {
    const protocol = protocolOf(session.profile);
    if (protocol === "s3") {
      await this.dialS3(session);
      return;
    }
    if (protocol === "smb") {
      await this.dialSmb(session);
      return;
    }
    if (isWebDav(protocol)) {
      await this.dialWebDav(session);
      return;
    }
    if (protocol !== "sftp") {
      await this.dialFtp(session);
      return;
    }
    const config = await this.buildConnectConfig(session.profile);
    const client = session.client;
    if (!client) throw new Error("No SSH client");
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        cleanup();
        reject(connectionError(err));
      };
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        client.removeListener("ready", onReady);
        client.removeListener("error", onError);
      };
      client.once("ready", onReady);
      client.once("error", onError);
      client.connect(config);
    });
    session.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
    // Post-handshake errors must not become uncaught exceptions.
    client.on("error", () => {});
    session.reconnectAttempt = 0;
    session.dropNotified = false;
    this.resetPool(session, new Error("Connection replaced"));
    session.generation++;
    this.setStatus(session, "connected");
  }

  private async openFtpClient(profile: ConnectProfile): Promise<FtpClient> {
    if (profile.auth.method !== "password") {
      throw new Error("FTP and FTPS require password authentication");
    }
    const tls = ftpTlsMode(protocolOf(profile));
    const client = new FtpClient(20_000);
    try {
      await client.access({
        host: profile.host,
        port: profile.port,
        user: profile.username,
        password: profile.auth.password,
        secure: tls === "explicit" ? true : tls === "implicit" ? "implicit" : false,
        ...(tls ? { secureOptions: { rejectUnauthorized: profile.tlsRejectUnauthorized !== false } } : {}),
      });
      return client;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  private async dialFtp(session: Session): Promise<void> {
    session.ftp = await this.openFtpClient(session.profile);
    session.reconnectAttempt = 0;
    session.dropNotified = false;
    this.resetFtpPool(session, new Error("Connection replaced"));
    session.generation++;
    this.setStatus(session, "connected");
  }

  private async dialS3(session: Session): Promise<void> {
    const config = s3ConfigFromProfile(session.profile);
    const credentials = credentialsFromProfile(session.profile);
    const client = createS3Client(config, credentials);
    const target: S3Target = { bucket: config.bucket, location: locationFor(session.profile.remotePath) };
    try {
      await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefixForPath(target.location, "/"),
          MaxKeys: 1,
        }),
      );
    } catch (err) {
      client.destroy();
      throw normalizeS3Error(err);
    }
    session.s3?.destroy();
    session.s3 = client;
    session.s3Target = target;
    session.reconnectAttempt = 0;
    session.dropNotified = false;
    this.resetPool(session, new Error("Connection replaced"));
    this.resetFtpPool(session, new Error("Connection replaced"));
    session.generation++;
    this.setStatus(session, "connected");
  }

  private async dialSmb(session: Session): Promise<void> {
    const connection = await openSmbConnection(session.profile);
    this.closeSmb(session);
    session.smb = connection;
    connection.onClose(() => {
      if (session.smb !== connection) return;
      session.smb = null;
      this.handleDrop(session);
    });
    session.reconnectAttempt = 0;
    session.dropNotified = false;
    session.generation++;
    this.setStatus(session, "connected");
  }

  private closeSmb(session: Session): void {
    const connection = session.smb;
    session.smb = null;
    connection?.close();
  }

  private async dialWebDav(session: Session): Promise<void> {
    const connection = await openWebDavConnection(session.profile);
    this.closeWebDav(session);
    session.webdav = connection;
    session.reconnectAttempt = 0;
    session.dropNotified = false;
    session.generation++;
    this.setStatus(session, "connected");
  }

  private closeWebDav(session: Session): void {
    const connection = session.webdav;
    session.webdav = null;
    connection?.close();
  }

  private watchFtpDrop(session: Session): void {
    const ftp = session.ftp;
    if (!ftp) return;
    const socket = ftp.ftp.socket;
    socket.once("close", () => {
      if (session.ftp === ftp) {
        session.ftp = null;
        this.handleDrop(session);
      }
    });
    // The library handles its own connection errors; this listener prevents
    // a late socket error from becoming uncaught while close drives recovery.
    socket.on("error", () => {});
  }

  private async resolveInitialPath(session: Session): Promise<string> {
    const want = session.profile.remotePath?.trim();
    if (protocolOf(session.profile) === "s3") {
      return "/";
    }
    if (protocolOf(session.profile) === "smb") {
      const smb = session.smb;
      if (!smb) throw new Error("No SMB connection");
      if (!want) return "/";
      const path = normalizeSmbPath(want);
      const stats = await smb.run((client) => client.stat(smb.path(path))).catch(() => null);
      return stats?.isDirectory ? path : "/";
    }
    if (isWebDav(protocolOf(session.profile))) {
      const webdav = session.webdav;
      if (!webdav) throw new Error("No WebDAV connection");
      if (!want) return "/";
      const path = normalizeWebDavPath(want);
      const [resource] = await webdav.propfind(path, 0, true).catch(() => []);
      return resource?.isDir ? path : "/";
    }
    if (protocolOf(session.profile) !== "sftp") {
      const ftp = session.ftp;
      if (!ftp) throw new Error("No FTP client");
      if (want) {
        try {
          await ftp.cd(want);
          return await ftp.pwd();
        } catch {
          // Fall through to the login directory.
        }
      }
      return ftp.pwd();
    }
    const sftp = session.sftp;
    if (!sftp) throw new Error("No SFTP channel");
    const realpath = (p: string): Promise<string> =>
      new Promise((resolve, reject) => sftp.realpath(p, (err, resolved) => (err ? reject(err) : resolve(resolved))));
    if (want) {
      try {
        return await realpath(want);
      } catch {
        // Fall through to home if the requested path is bad.
      }
    }
    return realpath(".");
  }

  private handleDrop(session: Session): void {
    if (session.closing || !this.sessions.has(session.id)) return;
    if (session.dropNotified) return;
    session.dropNotified = true;
    session.sftp = null;
    session.s3?.destroy();
    session.s3 = null;
    this.closeSmb(session);
    this.closeWebDav(session);
    session.generation++;
    this.resetPool(session, new Error("Connection lost"));
    this.resetFtpPool(session, new Error("Connection lost"));
    this.scheduleReconnect(session);
  }

  /** Called by S3 operations: only connectivity failures schedule a reconnect. */
  noteS3Failure(sessionId: string, err: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session || protocolOf(session.profile) !== "s3") return;
    if (session.status !== "connected" || !isConnectivityError(err)) return;
    this.handleDrop(session);
  }

  /** Called by SMB operations: only connectivity failures schedule a reconnect. */
  noteSmbFailure(sessionId: string, err: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session || protocolOf(session.profile) !== "smb") return;
    if (session.status !== "connected" || !isSmbConnectivityError(err)) return;
    this.handleDrop(session);
  }

  /** Called by WebDAV operations: only connectivity failures schedule a reconnect. */
  noteWebDavFailure(sessionId: string, err: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session || !isWebDav(protocolOf(session.profile))) return;
    if (session.status !== "connected" || !isWebDavConnectivityError(err)) return;
    this.handleDrop(session);
  }

  private resetPool(session: Session, err: Error): void {
    for (const channel of session.pool.free) channel.end();
    session.pool.free = [];
    session.pool.total = 0;
    const waiters = session.pool.waiters.splice(0);
    for (const w of waiters) w.reject(err);
  }

  private resetFtpPool(session: Session, err: Error): void {
    for (const client of session.ftpPool.free) client.close();
    session.ftpPool.free = [];
    session.ftpPool.total = 0;
    const waiters = session.ftpPool.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(err);
  }

  private scheduleReconnect(session: Session): void {
    if (this.getOptions().autoReconnect === false) {
      this.setStatus(session, "disconnected", "Automatic reconnect is off");
      return;
    }
    const attempt = session.reconnectAttempt;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      this.setStatus(session, "disconnected", "Reconnect attempts exhausted");
      return;
    }
    session.reconnectAttempt = attempt + 1;
    this.setStatus(session, "reconnecting", `Attempt ${attempt + 1}`);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      void this.tryReconnect(session);
    }, RECONNECT_DELAYS_MS[attempt]);
  }

  private async tryReconnect(session: Session): Promise<void> {
    if (session.closing || !this.sessions.has(session.id)) return;
    session.client?.removeAllListeners();
    session.client = protocolOf(session.profile) === "sftp" ? new SshClient() : null;
    session.ftp?.close();
    session.ftp = null;
    this.closeSmb(session);
    this.closeWebDav(session);
    try {
      await this.dial(session);
      session.client?.on("close", () => this.handleDrop(session));
      this.watchFtpDrop(session);
    } catch {
      this.scheduleReconnect(session);
    }
  }

  /** User-triggered retry after reconnects were exhausted. */
  reconnectNow(sessionId: string): void {
    const session = this.mustGet(sessionId);
    if (session.status !== "disconnected") return;
    session.reconnectAttempt = 0;
    this.setStatus(session, "reconnecting", "Manual retry");
    void this.tryReconnect(session);
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closing = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.client?.end();
    session.ftp?.close();
    session.s3?.destroy();
    session.s3 = null;
    this.closeSmb(session);
    this.closeWebDav(session);
    session.generation++;
    this.resetPool(session, new Error("Disconnected"));
    this.resetFtpPool(session, new Error("Disconnected"));
    this.sessions.delete(sessionId);
    this.setStatus(session, "disconnected", "Disconnected");
  }

  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id);
  }

  private mustGet(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Unknown session");
    return session;
  }

  status(sessionId: string): SessionStatus {
    return this.mustGet(sessionId).status;
  }

  protocol(sessionId: string): ConnectionProtocol {
    return protocolOf(this.mustGet(sessionId).profile);
  }

  transferConcurrency(sessionId: string): number {
    return poolSizeFor(this.mustGet(sessionId).profile) - 1;
  }

  /** Identifies the underlying connection; changes after every reconnect. */
  connectionGeneration(sessionId: string): number {
    return this.mustGet(sessionId).generation;
  }

  /** The dedicated browse channel; throws while not connected. */
  browseChannel(sessionId: string): SFTPWrapper {
    const session = this.mustGet(sessionId);
    if (!session.sftp || session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    return session.sftp;
  }

  /** Dedicated FTP client. Callers must serialize operations on it. */
  browseFtpClient(sessionId: string): FtpClient {
    const session = this.mustGet(sessionId);
    if (!session.ftp || session.ftp.closed || session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    return session.ftp;
  }

  /** Checked S3 request surface; the SDK client is shareable and stateless. */
  s3Session(sessionId: string): { client: S3Like; target: S3Target } {
    const session = this.mustGet(sessionId);
    if (!session.s3 || !session.s3Target || session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    return { client: session.s3 as unknown as S3Like, target: session.s3Target };
  }

  /** The session's SMB connection; shared by browsing and transfers. */
  smbConnection(sessionId: string): SmbConnection {
    const session = this.mustGet(sessionId);
    if (!session.smb || session.smb.closed || session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    return session.smb;
  }

  /** The session's WebDAV connection; shared by browsing and transfers. */
  webdavConnection(sessionId: string): WebDavConnection {
    const session = this.mustGet(sessionId);
    if (!session.webdav || session.webdav.closed || session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    return session.webdav;
  }

  /**
   * Lease a transfer channel from the pool (§3.3). Callers MUST release();
   * pass broken=true if the channel errored so it gets discarded.
   */
  async acquireTransferChannel(sessionId: string): Promise<{ sftp: SFTPWrapper; release: (broken?: boolean) => void }> {
    const session = this.mustGet(sessionId);
    if (session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    const leaseGeneration = session.generation;
    const lease = (sftp: SFTPWrapper): { sftp: SFTPWrapper; release: (broken?: boolean) => void } => ({
      sftp,
      release: onceRelease((broken) => this.releaseTransferChannel(session, sftp, broken, leaseGeneration)),
    });

    const pooled = session.pool.free.pop();
    if (pooled) return lease(pooled);

    if (session.pool.total < poolSizeFor(session.profile)) {
      session.pool.total++;
      try {
        const sftp = await boundedAcquire(
          new Promise<SFTPWrapper>((resolve, reject) => session.client!.sftp((err, ch) => (err ? reject(err) : resolve(ch)))),
          (channel) => channel.end(),
        );
        if (session.generation !== leaseGeneration || session.status !== "connected") {
          sftp.end();
          throw new Error("Connection replaced");
        }
        sftp.on("error", () => {});
        return lease(sftp);
      } catch (err) {
        if (session.generation === leaseGeneration) {
          session.pool.total = Math.max(0, session.pool.total - 1);
          for (const waiter of session.pool.waiters.splice(0)) waiter.reject(err as Error);
        }
        throw err;
      }
    }

    let waiter!: ChannelPool["waiters"][number];
    try {
      const sftp = await boundedAcquire(
        new Promise<SFTPWrapper>((resolve, reject) => {
          waiter = { resolve, reject };
          session.pool.waiters.push(waiter);
        }),
        (channel) => this.releaseTransferChannel(session, channel, true, leaseGeneration),
      );
      return lease(sftp);
    } finally {
      const index = session.pool.waiters.indexOf(waiter);
      if (index !== -1) session.pool.waiters.splice(index, 1);
    }
  }

  /** Lease an independent FTP control connection for one transfer/endpoint. */
  async acquireFtpClient(sessionId: string): Promise<{ client: FtpClient; release: (broken?: boolean) => void }> {
    const session = this.mustGet(sessionId);
    if (protocolOf(session.profile) !== "ftp" && !ftpTlsMode(protocolOf(session.profile))) {
      throw new Error("Not an FTP session");
    }
    if (session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    const generation = session.generation;
    const makeLease = (client: FtpClient): { client: FtpClient; release: (broken?: boolean) => void } => ({
      client,
      release: onceRelease((broken) => this.releaseFtpClient(session, client, broken, generation)),
    });
    while (session.ftpPool.free.length > 0) {
      const pooled = session.ftpPool.free.pop()!;
      if (!pooled.closed) return makeLease(pooled);
      session.ftpPool.total = Math.max(0, session.ftpPool.total - 1);
    }

    if (session.ftpPool.total < poolSizeFor(session.profile)) {
      session.ftpPool.total++;
      try {
        const client = await boundedAcquire(this.openFtpClient(session.profile), (late) => late.close());
        if (session.generation !== generation || session.status !== "connected") {
          client.close();
          throw new Error("Connection replaced");
        }
        return makeLease(client);
      } catch (err) {
        if (session.generation === generation) {
          session.ftpPool.total = Math.max(0, session.ftpPool.total - 1);
          for (const waiter of session.ftpPool.waiters.splice(0)) waiter.reject(err as Error);
        }
        throw err;
      }
    }
    let waiter!: FtpPool["waiters"][number];
    try {
      const client = await boundedAcquire(
        new Promise<FtpClient>((resolve, reject) => {
          waiter = { resolve, reject };
          session.ftpPool.waiters.push(waiter);
        }),
        (late) => this.releaseFtpClient(session, late, true, generation),
      );
      return makeLease(client);
    } finally {
      const index = session.ftpPool.waiters.indexOf(waiter);
      if (index !== -1) session.ftpPool.waiters.splice(index, 1);
    }
  }

  private releaseFtpClient(session: Session, client: FtpClient, broken: boolean, generation: number): void {
    if (generation !== session.generation || session.closing || session.status !== "connected") {
      client.close();
      return;
    }
    if (broken || client.closed) {
      client.close();
      session.ftpPool.total = Math.max(0, session.ftpPool.total - 1);
      for (const waiter of session.ftpPool.waiters.splice(0)) waiter.reject(new Error("FTP connection lost"));
      return;
    }
    const waiter = session.ftpPool.waiters.shift();
    if (waiter) waiter.resolve(client);
    else session.ftpPool.free.push(client);
  }

  private releaseTransferChannel(session: Session, sftp: SFTPWrapper, broken: boolean, leaseGeneration: number): void {
    if (leaseGeneration !== session.generation || session.closing || session.status !== "connected") {
      try {
        sftp.end();
      } catch {
        // already dead
      }
      return;
    }
    if (broken) {
      session.pool.total = Math.max(0, session.pool.total - 1);
      for (const waiter of session.pool.waiters.splice(0)) waiter.reject(new Error("Channel closed"));
      try {
        sftp.end();
      } catch {
        // already dead
      }
      return;
    }
    const waiter = session.pool.waiters.shift();
    if (waiter) waiter.resolve(sftp);
    else session.pool.free.push(sftp);
  }
}
