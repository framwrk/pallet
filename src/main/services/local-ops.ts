import { basename, dirname, extname, join } from "path";
import { promises as fs } from "fs";
import { shell } from "electron";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function eexist(p: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`"${basename(p)}" already exists`);
  err.code = "EEXIST";
  return err;
}

/** Create "untitled folder" (or "untitled folder 2"…) and return its path. */
export async function mkdirUnique(parentDir: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? "untitled folder" : `untitled folder ${i}`;
    const p = join(parentDir, name);
    if (await exists(p)) continue;
    await fs.mkdir(p);
    return p;
  }
  throw new Error("Could not find a free folder name");
}

export async function mkdir(p: string): Promise<void> {
  await fs.mkdir(p);
}

/**
 * Rename within a directory. Never overwrites: macOS `rename(2)` replaces an
 * existing destination silently, so existence is checked first. The check is
 * skipped when only letter case changes (same file on APFS's
 * case-insensitive default).
 */
export async function rename(from: string, to: string): Promise<void> {
  const caseOnly = from.toLowerCase() === to.toLowerCase() && from !== to;
  if (!caseOnly && (await exists(to))) throw eexist(to);
  await fs.rename(from, to);
}

export async function trash(paths: string[]): Promise<void> {
  for (const p of paths) {
    await shell.trashItem(p);
  }
}

async function copyOne(src: string, destDir: string): Promise<string> {
  const dest = join(destDir, basename(src));
  if (src === dest) {
    // Finder-style duplicate: "name copy.ext", "name copy 2.ext", …
    const ext = extname(src);
    const stem = basename(src, ext);
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? `${stem} copy${ext}` : `${stem} copy ${i}${ext}`;
      const candidate = join(destDir, name);
      if (!(await exists(candidate))) {
        await fs.cp(src, candidate, { recursive: true, errorOnExist: true, force: false });
        return candidate;
      }
    }
    throw new Error("Could not find a free name for the copy");
  }
  if (await exists(dest)) throw eexist(dest);
  await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
  return dest;
}

/** Copy each source into destDir. Returns created paths. Never overwrites. */
export async function copyMany(sources: string[], destDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const src of sources) {
    out.push(await copyOne(src, destDir));
  }
  return out;
}

/** Move each source into destDir. Returns new paths. Never overwrites. */
export async function moveMany(sources: string[], destDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const src of sources) {
    const dest = join(destDir, basename(src));
    if (src === dest) continue;
    if (dirname(src) === destDir) continue;
    if (await exists(dest)) throw eexist(dest);
    try {
      await fs.rename(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      // Cross-volume move: copy then delete.
      await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
      await fs.rm(src, { recursive: true });
    }
    out.push(dest);
  }
  return out;
}

export function revealInFinder(p: string): void {
  shell.showItemInFolder(p);
}

export async function openWithDefault(p: string): Promise<void> {
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
}
