/**
 * Filesystem shapes shared across main, preload, and renderer — the same
 * types describe a local directory and a remote one, which is what lets a
 * pane switch backends without the UI knowing.
 *
 * This file must stay dependency-free: no Node imports, no Electron imports.
 */

export type EntryKind = "file" | "dir" | "symlink";

export interface Entry {
  name: string;
  /** Absolute path (local: platform path; remote: POSIX path). */
  path: string;
  kind: EntryKind;
  /** For symlinks: what the target is, so the UI knows whether to descend. */
  targetKind?: "file" | "dir" | "unknown";
  size: number;
  mtimeMs: number;
  /** POSIX mode bits (permissions only meaningful where the backend provides them). */
  mode: number;
  /** Dotfile or otherwise hidden by platform convention. */
  hidden: boolean;
}

export interface DirListing {
  path: string;
  entries: Entry[];
  /** Bytes available on the containing filesystem, when known. */
  availBytes: number | null;
}

export interface VolumeInfo {
  name: string;
  path: string;
  /** True for the boot volume ("/"). */
  isRoot: boolean;
}

export interface KnownFolders {
  home: string;
  desktop: string;
  documents: string;
  downloads: string;
  movies: string;
  music: string;
  pictures: string;
}

/** Which filesystem a folder-size request refers to. */
export type SizeTarget = { kind: "local" } | { kind: "sftp"; sessionId: string };

export type SortKey = "name" | "size" | "mtime";
export type SortDir = "asc" | "desc";

/** Raw bytes for an inspector preview; the renderer decides text vs image. */
export interface PreviewData {
  base64: string;
  totalSize: number;
  truncated: boolean;
}
