/**
 * TransferEndpoint: the minimal filesystem surface the queue needs, provided
 * by both the local disk and an SFTP session so every transfer direction
 * (upload, download, local↔local, remote↔remote) is one code path.
 *
 * Paths are POSIX on both sides (macOS local paths are POSIX).
 */
import { type FileInfo, FileType, type Client as FtpClient } from "basic-ftp";
import { PassThrough, type Readable, Writable } from "stream";
import { createPipelinedReadStream, createPipelinedWriteStream } from "../sftp/pipelined-streams";
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

export interface ReadOptions {
  start?: number;
  end?: number;
  signal?: AbortSignal;
}

export interface WriteOptions {
  start?: number;
  signal?: AbortSignal;
  /** Final mode/mtime to apply to the staged file when the endpoint supports it. */
  meta?: { mtimeMs: number; mode?: number };
}

/** Writable whose destination can report how many bytes it has confirmed. */
export interface TransferWriteStream extends Writable {
  /** Highest contiguous destination-confirmed byte offset, when known. */
  confirmedBytes?(): number;
}

export interface TransferEndpoint {
  /** Supports bounded reads and writing at a confirmed checkpoint. */
  supportsRanges?: boolean;
  kind: "local" | "sftp";
  statOrNull(p: string): Promise<EndpointStat | null>;
  fileVersion?(p: string): Promise<{ size: number; mtimeMs: number }>;
  fileSize?(p: string): Promise<number>;
  listNames(dir: string): Promise<string[]>;
  /** Names + kinds, for enumeration. */
  listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]>;
  mkdirp(p: string): Promise<void>;
  createReadStream(p: string, options?: ReadOptions): Promise<Readable>;
  createWriteStream(p: string, mode?: number, options?: WriteOptions): Promise<TransferWriteStream>;
  /** True when createWriteStream applies options.meta on close, so no separate setMeta is needed. */
  writesMeta?: boolean;
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
  supportsRanges = true;
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async listNames(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]> {
    const out: { name: string; stat: EndpointStat }[] = [];
    for (const name of await fs.readdir(dir)) {
      const stat = await this.statOrNull(join(dir, name));
      if (!stat) throw new Error(`Source disappeared: ${join(dir, name)}`);
      out.push({ name, stat });
    }
    return out;
  }

  async mkdirp(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  async createReadStream(p: string, options: ReadOptions = {}): Promise<Readable> {
    options.signal?.throwIfAborted();
    return createReadStream(p, { ...options, highWaterMark: 256 * 1024 });
  }

  async createWriteStream(p: string, _mode?: number, options: WriteOptions = {}): Promise<TransferWriteStream> {
    options.signal?.throwIfAborted();
    const start = options.start ?? 0;
    const stream = createWriteStream(p, { ...options, flags: start > 0 ? "r+" : "w", mode: 0o600 });
    // fs.WriteStream.bytesWritten counts bytes the OS accepted; polling it gives
    // the queue a destination-confirmed checkpoint without an extra stat.
    return Object.assign(stream, { confirmedBytes: () => start + stream.bytesWritten });
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
 * SFTP endpoint over the session's transfer-channel pool. Metadata leases
 * last only for their operation; each concurrent stream leases its own.
 */
class SftpEndpoint implements TransferEndpoint {
  kind = "sftp" as const;
  supportsRanges = true;
  writesMeta = true;

  constructor(
    private sessions: SessionManager,
    private sessionId: string,
  ) {}

  private async withMeta<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const lease = await this.sessions.acquireTransferChannel(this.sessionId);
    try {
      const result = await withTimeout(fn(lease.sftp), META_TIMEOUT_MS);
      lease.release();
      return result;
    } catch (err) {
      // Never return a channel with an outstanding/timed-out request to the pool.
      lease.release(true);
      throw err;
    }
  }

  statOrNull(p: string): Promise<EndpointStat | null> {
    return this.withMeta(
      (sftp) =>
        new Promise((resolve, reject) => {
          sftp.lstat(p, (err, stats) => {
            if (err) return (err as { code?: number }).code === 2 ? resolve(null) : reject(err);
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
        new Promise((resolve, reject) => {
          sftp.readdir(dir, (err, entries) => {
            if (err) return (err as { code?: number }).code === 2 ? resolve([]) : reject(err);
            resolve(entries.map((e) => e.filename));
          });
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

  async createReadStream(p: string, options: ReadOptions = {}): Promise<Readable> {
    options.signal?.throwIfAborted();
    const lease = await this.sessions.acquireTransferChannel(this.sessionId);
    try {
      const stream = await createPipelinedReadStream(lease.sftp, p, { start: options.start, end: options.end });
      let released = false;
      const finish = (broken: boolean): void => {
        if (released) return;
        released = true;
        options.signal?.removeEventListener("abort", abort);
        lease.release(broken);
      };
      const abort = (): void => {
        finish(true);
        stream.destroy(new Error("Transfer interrupted"));
      };
      stream.once("close", () => finish(!stream.completed));
      stream.once("error", () => finish(true));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      return stream;
    } catch (err) {
      lease.release(true);
      throw err;
    }
  }

  async createWriteStream(p: string, mode?: number, options: WriteOptions = {}): Promise<TransferWriteStream> {
    options.signal?.throwIfAborted();
    const lease = await this.sessions.acquireTransferChannel(this.sessionId);
    try {
      const stream = await createPipelinedWriteStream(lease.sftp, p, mode, { start: options.start, meta: options.meta });
      let released = false;
      const finish = (broken: boolean): void => {
        if (released) return;
        released = true;
        options.signal?.removeEventListener("abort", abort);
        lease.release(broken);
      };
      const abort = (): void => {
        finish(true);
        stream.destroy(new Error("Transfer interrupted"));
      };
      // The write only counts once CLOSE is acknowledged (late quota/disk errors).
      stream.once("close", () => finish(!stream.committed));
      stream.once("error", () => finish(true));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      return stream;
    } catch (err) {
      lease.release(true);
      throw err;
    }
  }

  setMeta(p: string, meta: { mtimeMs: number; mode?: number }): Promise<void> {
    return this.withMeta(async (sftp) => {
      const t = Math.floor(meta.mtimeMs / 1000);
      const requests: Promise<void>[] = [
        new Promise<void>((resolve, reject) => sftp.utimes(p, t, t, (err) => (err ? reject(err) : resolve()))),
      ];
      if (meta.mode != null) {
        requests.push(
          new Promise<void>((resolve, reject) => sftp.chmod(p, meta.mode! & 0o7777, (err) => (err ? reject(err) : resolve()))),
        );
      }
      await Promise.all(requests);
    });
  }

  renameReplacing(from: string, to: string): Promise<void> {
    return this.withMeta(async (sftp) => {
      try {
        await new Promise<void>((resolve, reject) =>
          sftp.ext_openssh_rename(from, to, (err) => (err ? reject(err) : resolve())),
        );
      } catch (err) {
        // Standard rename is safe for new files. Never unlink an existing file
        // to work around a server lacking atomic replacement support.
        if ((err as { code?: number }).code !== 8 && !/unsupported|not support/i.test((err as Error).message)) throw err;
        await new Promise<void>((resolve, reject) => sftp.rename(from, to, (error) => (error ? reject(error) : resolve())));
      }
    });
  }

  removeFile(p: string): Promise<void> {
    return this.withMeta(
      (sftp) =>
        new Promise<void>((resolve, reject) =>
          sftp.unlink(p, (err) => (!err || (err as { code?: number }).code === 2 ? resolve() : reject(err))),
        ),
    );
  }

  dispose(): void {
    // Each operation releases its own lease.
  }
}

// --- ftp / explicit ftps ----------------------------------------------------

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
  constructor(
    private sessions: SessionManager,
    private sessionId: string,
  ) {}

  private async withMeta<T>(fn: (client: FtpClient) => Promise<T>): Promise<T> {
    const lease = await this.sessions.acquireFtpClient(this.sessionId);
    try {
      const result = await withTimeout(fn(lease.client), META_TIMEOUT_MS);
      lease.release();
      return result;
    } catch (err) {
      lease.release(true);
      throw err;
    }
  }

  async statOrNull(p: string): Promise<EndpointStat | null> {
    checkFtpPath(p);
    if (p === "/") return { size: 0, mtimeMs: 0, mode: 0o040755, isDir: true, isSymlink: false };
    const slash = p.lastIndexOf("/");
    const parent = slash <= 0 ? "/" : p.slice(0, slash);
    const name = p.slice(slash + 1);
    return this.withMeta(async (ftp) => {
      const info = (await ftp.list(parent)).find((entry) => entry.name === name);
      return info ? ftpEndpointStat(info) : null;
    });
  }

  fileVersion(p: string): Promise<{ size: number; mtimeMs: number }> {
    checkFtpPath(p);
    return this.withMeta(async (ftp) => {
      try {
        return { size: await ftp.size(p), mtimeMs: (await ftp.lastMod(p)).getTime() };
      } catch (err) {
        if (![500, 502, 504].includes(Number((err as { code?: number }).code))) throw err;
        const slash = p.lastIndexOf("/");
        const info = (await ftp.list(p.slice(0, slash) || "/")).find((entry) => entry.name === p.slice(slash + 1));
        if (!info) throw new Error(`Source disappeared: ${p}`);
        return { size: info.size, mtimeMs: info.modifiedAt?.getTime() ?? 0 };
      }
    });
  }

  fileSize(p: string): Promise<number> {
    checkFtpPath(p);
    return this.withMeta(async (ftp) => {
      try {
        return await ftp.size(p);
      } catch (err) {
        if (![500, 502, 504].includes(Number((err as { code?: number }).code))) throw err;
        const slash = p.lastIndexOf("/");
        const info = (await ftp.list(p.slice(0, slash) || "/")).find((entry) => entry.name === p.slice(slash + 1));
        if (!info) throw new Error(`Staged file disappeared: ${p}`);
        return info.size;
      }
    });
  }

  listNames(dir: string): Promise<string[]> {
    checkFtpPath(dir);
    return this.withMeta(async (ftp) => {
      return (await ftp.list(dir)).map((entry) => entry.name);
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

  async createReadStream(p: string, options: ReadOptions = {}): Promise<Readable> {
    checkFtpPath(p);
    const lease = await this.sessions.acquireFtpClient(this.sessionId);
    if (options.signal?.aborted) {
      lease.release();
      options.signal.throwIfAborted();
    }
    // Data EOF is not success: wait for the FTP control connection's final reply.
    const output = new PassThrough();
    let settled = false;
    const sink = new Writable({
      write(chunk, encoding, callback) {
        if (output.write(chunk, encoding)) callback();
        else output.once("drain", callback);
      },
    });
    sink.on("error", () => {});
    const abort = (): void => {
      output.destroy(new Error("Transfer interrupted"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    output.on("error", () => {});
    output.once("close", () => {
      options.signal?.removeEventListener("abort", abort);
      if (!settled) {
        lease.release(true);
        sink.destroy();
      }
    });
    void lease.client.downloadTo(sink, p, options.start ?? 0).then(
      () => {
        settled = true;
        lease.release();
        output.end();
      },
      (err) => {
        settled = true;
        lease.release(true);
        output.destroy(err as Error);
      },
    );
    return output;
  }

  async createWriteStream(p: string, _mode?: number, options: WriteOptions = {}): Promise<Writable> {
    checkFtpPath(p);
    const lease = await this.sessions.acquireFtpClient(this.sessionId);
    if (options.signal?.aborted) {
      lease.release();
      options.signal.throwIfAborted();
    }
    const input = new PassThrough();
    input.on("error", () => {});
    let settled = false;
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
        if (!settled) lease.release(true);
        input.destroy();
        callback(err);
      },
    });
    const abort = (): void => {
      output.destroy(new Error("Transfer interrupted"));
    };
    output.on("error", () => {});
    options.signal?.addEventListener("abort", abort, { once: true });
    output.once("close", () => options.signal?.removeEventListener("abort", abort));
    void uploaded.then(
      () => {
        settled = true;
        lease.release();
      },
      (err) => {
        settled = true;
        lease.release(true);
        output.destroy(err as Error);
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
      // Let the server replace with RNTO; never delete the original first.
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
    // Each operation releases its own lease.
  }
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
