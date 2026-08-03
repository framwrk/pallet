/**
 * SSH session lifecycle: connect, host-key verification (TOFU), a dedicated
 * SFTP channel for browsing, keepalive, and reconnect-with-backoff.
 *
 * This module deliberately imports nothing from Electron so the Docker
 * integration tests can drive it directly. Host-key decisions and status
 * events are injected via SessionManagerHooks.
 */
import { createHash } from "crypto";
import { promises as fs } from "fs";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { ConnectProfile, ConnectResult, SessionStatus, SessionStatusEvent } from "../../shared/types";

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

interface Session {
  id: string;
  profile: ConnectProfile;
  /** Bumped on every successful dial; leases from older generations are dead. */
  generation: number;
  client: Client;
  /** Dedicated browsing channel; navigation never queues behind a transfer. */
  sftp: SFTPWrapper | null;
  /** Pool of transfer channels (§3.3); size from the profile's concurrency. */
  pool: ChannelPool;
  status: SessionStatus;
  /** Set while the user is deliberately disconnecting. */
  closing: boolean;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
const DEFAULT_CONCURRENCY = 3;
/**
 * OpenSSH's default MaxSessions is 10. Browsing holds one channel and the
 * SFTP endpoint holds one for metadata, so capping streams at 7 keeps the
 * worst case at 9 and leaves headroom.
 */
const MAX_CONCURRENCY = 7;

export function parseKeyType(keyBlob: Buffer): string {
  try {
    const len = keyBlob.readUInt32BE(0);
    return keyBlob.subarray(4, 4 + len).toString("ascii");
  } catch {
    return "unknown";
  }
}

/**
 * Channel budget for one session's transfer pool.
 *
 * "Concurrency" is the number of parallel *transfers* the user asked for, but
 * the SFTP endpoint also parks one channel for metadata (stat/mkdir/rename)
 * for as long as a job runs. The pool therefore needs concurrency + 1: at a
 * literal budget of 1 the metadata lease takes the only channel and every
 * stream waits on it forever.
 */
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

  private async buildConnectConfig(profile: ConnectProfile): Promise<Parameters<Client["connect"]>[0]> {
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
    const client = new Client();
    const session: Session = {
      id,
      profile,
      generation: 0,
      client,
      sftp: null,
      pool: { free: [], total: 0, waiters: [] },
      status: "connecting",
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

    session.client.on("close", () => this.handleDrop(session));

    const initialPath = await this.resolveInitialPath(session);
    return { sessionId: id, initialPath };
  }

  /** One dial attempt: TCP+SSH handshake plus the browse SFTP channel. */
  private async dial(session: Session): Promise<void> {
    const config = await this.buildConnectConfig(session.profile);
    const client = session.client;
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
    session.generation++;
    this.setStatus(session, "connected");
  }

  private async resolveInitialPath(session: Session): Promise<string> {
    const want = session.profile.remotePath?.trim();
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
    this.resetPool(session, new Error("Connection lost"));
    this.scheduleReconnect(session);
  }

  private resetPool(session: Session, err: Error): void {
    session.pool.free = [];
    session.pool.total = 0;
    const waiters = session.pool.waiters.splice(0);
    for (const w of waiters) w.reject(err);
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
    session.client.removeAllListeners();
    session.client = new Client();
    try {
      await this.dial(session);
      session.client.on("close", () => this.handleDrop(session));
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
    session.client.end();
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
      release: (broken = false) => this.releaseTransferChannel(session, sftp, broken, leaseGeneration),
    });

    const pooled = session.pool.free.pop();
    if (pooled) return lease(pooled);

    if (session.pool.total < poolSizeFor(session.profile)) {
      session.pool.total++;
      try {
        const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
          session.client.sftp((err, ch) => (err ? reject(err) : resolve(ch))),
        );
        return lease(sftp);
      } catch (err) {
        session.pool.total--;
        throw err;
      }
    }

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => session.pool.waiters.push({ resolve, reject }));
    return lease(sftp);
  }

  private releaseTransferChannel(session: Session, sftp: SFTPWrapper, broken: boolean, leaseGeneration: number): void {
    // The connection was replaced under this lease: the channel is dead even
    // if its stream closed cleanly. Dropping it here keeps a corpse out of
    // the free list, where it would silently hang the next transfer.
    if (leaseGeneration !== session.generation) {
      try {
        sftp.end();
      } catch {
        // already dead
      }
      return;
    }
    if (broken) {
      session.pool.total = Math.max(0, session.pool.total - 1);
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
