/**
 * Recursive folder sizes for the "Calculate folder sizes" preference.
 *
 * Totals are *apparent bytes* — the sum of the sizes of the files inside —
 * not disk usage, so a folder's size is comparable to the file sizes shown
 * next to it and reads the same locally and remotely. Symlinks are counted at
 * their own size and never followed, matching `du` and keeping a link to "/"
 * from turning one folder into a walk of the whole filesystem.
 *
 * Remote sizing prefers `du -sb`, which is one round trip. That flag is GNU's;
 * on a server without it (macOS, BSD, BusyBox) the probe fails once and the
 * session falls back to an SFTP walk for good. The walk is still only one
 * round trip per *directory*, because readdir already carries each child's
 * size and mode.
 */
import { type Dirent, promises as fs } from "fs";
import type { SFTPWrapper } from "ssh2";
import type { SessionManager } from "./sftp/session-manager";
import type { SizeTarget } from "@shared/fs/fs.types";
import { isDirMode } from "../utils/file-mode";
import { join } from "path";
import { mapLimit } from "../utils/concurrency";
import { remotePath } from "@shared/path/path.utils";

/** Directories read in parallel during a local walk. */
const LOCAL_WALK_CONCURRENCY = 32;

/** Local walks that may run at once, across every pane and the inspector. */
const LOCAL_JOBS = 4;

/**
 * Remote sizing jobs per session — deliberately one. A session already holds
 * the browse channel plus up to MAX_CONCURRENCY + 1 transfer channels, which
 * at the top of the range is 9 of OpenSSH's default MaxSessions of 10. One
 * more is all that fits, whether it is an exec channel or a leased walk.
 */
const REMOTE_JOBS_PER_SESSION = 1;

function cacheKey(target: SizeTarget, path: string): string {
  return target.kind === "local" ? `local\0${path}` : `${target.sessionId}\0${path}`;
}

/** Single-quote for /bin/sh, closing and reopening around embedded quotes. */
function shellQuote(p: string): string {
  return `'${p.replaceAll("'", `'\\''`)}'`;
}

/** Runs jobs up to a limit, dropping any that were cancelled while queued. */
class Gate {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>, cancelled: () => boolean): Promise<T | null> {
    let waited = false;
    if (this.active >= this.limit) {
      waited = true;
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    // Checked after the wait, not before: the point of the queue is that a
    // folder scrolled out of view never starts walking at all.
    if (cancelled()) {
      // Hand the slot on only if one was held; releasing a waiter without one
      // would put an extra job over the limit.
      if (waited) this.next();
      return null;
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.next();
    }
  }

  private next(): void {
    this.queue.shift()?.();
  }
}

async function walkLocal(root: string): Promise<number> {
  let total = 0;
  let level = [root];
  while (level.length > 0) {
    const next: string[] = [];
    // Each directory returns its own subtotal. Accumulating into a shared
    // `total` here would lose updates: `total += await …` reads total before
    // it suspends, so concurrent directories overwrite each other.
    const subtotals = await mapLimit(level, LOCAL_WALK_CONCURRENCY, async (dir): Promise<number> => {
      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // Unreadable subtree (permissions, or deleted mid-walk): contributes
        // nothing rather than failing the whole total.
        return 0;
      }
      let subtotal = 0;
      for (const dirent of dirents) {
        const full = join(dir, dirent.name);
        // Dirent types come from lstat, so a symlink to a directory is not a
        // directory here and is never descended into.
        if (dirent.isDirectory()) {
          next.push(full);
          continue;
        }
        try {
          const { size } = await fs.lstat(full);
          subtotal += size;
        } catch {
          // Vanished between readdir and lstat.
        }
      }
      return subtotal;
    });
    for (const subtotal of subtotals) total += subtotal;
    level = next;
  }
  return total;
}

/** Returns the total, or null if this server's `du` has no -b. */
async function tryDu(sessions: SessionManager, sessionId: string, path: string): Promise<number | null> {
  const { stdout } = await sessions.exec(sessionId, `du -sb -- ${shellQuote(path)}`);
  const match = /^\s*(\d+)/.exec(stdout);
  // A nonzero exit is fine on its own: GNU du reports unreadable subdirectories
  // that way and still prints the total for everything it could reach. Only a
  // missing number means the flag was rejected.
  return match ? Number(match[1]) : null;
}

function readdirRemote(sftp: SFTPWrapper, dir: string): Promise<{ filename: string; attrs: { size: number; mode: number } }[]> {
  return new Promise((resolve, reject) => sftp.readdir(dir, (err, list) => (err ? reject(err) : resolve(list))));
}

async function walkRemote(sessions: SessionManager, sessionId: string, root: string): Promise<number> {
  const { sftp, release } = await sessions.acquireTransferChannel(sessionId);
  let broken = false;
  try {
    let total = 0;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let list: { filename: string; attrs: { size: number; mode: number } }[];
      try {
        list = await readdirRemote(sftp, dir);
      } catch {
        continue; // Unreadable subtree, as above.
      }
      for (const child of list) {
        const full = remotePath.join(dir, child.filename);
        if (isDirMode(child.attrs.mode ?? 0)) stack.push(full);
        else total += child.attrs.size ?? 0;
      }
    }
    return total;
  } catch (err) {
    broken = true;
    throw err;
  } finally {
    release(broken);
  }
}

export class FolderSizes {
  private cache = new Map<string, number>();
  private inflight = new Map<string, Promise<number | null>>();
  /** Keys the renderer still wants; a cancel removes one before it starts. */
  private wanted = new Set<string>();
  private localGate = new Gate(LOCAL_JOBS);
  private remoteGates = new Map<string, Gate>();

  constructor(private sessions: SessionManager) {}

  private remoteGate(sessionId: string): Gate {
    let gate = this.remoteGates.get(sessionId);
    if (!gate) {
      gate = new Gate(REMOTE_JOBS_PER_SESSION);
      this.remoteGates.set(sessionId, gate);
    }
    return gate;
  }

  /**
   * Total bytes under `path`, from cache when possible. Resolves null when the
   * request was cancelled before it started.
   */
  get(target: SizeTarget, path: string): Promise<number | null> {
    const key = cacheKey(target, path);
    const cached = this.cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const existing = this.inflight.get(key);
    if (existing) {
      this.wanted.add(key);
      return existing;
    }

    this.wanted.add(key);
    const cancelled = (): boolean => !this.wanted.has(key);
    const gate = target.kind === "local" ? this.localGate : this.remoteGate(target.sessionId);
    const job = gate
      .run(() => this.compute(target, path), cancelled)
      .then((total) => {
        if (total !== null) this.cache.set(key, total);
        return total;
      })
      .finally(() => {
        this.inflight.delete(key);
        this.wanted.delete(key);
      });
    this.inflight.set(key, job);
    return job;
  }

  private async compute(target: SizeTarget, path: string): Promise<number> {
    if (target.kind === "local") return walkLocal(path);
    const { sessionId } = target;
    if (this.sessions.duApparentBytes(sessionId) !== false) {
      const total = await tryDu(this.sessions, sessionId, path);
      this.sessions.setDuApparentBytes(sessionId, total !== null);
      if (total !== null) return total;
    }
    return walkRemote(this.sessions, sessionId, path);
  }

  /** Drop a queued request; work already started still finishes and caches. */
  cancel(target: SizeTarget, path: string): void {
    this.wanted.delete(cacheKey(target, path));
  }

  /** Forget cached totals for `path` and everything under it. */
  invalidate(target: SizeTarget, path: string): void {
    const self = cacheKey(target, path);
    // At the root the key already ends in "/", and every key in that scope
    // sits under it.
    const under = self.endsWith("/") ? self : `${self}/`;
    for (const key of this.cache.keys()) {
      if (key === self || key.startsWith(under)) this.cache.delete(key);
    }
  }

  /** Forget everything for a session, on disconnect or a dropped connection. */
  forgetSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
    this.remoteGates.delete(sessionId);
  }
}
