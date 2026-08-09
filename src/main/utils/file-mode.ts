/**
 * POSIX `st_mode` file-type bits, which arrive identically from `fs.Stats`
 * and from an SFTP server's attrs — the protocol carries the same encoding.
 */
import type { Entry } from "@shared/fs/fs.types";

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

export function isDirMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR;
}

export function isSymlinkMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFLNK;
}

/** Symlink wins over directory: the link itself is what was listed. */
export function kindFromMode(mode: number): Entry["kind"] {
  if (isSymlinkMode(mode)) return "symlink";
  if (isDirMode(mode)) return "dir";
  return "file";
}
