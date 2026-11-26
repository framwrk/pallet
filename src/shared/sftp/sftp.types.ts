export type AuthSpec =
  | { method: "password"; password: string }
  | { method: "key"; keyPath: string; passphrase?: string }
  | { method: "agent" }
  /** S3 keeps the access key id in the nonsecret principal field (username). */
  | { method: "s3"; secretAccessKey: string; sessionToken?: string };

/** Remote connection protocol. Missing values from older callers mean SFTP. */
export type ConnectionProtocol = "sftp" | "ftp" | "ftps" | "ftps-implicit" | "s3" | "smb" | "webdav" | "webdavs";

/** S3 connection settings; one connection is scoped to one bucket and prefix. */
/** "gcs" is the Google Cloud Storage preset; absent means AWS or a generic S3-compatible endpoint. */
export type S3Provider = "s3" | "gcs";

export interface S3ConnectionOptions {
  provider?: S3Provider;
  /** Absolute http(s) origin; blank uses the AWS regional endpoint. */
  endpoint?: string;
  region: string;
  bucket: string;
  /** Addressed by host or path. Defaults on for custom endpoints. */
  forcePathStyle?: boolean;
}

/** SMB connection settings; one connection is scoped to one share. */
export interface SmbConnectionOptions {
  share: string;
  /** NTLM domain or workgroup; blank lets the server decide. */
  domain?: string;
}

/** WebDAV connection settings; the pane's "/" is the server path below. */
export interface WebDavConnectionOptions {
  /** Server path such as /remote.php/dav/files/alice; blank means the server root. */
  root?: string;
}

export interface ConnectProfile {
  protocol?: ConnectionProtocol;
  host: string;
  port: number;
  username: string;
  auth: AuthSpec;
  /** Present when protocol is "s3". */
  s3?: S3ConnectionOptions;
  /** Present when protocol is "smb". */
  smb?: SmbConnectionOptions;
  /** Present when protocol is "webdav" or "webdavs". */
  webdav?: WebDavConnectionOptions;
  /** Initial remote directory; empty means the server-side home. */
  remotePath?: string;
  keepaliveIntervalMs?: number;
  /** Negotiate zlib compression — worth it on slow links, a cost on fast ones. */
  compression?: boolean;
  /** Max concurrent transfer channels for this session (1–8). */
  concurrency?: number;
  /** Whether FTPS and WebDAVS validate the server certificate. Defaults to true. */
  tlsRejectUnauthorized?: boolean;
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
