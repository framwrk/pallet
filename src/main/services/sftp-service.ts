/**
 * Read-side SFTP operations over a session's browse channel (M3).
 * Electron-free so the Docker integration tests can exercise it directly.
 */
import type { DirListing, Entry } from "../../shared/types";
import type { SFTPWrapper } from "ssh2";
import type { SessionManager } from "./session-manager";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const SYMLINK_STAT_CONCURRENCY = 8;

function joinRemote(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function kindFromMode(mode: number): Entry["kind"] {
  const fmt = mode & S_IFMT;
  if (fmt === S_IFLNK) return "symlink";
  if (fmt === S_IFDIR) return "dir";
  return "file";
}

export class SftpService {
  constructor(private sessions: SessionManager) {}

  private sftp(sessionId: string): SFTPWrapper {
    return this.sessions.browseChannel(sessionId);
  }

  async list(sessionId: string, dirPath: string): Promise<DirListing> {
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
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < links.length) {
        const entry = links[next++];
        try {
          const stats = await this.statRaw(sftp, entry.path);
          entry.targetKind = kindFromMode(stats.mode) === "dir" ? "dir" : "file";
          entry.size = stats.size;
          entry.mtimeMs = stats.mtime * 1000;
        } catch {
          entry.targetKind = "unknown";
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SYMLINK_STAT_CONCURRENCY, links.length) }, worker));

    return { path: dirPath, entries, availBytes: null };
  }

  private statRaw(sftp: SFTPWrapper, p: string): Promise<{ size: number; mtime: number; mode: number }> {
    return new Promise((resolve, reject) => sftp.stat(p, (err, stats) => (err ? reject(err) : resolve(stats))));
  }

  async stat(sessionId: string, p: string): Promise<Entry> {
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
    const sftp = this.sftp(sessionId);
    return new Promise((resolve, reject) => sftp.realpath(p, (err, resolved) => (err ? reject(err) : resolve(resolved))));
  }

  // --- M6 write-side ops (browse channel; small metadata operations) -------

  mkdir(sessionId: string, p: string): Promise<void> {
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
    const sftp = this.sftp(sessionId);
    const lstats = await new Promise<{ mode: number }>((resolve, reject) =>
      sftp.lstat(p, (err, stats) => (err ? reject(err) : resolve(stats))),
    );
    const fmt = lstats.mode & S_IFMT;
    if (fmt === S_IFDIR) {
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
    const sftp = this.sftp(sessionId);
    return new Promise((resolve, reject) => sftp.chmod(p, mode & 0o7777, (err) => (err ? reject(err) : resolve())));
  }

  /** Read up to maxBytes; used for inspector previews. */
  async readBytes(sessionId: string, p: string, maxBytes: number): Promise<Buffer> {
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
