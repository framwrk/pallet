/**
 * SSH/SFTP session shapes shared across main, preload, and renderer.
 *
 * This file must stay dependency-free: no Node imports, no Electron imports.
 */

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
