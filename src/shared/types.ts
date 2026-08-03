/**
 * Types shared across main, preload, and renderer.
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
}

/** Serializable error envelope crossing the IPC boundary. */
export interface IpcError {
  code: string;
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export type SortKey = "name" | "size" | "mtime";
export type SortDir = "asc" | "desc";

export interface ContextMenuItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  type?: "separator";
}

// --- SFTP ------------------------------------------------------------------

export type AuthSpec = { method: "password"; password: string } | { method: "key"; keyPath: string; passphrase?: string };

export interface ConnectProfile {
  host: string;
  port: number;
  username: string;
  auth: AuthSpec;
  /** Initial remote directory; empty means the server-side home. */
  remotePath?: string;
  keepaliveIntervalMs?: number;
  /** Negotiate zlib compression — worth it on slow links, a cost on fast ones. */
  compression?: boolean;
  /** Max concurrent transfer channels for this session (1–8). */
  concurrency?: number;
}

export type SessionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  /** Human-readable reason, present for disconnected/reconnecting. */
  detail?: string;
}

export interface ConnectResult {
  sessionId: string;
  /** Resolved initial directory (realpath of remotePath or home). */
  initialPath: string;
}

// --- Favorites -------------------------------------------------------------

export type ColorLabel = "none" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface Favorite {
  id: string;
  name: string;
  protocol: "sftp";
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  /** True when an encrypted secret exists for this favorite (never the secret itself). */
  secretStored: boolean;
  privateKeyPath?: string;
  remotePath?: string;
  localPath?: string;
  note?: string;
  colorLabel: ColorLabel;
  sortOrder: number;
  createdAt: number;
  lastUsedAt?: number;
}

/** Renderer → main favorite payload; id absent means create. */
export interface FavoriteInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  privateKeyPath?: string;
  remotePath?: string;
  localPath?: string;
  note?: string;
  colorLabel: ColorLabel;
}

/** Raw bytes for an inspector preview; the renderer decides text vs image. */
export interface PreviewData {
  base64: string;
  totalSize: number;
  truncated: boolean;
}

export interface EditEventPayload {
  kind: "uploaded" | "error";
  remotePath: string;
  localPath: string;
  message?: string;
}

/** Host-key verification request pushed to the renderer (TOFU flow). */
export interface HostKeyPrompt {
  requestId: string;
  host: string;
  port: number;
  keyType: string;
  /** e.g. "SHA256:mri…" */
  fingerprint: string;
  /** 'new' = first contact; 'mismatch' = stored fingerprint differs. */
  status: "new" | "mismatch";
  knownFingerprint?: string;
}
