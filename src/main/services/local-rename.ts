import type { Stats } from "fs";
import { basename } from "path";
import { promises as fs } from "fs";

type FileIdentity = Pick<Stats, "dev" | "ino">;

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

function eexist(p: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`"${basename(p)}" already exists`);
  err.code = "EEXIST";
  return err;
}

/**
 * A destination may be replaced only when nothing is there, or when it is the
 * same file as the source. A case-only rename on a case-insensitive volume
 * resolves both names to one inode; on a case-sensitive volume they are two
 * different files and the destination must not be replaced.
 */
export function mayReplaceDestination(from: FileIdentity | null, to: FileIdentity | null): boolean {
  if (to === null) return true;
  return from !== null && from.dev === to.dev && from.ino === to.ino;
}

/**
 * Rename within a directory. Never overwrites: macOS `rename(2)` replaces an
 * existing destination silently, so existence is checked first. A case-only
 * rename is allowed only when both names resolve to the same file, which is
 * how it behaves on APFS's case-insensitive default; on a case-sensitive
 * volume the two names are different files.
 */
export async function rename(from: string, to: string): Promise<void> {
  const [fromStat, toStat] = await Promise.all([lstatOrNull(from), lstatOrNull(to)]);
  if (!mayReplaceDestination(fromStat, toStat)) throw eexist(to);
  await fs.rename(from, to);
}
