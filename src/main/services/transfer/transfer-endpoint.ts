/**
 * TransferEndpoint: the minimal filesystem surface the queue needs, provided
 * by both the local disk and an SFTP session so every transfer direction
 * (upload, download, local↔local, remote↔remote) is one code path.
 *
 * Paths are POSIX on both sides (macOS local paths are POSIX).
 */
import { type FileInfo, FileType, type Client as FtpClient } from "basic-ftp";
import { PassThrough, type Readable, Writable } from "stream";
import { createReadStream, createWriteStream, promises as fs } from "fs";
import { isDirMode, isSymlinkMode } from "../../utils/file-mode";
import type { SFTPWrapper } from "ssh2";
import type { SessionManager } from "../sftp/session-manager";

export interface EndpointStat {
  size: number;
  mtimeMs: number;
  mode: number;
  isDir: boolean;
  isSymlink: boolean;
}

export interface TransferEndpoint {
  kind: "local" | "sftp";
  statOrNull(p: string): Promise<EndpointStat | null>;
  listNames(dir: string): Promise<string[]>;
  /** Names + kinds, for enumeration. */
  listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]>;
  mkdirp(p: string): Promise<void>;
  createReadStream(p: string): Promise<Readable>;
  createWriteStream(p: string, mode?: number): Promise<Writable>;
  setMeta(p: string, meta: { mtimeMs: number; mode?: number }): Promise<void>;
  /** Rename, replacing an existing destination. */
  renameReplacing(from: string, to: string): Promise<void>;
  removeFile(p: string): Promise<void>;
  /** Called when the queue is done with this endpoint. */
  dispose(): void;
}

function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}
export const joinPath = join;

// --- local ------------------------------------------------------------------

class LocalEndpoint implements TransferEndpoint {
  kind = "local" as const;

  async statOrNull(p: string): Promise<EndpointStat | null> {
    try {
      const lstat = await fs.lstat(p);
      return {
        size: lstat.size,
        mtimeMs: lstat.mtimeMs,
        mode: lstat.mode,
        isDir: lstat.isDirectory(),
        isSymlink: lstat.isSymbolicLink(),
      };
    } catch {
      return null;
    }
  }

  async listNames(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(dir);
    } catch {
      return [];
    }
  }

  async listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]> {
    const out: { name: string; stat: EndpointStat }[] = [];
    for (const name of await fs.readdir(dir)) {
      const stat = await this.statOrNull(join(dir, name));
      if (stat) out.push({ name, stat });
    }
    return out;
  }

  async mkdirp(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  async createReadStream(p: string): Promise<Readable> {
    return createReadStream(p);
  }

  async createWriteStream(p: string): Promise<Writable> {
    return createWriteStream(p, { mode: 0o644 });
  }

  async setMeta(p: string, meta: { mtimeMs: number; mode?: number }): Promise<void> {
    const t = meta.mtimeMs / 1000;
    await fs.utimes(p, t, t);
    if (meta.mode != null) await fs.chmod(p, meta.mode & 0o7777);
  }

  async renameReplacing(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async removeFile(p: string): Promise<void> {
    await fs.rm(p, { force: true });
  }

  dispose(): void {
    // Local endpoint holds no resources.
  }
}

// --- sftp -------------------------------------------------------------------

interface Lease {
  sftp: SFTPWrapper;
  release: (broken?: boolean) => void;
}

const META_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err: NodeJS.ErrnoException = new Error("SFTP request timed out");
      err.code = "ETIMEDOUT";
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * SFTP endpoint over the session's transfer-channel pool. Metadata calls
 * share one leased channel; each concurrent stream leases its own.
 */
class SftpEndpoint implements TransferEndpoint {
  kind = "sftp" as const;
  private metaLease: Lease | null = null;
  private metaGeneration = -1;

  constructor(
    private sessions: SessionManager,
    private sessionId: string,
  ) {}

  private async meta(): Promise<SFTPWrapper> {
    // A cached lease is only good for the connection it was taken on. After a
    // drop the channel is dead but looks fine — its requests simply never call
    // back — so drop it on any generation change or non-connected status
    // rather than handing a caller something that will hang forever.
    const generation = this.sessions.connectionGeneration(this.sessionId);
    const live = this.sessions.status(this.sessionId) === "connected";
    if (this.metaLease && (this.metaGeneration !== generation || !live)) {
      this.metaLease.release(true);
      this.metaLease = null;
    }
    if (!this.metaLease) {
      this.metaLease = await this.sessions.acquireTransferChannel(this.sessionId);
      this.metaGeneration = generation;
    }
    return this.metaLease.sftp;
  }

  /** Drop the cached metadata channel (after a connection error). */
  private invalidateMeta(): void {
    this.metaLease?.release(true);
    this.metaLease = null;
  }

  private async withMeta<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    try {
      // Backstop: a channel can die between the status check and the request,
      // and ssh2 never calls back on a dead channel. Without this, one lost
      // packet strands a transfer worker permanently.
      return await withTimeout(fn(await this.meta()), META_TIMEOUT_MS);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTCONN" || code === "ETIMEDOUT" || /not connected|no response/i.test((err as Error).message)) {
        this.invalidateMeta();
      }
      throw err;
    }
  }

  statOrNull(p: string): Promise<EndpointStat | null> {
    return this.withMeta(
      (sftp) =>
        new Promise((resolve) => {
          sftp.lstat(p, (err, stats) => {
            if (err) return resolve(null);
            resolve({
              size: stats.size ?? 0,
              mtimeMs: (stats.mtime ?? 0) * 1000,
              mode: stats.mode ?? 0,
              isDir: isDirMode(stats.mode),
              isSymlink: isSymlinkMode(stats.mode),
            });
          });
        }),
    );
  }

  listNames(dir: string): Promise<string[]> {
    return this.withMeta(
      (sftp) =>
        new Promise((resolve) => {
          sftp.readdir(dir, (err, entries) => resolve(err ? [] : entries.map((e) => e.filename)));
        }),
    );
  }

  listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]> {
    return this.withMeta(
      (sftp) =>
        new Promise((resolve, reject) => {
          sftp.readdir(dir, (err, entries) => {
            if (err) return reject(err);
            resolve(
              entries.map((e) => ({
                name: e.filename,
                stat: {
                  size: e.attrs.size ?? 0,
                  mtimeMs: (e.attrs.mtime ?? 0) * 1000,
                  mode: e.attrs.mode ?? 0,
                  isDir: isDirMode(e.attrs.mode),
                  isSymlink: isSymlinkMode(e.attrs.mode),
                },
              })),
            );
          });
        }),
    );
  }

  async mkdirp(p: string): Promise<void> {
    const st = await this.statOrNull(p);
    if (st?.isDir) return;
    if (st) throw new Error(`Not a directory: ${p}`);
    const parent = p.slice(0, p.lastIndexOf("/")) || "/";
    if (parent !== p) await this.mkdirp(parent);
    await this.withMeta(
      (sftp) =>
        new Promise<void>((resolve, reject) =>
          sftp.mkdir(p, (err) => {
            if (!err) return resolve();
            // Lost a race with a concurrent mkdir: fine if it exists now.
            sftp.stat(p, (statErr, stats) => {
              if (!statErr && isDirMode(stats.mode)) resolve();
              else reject(err);
            });
          }),
        ),
    );
  }

  async createReadStream(p: string): Promise<Readable> {
    const lease = await this.sessions.acquireTransferChannel(this.sessionId);
    const stream = lease.sftp.createReadStream(p, { autoClose: true });
    hookRelease(stream, lease);
    return stream;
  }

  async createWriteStream(p: string, mode?: number): Promise<Writable> {
    const lease = await this.sessions.acquireTransferChannel(this.sessionId);
    const stream = lease.sftp.createWriteStream(p, {
      flags: "w",
      ...(mode != null ? { mode: mode & 0o7777 } : {}),
    });
    hookRelease(stream, lease);
    return stream;
  }

  setMeta(p: string, meta: { mtimeMs: number; mode?: number }): Promise<void> {
    return this.withMeta(async (sftp) => {
      const t = Math.floor(meta.mtimeMs / 1000);
      await new Promise<void>((resolve, reject) => sftp.utimes(p, t, t, (err) => (err ? reject(err) : resolve())));
      if (meta.mode != null) {
        await new Promise<void>((resolve, reject) =>
          sftp.chmod(p, meta.mode! & 0o7777, (err) => (err ? reject(err) : resolve())),
        );
      }
    });
  }

  renameReplacing(from: string, to: string): Promise<void> {
    return this.withMeta(async (sftp) => {
      const attempt = (): Promise<void> =>
        new Promise((resolve, reject) => sftp.rename(from, to, (err) => (err ? reject(err) : resolve())));
      try {
        await attempt();
      } catch {
        // SFTP rename refuses to overwrite; clear the target and retry.
        await new Promise<void>((resolve) => sftp.unlink(to, () => resolve()));
        await attempt();
      }
    });
  }

  removeFile(p: string): Promise<void> {
    return this.withMeta((sftp) => new Promise<void>((resolve) => sftp.unlink(p, () => resolve())));
  }

  dispose(): void {
    this.metaLease?.release();
    this.metaLease = null;
  }
}

// --- ftp / explicit ftps ----------------------------------------------------

interface FtpLease {
  client: FtpClient;
  release: (broken?: boolean) => void;
}

function ftpEndpointStat(info: FileInfo): EndpointStat {
  const type = info.type === FileType.Directory ? 0o040000 : info.type === FileType.SymbolicLink ? 0o120000 : 0o100000;
  const permissions = info.permissions;
  const mode =
    type |
    (permissions ? (permissions.user << 6) | (permissions.group << 3) | permissions.world : info.isDirectory ? 0o755 : 0o644);
  return {
    size: info.size ?? 0,
    mtimeMs: info.modifiedAt?.getTime() ?? 0,
    mode,
    isDir: info.isDirectory,
    isSymlink: info.isSymbolicLink,
  };
}

function checkFtpPath(path: string): void {
  if (/[\r\n]/.test(path)) throw new Error("Invalid FTP path");
}

class FtpEndpoint implements TransferEndpoint {
  kind = "sftp" as const;
  private metaLease: FtpLease | null = null;
  private metaTail: Promise<void> = Promise.resolve();

  constructor(
    private sessions: SessionManager,
    private sessionId: string,
  ) {}

  private async meta(): Promise<FtpClient> {
    if (!this.metaLease || this.metaLease.client.closed) {
      this.metaLease?.release(true);
      this.metaLease = await this.sessions.acquireFtpClient(this.sessionId);
    }
    return this.metaLease.client;
  }

  private withMeta<T>(fn: (client: FtpClient) => Promise<T>): Promise<T> {
    const operation = this.metaTail.catch(() => {}).then(async () => fn(await this.meta()));
    this.metaTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.catch((err) => {
      if (this.metaLease?.client.closed) {
        this.metaLease.release(true);
        this.metaLease = null;
      }
      throw err;
    });
  }

  async statOrNull(p: string): Promise<EndpointStat | null> {
    checkFtpPath(p);
    if (p === "/") return { size: 0, mtimeMs: 0, mode: 0o040755, isDir: true, isSymlink: false };
    const slash = p.lastIndexOf("/");
    const parent = slash <= 0 ? "/" : p.slice(0, slash);
    const name = p.slice(slash + 1);
    return this.withMeta(async (ftp) => {
      try {
        const info = (await ftp.list(parent)).find((entry) => entry.name === name);
        return info ? ftpEndpointStat(info) : null;
      } catch {
        return null;
      }
    });
  }

  listNames(dir: string): Promise<string[]> {
    checkFtpPath(dir);
    return this.withMeta(async (ftp) => {
      try {
        return (await ftp.list(dir)).map((entry) => entry.name);
      } catch {
        return [];
      }
    });
  }

  listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]> {
    checkFtpPath(dir);
    return this.withMeta(async (ftp) =>
      (await ftp.list(dir)).map((entry) => ({ name: entry.name, stat: ftpEndpointStat(entry) })),
    );
  }

  async mkdirp(p: string): Promise<void> {
    checkFtpPath(p);
    await this.withMeta((ftp) => ftp.ensureDir(p));
  }

  async createReadStream(p: string): Promise<Readable> {
    checkFtpPath(p);
    const lease = await this.sessions.acquireFtpClient(this.sessionId);
    const output = new PassThrough();
    void lease.client.downloadTo(output, p).then(
      () => lease.release(),
      (err) => {
        output.destroy(err as Error);
        lease.release(true);
      },
    );
    return output;
  }

  async createWriteStream(p: string): Promise<Writable> {
    checkFtpPath(p);
    const lease = await this.sessions.acquireFtpClient(this.sessionId);
    const input = new PassThrough();
    const uploaded = lease.client.uploadFrom(input, p);
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (input.write(chunk, encoding)) callback();
        else input.once("drain", callback);
      },
      final(callback) {
        input.end();
        uploaded.then(
          () => callback(),
          (err) => callback(err as Error),
        );
      },
      destroy(err, callback) {
        input.destroy(err ?? undefined);
        callback(err);
      },
    });
    uploaded.then(
      () => lease.release(),
      (err) => {
        output.destroy(err as Error);
        lease.release(true);
      },
    );
    return output;
  }

  setMeta(p: string, meta: { mtimeMs: number; mode?: number }): Promise<void> {
    checkFtpPath(p);
    return this.withMeta(async (ftp) => {
      const stamp = new Date(meta.mtimeMs).toISOString().replace(/[-:T]/g, "").slice(0, 14);
      await ftp.sendIgnoringError(`MFMT ${stamp} ${p}`);
      if (meta.mode != null) await ftp.sendIgnoringError(`SITE CHMOD ${(meta.mode & 0o7777).toString(8)} ${p}`);
    });
  }

  renameReplacing(from: string, to: string): Promise<void> {
    checkFtpPath(from);
    checkFtpPath(to);
    return this.withMeta(async (ftp) => {
      await ftp.remove(to, true);
      await ftp.rename(from, to);
    });
  }

  removeFile(p: string): Promise<void> {
    checkFtpPath(p);
    return this.withMeta(async (ftp) => {
      await ftp.remove(p, true);
    });
  }

  dispose(): void {
    this.metaLease?.release();
    this.metaLease = null;
  }
}

/** Release the channel lease when the stream finishes or dies. */
function hookRelease(stream: Readable | Writable, lease: Lease): void {
  let done = false;
  const finish = (broken: boolean): void => {
    if (!done) {
      done = true;
      lease.release(broken);
    }
  };
  stream.once("close", () => finish(false));
  stream.once("error", () => finish(true));
}

export function makeEndpoint(
  sessions: SessionManager,
  ref: { kind: "local" } | { kind: "sftp"; sessionId: string },
): TransferEndpoint {
  if (ref.kind === "local") return new LocalEndpoint();
  return sessions.protocol(ref.sessionId) === "sftp"
    ? new SftpEndpoint(sessions, ref.sessionId)
    : new FtpEndpoint(sessions, ref.sessionId);
}
