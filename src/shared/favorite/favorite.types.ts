import type { ConnectionProtocol } from "../sftp/sftp.types";

export type ColorLabel = "none" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface Favorite {
  id: string;
  name: string;
  protocol: ConnectionProtocol;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent" | "s3";
  /** True when an encrypted secret exists for this favorite (never the secret itself). */
  secretStored: boolean;
  privateKeyPath?: string;
  /** Whether FTPS and WebDAVS reject untrusted TLS certificates. Defaults to true. */
  tlsRejectUnauthorized?: boolean;
  /** S3 only: custom endpoint origin, region, bucket, and addressing style. */
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3ForcePathStyle?: boolean;
  /** SMB only: share name and optional NTLM domain or workgroup. */
  smbShare?: string;
  smbDomain?: string;
  /** WebDAV only: server path the connection treats as its root. */
  webdavRoot?: string;
  /** Initial remote directory; for S3 the starting key prefix. */
  remotePath?: string;
  localPath?: string;
  note?: string;
  colorLabel: ColorLabel;
  sortOrder: number;
  createdAt: number;
  lastUsedAt?: number;
}

/** S3 secret payload: both values stay in the single encrypted blob. */
export interface S3FavoriteSecret {
  secretAccessKey: string;
  sessionToken?: string;
}

/** undefined = keep, null = clear, string = password/passphrase, object = S3. */
export type FavoriteSecret = string | S3FavoriteSecret;

/** Renderer → main favorite payload; id absent means create. */
export interface FavoriteInput {
  id?: string;
  name: string;
  protocol: ConnectionProtocol;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent" | "s3";
  privateKeyPath?: string;
  tlsRejectUnauthorized?: boolean;
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3ForcePathStyle?: boolean;
  smbShare?: string;
  smbDomain?: string;
  webdavRoot?: string;
  remotePath?: string;
  localPath?: string;
  note?: string;
  colorLabel: ColorLabel;
}
