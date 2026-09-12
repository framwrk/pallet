/**
 * SSH session lifecycle: connect, host-key verification (TOFU), a dedicated
 * SFTP channel for browsing, keepalive, and reconnect-with-backoff.
 *
 * This module deliberately imports nothing from Electron so the Docker
 * integration tests can drive it directly. Host-key decisions and status
 * events are injected via SessionManagerHooks.
 */
import { type ConnectConfig, type SFTPWrapper, Client as SshClient } from "ssh2";
import type {
  ConnectProfile,
  ConnectResult,
  ConnectionProtocol,
  SessionStatus,
  SessionStatusEvent,
} from "@shared/sftp/sftp.types";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "@shared/prefs/prefs.constants";
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

interface ChannelPool {
  free: SFTPWrapper[];
  /** Channels currently open (free + leased). */
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
  /** Bumped on every successful dial; leases from older generations are dead. */
  generation: number;
  client: SshClient | null;
  /** Dedicated FTP/FTPS client for browsing and metadata operations. */
  ftp: FtpClient | null;
  /** Dedicated browsing channel; navigation never queues behind a transfer. */
  sftp: SFTPWrapper | null;
  /** Pool of transfer channels (§3.3); size from the profile's concurrency. */
  pool: ChannelPool;
  ftpPool: FtpPool;
  status: SessionStatus;
  /**
   * Whether the server's `du` understands -b (GNU). Probed on first use and
   * cached; false sends folder sizing down the SFTP-walk path instead.
   */
  duApparentBytes: boolean | null;
  /** Set while the user is deliberately disconnecting. */
  closing: boolean;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/** Bound both channel handshakes and pool waits; dispose any late resource. */
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
  return profile.protocol === "ftp" || profile.protocol === "ftps" ? profile.protocol : "sftp";
}

/** Parallel transfers plus one channel of headroom for short metadata calls. */
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

export class SessionManager {
  private sessions = new Map<string, Session>();
  private seq = 0;

  constructor(private hooks: SessionManagerHooks) {}

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
    const privateKey = await fs.readFile(profile.auth.keyPath);
    return {
      ...base,
      privateKey,
      ...(profile.auth.passphrase ? { passphrase: profile.auth.passphrase } : {}),
    };
  }

  /** Open the connection and the dedicated browse channel. */
  async connect(profile: ConnectProfile): Promise<ConnectResult> {
    const id = `s${++this.seq}`;
    const session: Session = {
      id,
      profile,
      generation: 0,
      client: protocolOf(profile) === "sftp" ? new SshClient() : null,
      ftp: null,
      sftp: null,
      pool: { free: [], total: 0, waiters: [] },
      ftpPool: { free: [], total: 0, waiters: [] },
      status: "connecting",
      duApparentBytes: null,
      closing: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
    };
    this.sessions.set(id, session);
    this.setStatus(session, "connecting");

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
  }

  /** One dial attempt: TCP+SSH handshake plus the browse SFTP channel. */
  private async dial(session: Session): Promise<void> {
    if (protocolOf(session.profile) !== "sftp") {
      await this.dialFtp(session);
      return;
    }
    const config = await this.buildConnectConfig(session.profile);
    const client = session.client;
    if (!client) throw new Error("No SSH client");
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
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
    // handleDrop already emptied the pool, but a stream destroyed by the drop
    // can emit 'close' without an 'error' and release its channel back into
    // the free list afterwards — still on the outgoing generation, so the
    // release-time guard lets it through. Clear the pool again here, where the
    // new connection begins, so nothing from the old one can be leased out.
    this.resetPool(session, new Error("Connection replaced"));
    session.generation++;
    this.setStatus(session, "connected");
  }

  private async openFtpClient(profile: ConnectProfile): Promise<FtpClient> {
    if (profile.auth.method !== "password") {
      throw new Error("FTP and FTPS require password authentication");
    }
    const client = new FtpClient(20_000);
    try {
      await client.access({
        host: profile.host,
        port: profile.port,
        user: profile.username,
        password: profile.auth.password,
        secure: protocolOf(profile) === "ftps",
        ...(protocolOf(profile) === "ftps"
          ? { secureOptions: { rejectUnauthorized: profile.tlsRejectUnauthorized !== false } }
          : {}),
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
    this.resetFtpPool(session, new Error("Connection replaced"));
    session.generation++;
    this.setStatus(session, "connected");
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
    session.sftp = null;
    session.generation++;
    this.resetPool(session, new Error("Connection lost"));
    this.resetFtpPool(session, new Error("Connection lost"));
    this.scheduleReconnect(session);
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

  /** Cached `du -b` support, or null until probed. Survives reconnects. */
  duApparentBytes(sessionId: string): boolean | null {
    return this.mustGet(sessionId).duApparentBytes;
  }

  setDuApparentBytes(sessionId: string, supported: boolean): void {
    this.mustGet(sessionId).duApparentBytes = supported;
  }

  /**
   * Run one command on its own exec channel and collect its output.
   *
   * Folder sizing is the only caller and holds at most one of these at a
   * time: the browse channel plus a saturated transfer pool already sits at 9
   * of OpenSSH's default MaxSessions of 10, leaving room for exactly one more.
   * stdout is capped because a channel that floods would otherwise be
   * unbounded memory in the main process.
   */
  async exec(sessionId: string, command: string, maxBytes = 64 * 1024): Promise<{ stdout: string; code: number | null }> {
    const session = this.mustGet(sessionId);
    if (protocolOf(session.profile) !== "sftp") throw new Error("Remote commands are only available over SFTP");
    if (session.status !== "connected") {
      const err: NodeJS.ErrnoException = new Error("Not connected");
      err.code = "ENOTCONN";
      throw err;
    }
    return new Promise((resolve, reject) => {
      session.client!.exec(command, (err, stream) => {
        if (err) return reject(err);
        const chunks: Buffer[] = [];
        let length = 0;
        let code: number | null = null;
        stream.on("data", (chunk: Buffer) => {
          if (length >= maxBytes) return;
          chunks.push(chunk);
          length += chunk.length;
        });
        // Draining stderr keeps the peer from stalling on a full window; the
        // content itself is not interesting, since a nonzero exit is enough.
        stream.stderr.resume();
        stream.on("exit", (exitCode: number | null) => {
          code = exitCode;
        });
        stream.on("close", () => {
          resolve({ stdout: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"), code });
        });
        stream.on("error", reject);
      });
    });
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
    if (protocolOf(session.profile) === "sftp") throw new Error("Not an FTP session");
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
    // The connection was replaced under this lease: the channel is dead even
    // if its stream closed cleanly. Dropping it here keeps a corpse out of
    // the free list, where it would silently hang the next transfer.
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
