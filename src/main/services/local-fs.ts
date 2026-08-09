import type { DirListing, Entry, KnownFolders, VolumeInfo } from "@shared/fs/fs.types";
import { type Dirent, type Stats, promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { mapLimit } from "../utils/concurrency";

const STAT_CONCURRENCY = 64;

function entryFromStats(name: string, path: string, dirent: Dirent, stats: Stats | null): Entry {
  const isLink = dirent.isSymbolicLink();
  const kind: Entry["kind"] = isLink ? "symlink" : dirent.isDirectory() ? "dir" : "file";
  let targetKind: Entry["targetKind"];
  if (isLink) {
    targetKind = stats == null ? "unknown" : stats.isDirectory() ? "dir" : "file";
  }
  // For symlinks, stats (when resolvable) describe the target, which is what
  // the UI wants for size/mtime; a broken link falls back to zeros.
  return {
    name,
    path,
    kind,
    ...(isLink ? { targetKind } : {}),
    size: stats?.size ?? 0,
    mtimeMs: stats?.mtimeMs ?? 0,
    mode: stats?.mode ?? 0,
    hidden: name.startsWith("."),
  };
}

export async function listDir(dirPath: string): Promise<DirListing> {
  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries = await mapLimit(dirents, STAT_CONCURRENCY, async (d) => {
    const full = join(dirPath, d.name);
    let stats: Stats | null = null;
    try {
      stats = await fs.stat(full);
    } catch {
      // Broken symlink or entry deleted mid-listing; fall back to lstat.
      try {
        stats = await fs.lstat(full);
      } catch {
        stats = null;
      }
    }
    return entryFromStats(d.name, full, d, stats);
  });

  let availBytes: number | null = null;
  try {
    const sfs = await fs.statfs(dirPath);
    availBytes = Number(sfs.bavail) * Number(sfs.bsize);
  } catch {
    availBytes = null;
  }

  return { path: dirPath, entries, availBytes };
}

export async function statEntry(p: string): Promise<Entry> {
  const lstats = await fs.lstat(p);
  const isLink = lstats.isSymbolicLink();
  let stats: Stats = lstats;
  let targetKind: Entry["targetKind"];
  if (isLink) {
    try {
      stats = await fs.stat(p);
      targetKind = stats.isDirectory() ? "dir" : "file";
    } catch {
      targetKind = "unknown";
    }
  }
  const name = p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1);
  return {
    name,
    path: p,
    kind: isLink ? "symlink" : stats.isDirectory() ? "dir" : "file",
    ...(isLink ? { targetKind } : {}),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode,
    hidden: name.startsWith("."),
  };
}

/** Read up to maxBytes for inspector previews. */
export async function readBytes(p: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(p, "r");
  try {
    const { size } = await handle.stat();
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    await handle.read(buf, 0, buf.length, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

export function homeDir(): string {
  return homedir();
}

export function knownFolders(): KnownFolders {
  const home = homedir();
  return {
    home,
    desktop: join(home, "Desktop"),
    documents: join(home, "Documents"),
    downloads: join(home, "Downloads"),
  };
}

export async function volumes(): Promise<VolumeInfo[]> {
  const out: VolumeInfo[] = [];
  let names: string[] = [];
  try {
    names = await fs.readdir("/Volumes");
  } catch {
    names = [];
  }
  // /Volumes contains a symlink to "/" for the boot volume; use it for the
  // user-visible boot volume name and point it at "/".
  for (const name of names.filter((n) => !n.startsWith(".")).sort()) {
    const p = join("/Volumes", name);
    try {
      const link = await fs.readlink(p).catch(() => null);
      if (link === "/") {
        out.unshift({ name, path: "/", isRoot: true });
      } else {
        await fs.access(p);
        out.push({ name, path: p, isRoot: false });
      }
    } catch {
      // Unreadable volume (e.g. Time Machine snapshot mid-unmount); skip.
    }
  }
  if (!out.some((v) => v.isRoot)) {
    out.unshift({ name: "Macintosh HD", path: "/", isRoot: true });
  }
  return out;
}
