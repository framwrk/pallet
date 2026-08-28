/**
 * Read-side SFTP operations over a session's browse channel (M3).
 * Electron-free so the Docker integration tests can exercise it directly.
 */
import type { DirListing, Entry } from "@shared/fs/fs.types";
import { type FileInfo, FileType, type Client as FtpClient } from "basic-ftp";
import { isDirMode, kindFromMode } from "../../utils/file-mode";
import { PassThrough } from "stream";
import type { SFTPWrapper } from "ssh2";
import type { SessionManager } from "./session-manager";
import { mapLimit } from "../../utils/concurrency";

const SYMLINK_STAT_CONCURRENCY = 8;

function joinRemote(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function ftpMode(info: FileInfo): number {
  const type = info.type === FileType.Directory ? 0o040000 : info.type === FileType.SymbolicLink ? 0o120000 : 0o100000;
  const p = info.permissions;
  return type | (p ? (p.user << 6) | (p.group << 3) | p.world : info.isDirectory ? 0o755 : 0o644);
}

function ftpEntry(dir: string, info: FileInfo): Entry {
  const mode = ftpMode(info);
  const kind = kindFromMode(mode);
  return {
    name: info.name,
    path: joinRemote(dir, info.name),
    kind,
    ...(kind === "symlink" ? { targetKind: "unknown" as const } : {}),
    size: info.size ?? 0,
    mtimeMs: info.modifiedAt?.getTime() ?? 0,
    mode,
    hidden: info.name.startsWith("."),
  };
}

function assertSafeFtpPath(path: string): void {
  if (/[\r\n]/.test(path)) throw new Error("Invalid FTP path");
}

export class SftpService {
  private ftpTails = new Map<string, Promise<void>>();

  constructor(private sessions: SessionManager) {}

  private sftp(sessionId: string): SFTPWrapper {
    return this.sessions.browseChannel(sessionId);
  }

  private withFtp<T>(sessionId: string, fn: (client: FtpClient) => Promise<T>): Promise<T> {
    const previous = this.ftpTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => fn(this.sessions.browseFtpClient(sessionId)));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.ftpTails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.ftpTails.get(sessionId) === tail) this.ftpTails.delete(sessionId);
    });
    return operation;
  }

  async list(sessionId: string, dirPath: string): Promise<DirListing> {
    if (this.sessions.protocol(sessionId) !== "sftp") {
      assertSafeFtpPath(dirPath);
      const entries = await this.withFtp(sessionId, (ftp) => ftp.list(dirPath));
      return { path: dirPath, entries: entries.map((entry) => ftpEntry(dirPath, entry)), availBytes: null };
    }
    const sftp = this.sftp(sessionId);
    const raw = await new Promise<{ filename: string; attrs: { size: number; mtime: number; mode: number } }[]>(
      (resolve, reject) => sftp.readdir(dirPath, (err, entries) => (err ? reject(err) : resolve(entries))),
    );

    const entries: Entry[] = raw.map((r) => {
      const kind = kindFromMode(r.attrs.mode);
      return {
        name: r.filename,
        path: joinRemote(dirPath, r.filename),
        kind,
        ...(kind === "symlink" ? { targetKind: "unknown" as const } : {}),
        size: r.attrs.size ?? 0,
        mtimeMs: (r.attrs.mtime ?? 0) * 1000,
        mode: r.attrs.mode ?? 0,
        hidden: r.filename.startsWith("."),
      };
    });

    // Resolve what symlinks point at (bounded), so the UI knows to descend.
    const links = entries.filter((e) => e.kind === "symlink");
    await mapLimit(links, SYMLINK_STAT_CONCURRENCY, async (entry) => {
      try {
        const stats = await this.statRaw(sftp, entry.path);
        entry.targetKind = kindFromMode(stats.mode) === "dir" ? "dir" : "file";
        entry.size = stats.size;
        entry.mtimeMs = stats.mtime * 1000;
      } catch {
        entry.targetKind = "unknown";
      }
    });

    return { path: dirPath, entries, availBytes: null };
  }

  private statRaw(sftp: SFTPWrapper, p: string): Promise<{ size: number; mtime: number; mode: number }> {
    return new Promise((resolve, reject) => sftp.stat(p, (err, stats) => (err ? reject(err) : resolve(stats))));
  }

  async stat(sessionId: string, p: string): Promise<Entry> {
    if (this.sessions.protocol(sessionId) !== "sftp") {
      assertSafeFtpPath(p);
      if (p === "/") {
        return { name: "/", path: "/", kind: "dir", size: 0, mtimeMs: 0, mode: 0o040755, hidden: false };
      }
      const slash = p.lastIndexOf("/");
      const parent = slash <= 0 ? "/" : p.slice(0, slash);
      const name = p.slice(slash + 1);
      const found = await this.withFtp(sessionId, async (ftp) => (await ftp.list(parent)).find((entry) => entry.name === name));
      if (!found) {
        const err: NodeJS.ErrnoException = new Error(`Remote path not found: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      return ftpEntry(parent, found);
    }
    const sftp = this.sftp(sessionId);
    const lstats = await new Promise<{ size: number; mtime: number; mode: number }>((resolve, reject) =>
      sftp.lstat(p, (err, stats) => (err ? reject(err) : resolve(stats))),
    );
    const kind = kindFromMode(lstats.mode);
    let targetKind: Entry["targetKind"];
    let stats = lstats;
    if (kind === "symlink") {
      try {
        stats = await this.statRaw(sftp, p);
        targetKind = kindFromMode(stats.mode) === "dir" ? "dir" : "file";
      } catch {
        targetKind = "unknown";
      }
    }
    const name = p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1);
    return {
      name,
      path: p,
      kind,
      ...(kind === "symlink" ? { targetKind } : {}),
      size: stats.size ?? 0,
      mtimeMs: (stats.mtime ?? 0) * 1000,
      mode: stats.mode ?? 0,
      hidden: name.startsWith("."),
    };
  }

  realpath(sessionId: string, p: string): Promise<string> {
    if (this.sessions.protocol(sessionId) !== "sftp") {
      assertSafeFtpPath(p);
      return this.withFtp(sessionId, async (ftp) => {
        await ftp.cd(p);
        return ftp.pwd();
      });
    }
    const sftp = this.sftp(sessionId);
    return new Promise((resolve, reject) => sftp.realpath(p, (err, resolved) => (err ? reject(err) : resolve(resolved))));
  }

  // --- M6 write-side ops (browse channel; small metadata operations) -------

  mkdir(sessionId: string, p: string): Promise<void> {
    if (this.sessions.protocol(sessionId) !== "sftp") {
      assertSafeFtpPath(p);
      return this.withFtp(sessionId, (ftp) => ftp.ensureDir(p));
    }
    const sftp = this.sftp(sessionId);
    return new Promise((resolve, reject) => sftp.mkdir(p, (err) => (err ? reject(err) : resolve())));
  }

  /** Create "untitled folder" (auto-numbered) inside dirPath; returns name. */
  async mkdirUnique(sessionId: string, dirPath: string): Promise<string> {
    const listing = await this.list(sessionId, dirPath);
    const names = new Set(listing.entries.map((e) => e.name));
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? "untitled folder" : `untitled folder ${i}`;
      if (!names.has(name)) {
        await this.mkdir(sessionId, joinRemote(dirPath, name));
        return name;
      }
    }
    throw new Error("Could not find a free folder name");
  }

  /** Rename; refuses to overwrite an existing destination. */
  async rename(sessionId: string, from: string, to: string): Promise<void> {
    if (this.sessions.protocol(sessionId) !== "sftp") {
      assertSafeFtpPath(from);
      assertSafeFtpPath(to);
      try {
        await this.stat(sessionId, to);
        const err: NodeJS.ErrnoException = new Error(`"${to.slice(to.lastIndexOf("/") + 1)}" already exists`);
        err.code = "EEXIST";
        throw err;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await this.withFtp(sessionId, (ftp) => ftp.rename(from, to));
      return;
    }
    const sftp = this.sftp(sessionId);
    const exists = await new Promise<boolean>((resolve) => sftp.lstat(to, (err) => resolve(!err)));
    if (exists) {
      const err: NodeJS.ErrnoException = new Error(`"${to.slice(to.lastIndexOf("/") + 1)}" already exists`);
      err.code = "EEXIST";
      throw err;
    }
    await new Promise<void>((resolve, reject) => sftp.rename(from, to, (err) => (err ? reject(err) : resolve())));
  }

  /**
   * Recursive delete. Symlinks are unlinked, never followed (§6), so a link
   * to "/" cannot take the server down with it.
   */
  async removeRecursive(sessionId: string, p: string): Promise<void> {
    if (this.sessions.protocol(sessionId) !== "sftp") {
      assertSafeFtpPath(p);
      const entry = await this.stat(sessionId, p);
      await this.withFtp(sessionId, async (ftp) => {
        if (entry.kind === "dir") await ftp.removeDir(p);
        else await ftp.remove(p);
      });
      return;
    }
    const sftp = this.sftp(sessionId);
    const lstats = await new Promise<{ mode: number }>((resolve, reject) =>
      sftp.lstat(p, (err, stats) => (err ? reject(err) : resolve(stats))),
    );
    if (isDirMode(lstats.mode)) {
      const entries = await new Promise<{ filename: string }[]>((resolve, reject) =>
        sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list))),
      );
      for (const entry of entries) {
        await this.removeRecursive(sessionId, joinRemote(p, entry.filename));
      }
      await new Promise<void>((resolve, reject) => sftp.rmdir(p, (err) => (err ? reject(err) : resolve())));
    } else {
      await new Promise<void>((resolve, reject) => sftp.unlink(p, (err) => (err ? reject(err) : resolve())));
    }
  }

  chmod(sessionId: string, p: string, mode: number): Promise<void> {
    if (this.sessions.protocol(sessionId) !== "sftp") {
      assertSafeFtpPath(p);
      return this.withFtp(sessionId, async (ftp) => {
        await ftp.send(`SITE CHMOD ${(mode & 0o7777).toString(8)} ${p}`);
      });
    }
    const sftp = this.sftp(sessionId);
    return new Promise((resolve, reject) => sftp.chmod(p, mode & 0o7777, (err) => (err ? reject(err) : resolve())));
  }

  /** Read up to maxBytes; used for inspector previews. */
  async readBytes(sessionId: string, p: string, maxBytes: number): Promise<Buffer> {
    if (this.sessions.protocol(sessionId) !== "sftp") {
      assertSafeFtpPath(p);
      if (maxBytes <= 0) return Buffer.alloc(0);
      const lease = await this.sessions.acquireFtpClient(sessionId);
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      let total = 0;
      let reachedLimit = false;
      output.on("data", (chunk: Buffer) => {
        if (reachedLimit) return;
        const take = Math.min(chunk.length, maxBytes - total);
        if (take > 0) chunks.push(chunk.subarray(0, take));
        total += take;
        if (total >= maxBytes) {
          reachedLimit = true;
          // FTP has no portable end offset for RETR. Closing only this leased
          // client stops the data socket without dropping the browse session.
          lease.client.close();
          output.destroy();
        }
      });
      let broken = false;
      try {
        await lease.client.downloadTo(output, p);
      } catch (err) {
        if (!reachedLimit) {
          broken = true;
          throw err;
        }
      } finally {
        lease.release(broken || reachedLimit);
      }
      return Buffer.concat(chunks);
    }
    const sftp = this.sftp(sessionId);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = sftp.createReadStream(p, { autoClose: true });
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= maxBytes) {
          stream.destroy();
          resolve(Buffer.concat(chunks).subarray(0, maxBytes));
        }
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", (err: Error) => reject(err));
    });
  }
}
