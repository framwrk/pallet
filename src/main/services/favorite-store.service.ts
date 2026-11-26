import type { ColorLabel, Favorite, FavoriteInput, FavoriteSecret } from "@shared/favorite/favorite.types";
import { GCS_ENDPOINT, GCS_REGION, isWebDav } from "@shared/sftp/sftp.utils";
import { deleteSecret, storeSecret } from "./secrets";
import { getDb } from "./database";
import { randomUUID } from "crypto";
import { serializeS3Secret } from "./s3/s3-secret";

function invalid(message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = "EINVAL";
  return err;
}

interface Row {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  auth_method: string;
  secret_stored: number;
  private_key_path: string | null;
  tls_reject_unauthorized: number;
  remote_path: string | null;
  local_path: string | null;
  note: string | null;
  color_label: string | null;
  sort_order: number;
  created_at: number;
  last_used_at: number | null;
  s3_endpoint: string | null;
  s3_region: string | null;
  s3_bucket: string | null;
  s3_force_path_style: number;
  s3_provider: string | null;
  smb_share: string | null;
  smb_domain: string | null;
  webdav_root: string | null;
}

function protocolFrom(value: string): Favorite["protocol"] {
  return value === "ftp" ||
    value === "ftps" ||
    value === "ftps-implicit" ||
    value === "s3" ||
    value === "smb" ||
    value === "webdav" ||
    value === "webdavs"
    ? value
    : "sftp";
}

function fromRow(row: Row): Favorite {
  const protocol = protocolFrom(row.protocol);
  const authMethod =
    protocol === "s3"
      ? "s3"
      : protocol === "sftp" && row.auth_method === "agent"
        ? "agent"
        : row.auth_method === "key"
          ? "key"
          : "password";
  return {
    id: row.id,
    name: row.name,
    protocol,
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod,
    secretStored: row.secret_stored === 1,
    ...(row.private_key_path ? { privateKeyPath: row.private_key_path } : {}),
    tlsRejectUnauthorized: row.tls_reject_unauthorized !== 0,
    ...(row.s3_endpoint ? { s3Endpoint: row.s3_endpoint } : {}),
    ...(row.s3_region ? { s3Region: row.s3_region } : {}),
    ...(row.s3_bucket ? { s3Bucket: row.s3_bucket } : {}),
    ...(protocol === "s3" ? { s3ForcePathStyle: row.s3_force_path_style !== 0 } : {}),
    ...(protocol === "s3" && row.s3_provider === "gcs" ? { s3Provider: "gcs" as const } : {}),
    ...(protocol === "smb" && row.smb_share ? { smbShare: row.smb_share } : {}),
    ...(protocol === "smb" && row.smb_domain ? { smbDomain: row.smb_domain } : {}),
    ...(isWebDav(protocol) && row.webdav_root ? { webdavRoot: row.webdav_root } : {}),
    ...(row.remote_path ? { remotePath: row.remote_path } : {}),
    ...(row.local_path ? { localPath: row.local_path } : {}),
    ...(row.note ? { note: row.note } : {}),
    colorLabel: (row.color_label as ColorLabel) ?? "none",
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
  };
}

/**
 * Manual order (sort_order) wins; until the user ever reorders, everything
 * has sort_order 0 and recency decides (M4 "last-used ordering").
 */
export function listFavorites(): Favorite[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM favorites
       ORDER BY sort_order ASC, COALESCE(last_used_at, created_at) DESC`,
    )
    .all() as Row[];
  return rows.map(fromRow);
}

export function getFavorite(id: string): Favorite | null {
  const row = getDb().prepare("SELECT * FROM favorites WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/**
 * Create or update. `secret` semantics: undefined = keep existing,
 * null = clear, string = password/passphrase, object = S3 credential.
 */
export function saveFavorite(input: FavoriteInput, secret?: FavoriteSecret | null): Favorite {
  const db = getDb();
  const existing = input.id ? getFavorite(input.id) : null;
  const id = existing?.id ?? randomUUID();
  const protocol = protocolFrom(input.protocol);
  const isS3 = protocol === "s3";
  const isSmb = protocol === "smb";
  const hasS3Fields =
    input.s3Endpoint !== undefined ||
    input.s3Region !== undefined ||
    input.s3Bucket !== undefined ||
    input.s3ForcePathStyle !== undefined ||
    input.s3Provider !== undefined;

  if (isS3) {
    if (input.authMethod !== "s3") throw invalid("S3 favorites require S3 authentication");
    if (!input.username.trim()) throw invalid("S3 access key ID is required");
    if (!input.s3Region?.trim() || !input.s3Bucket?.trim()) throw invalid("S3 region and bucket are required");
  } else if (hasS3Fields) {
    throw invalid("S3 settings are only valid for S3 favorites");
  }
  if (isSmb && !input.smbShare?.trim()) throw invalid("SMB share is required");
  if (!isSmb && (input.smbShare !== undefined || input.smbDomain !== undefined)) {
    throw invalid("SMB settings are only valid for SMB favorites");
  }
  if (!isWebDav(protocol) && input.webdavRoot !== undefined) {
    throw invalid("WebDAV settings are only valid for WebDAV favorites");
  }
  if (isS3 && typeof secret === "string") throw invalid("S3 favorites store an S3 credential, not a password");
  if (!isS3 && secret !== null && typeof secret === "object") {
    throw invalid("Only S3 favorites store an S3 credential");
  }

  const authMethod = isS3
    ? "s3"
    : protocol === "sftp" && (input.authMethod === "key" || input.authMethod === "agent")
      ? input.authMethod
      : "password";
  const privateKeyPath = authMethod === "key" ? (input.privateKeyPath ?? null) : null;
  const s3Provider = isS3 && input.s3Provider === "gcs" ? "gcs" : null;
  // The GCS preset owns its endpoint, region, and addressing; store those, not stale input.
  const s3Endpoint = s3Provider ? GCS_ENDPOINT : isS3 ? (input.s3Endpoint ?? null) : null;
  const s3Region = s3Provider ? GCS_REGION : isS3 ? (input.s3Region ?? null) : null;
  const s3Bucket = isS3 ? (input.s3Bucket ?? null) : null;
  const s3ForcePathStyle = s3Provider || (isS3 && input.s3ForcePathStyle === true) ? 1 : 0;
  const smbShare = isSmb ? (input.smbShare?.trim() ?? null) : null;
  const smbDomain = isSmb ? input.smbDomain?.trim() || null : null;
  const webdavRoot = isWebDav(protocol) ? input.webdavRoot?.trim() || null : null;

  let secretStored = existing?.secretStored ?? false;
  if (authMethod === "agent" || secret === null || (secret === undefined && existing && existing.authMethod !== authMethod)) {
    deleteSecret(id);
    secretStored = false;
  } else if (isS3 && secret !== null && typeof secret === "object") {
    storeSecret(id, serializeS3Secret(secret));
    secretStored = true;
  } else if (typeof secret === "string" && secret.length > 0) {
    storeSecret(id, secret);
    secretStored = true;
  }

  if (existing) {
    db.prepare(
      `UPDATE favorites SET name=?, protocol=?, host=?, port=?, username=?, auth_method=?,
         secret_stored=?, private_key_path=?, tls_reject_unauthorized=?, remote_path=?, local_path=?,
         note=?, color_label=?, s3_endpoint=?, s3_region=?, s3_bucket=?, s3_force_path_style=?,
         s3_provider=?, smb_share=?, smb_domain=?, webdav_root=?
       WHERE id=?`,
    ).run(
      input.name,
      protocol,
      input.host,
      input.port,
      input.username,
      authMethod,
      secretStored ? 1 : 0,
      privateKeyPath,
      input.tlsRejectUnauthorized === false ? 0 : 1,
      input.remotePath ?? null,
      input.localPath ?? null,
      input.note ?? null,
      input.colorLabel,
      s3Endpoint,
      s3Region,
      s3Bucket,
      s3ForcePathStyle,
      s3Provider,
      smbShare,
      smbDomain,
      webdavRoot,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO favorites
         (id, name, protocol, host, port, username, auth_method, secret_stored,
          private_key_path, tls_reject_unauthorized, remote_path, local_path, note, color_label,
          s3_endpoint, s3_region, s3_bucket, s3_force_path_style, s3_provider, smb_share, smb_domain,
          webdav_root, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id,
      input.name,
      protocol,
      input.host,
      input.port,
      input.username,
      authMethod,
      secretStored ? 1 : 0,
      privateKeyPath,
      input.tlsRejectUnauthorized === false ? 0 : 1,
      input.remotePath ?? null,
      input.localPath ?? null,
      input.note ?? null,
      input.colorLabel,
      s3Endpoint,
      s3Region,
      s3Bucket,
      s3ForcePathStyle,
      s3Provider,
      smbShare,
      smbDomain,
      webdavRoot,
      Date.now(),
    );
  }
  const saved = getFavorite(id);
  if (!saved) throw new Error("Favorite vanished during save");
  return saved;
}

export function removeFavorite(id: string): void {
  deleteSecret(id);
  getDb().prepare("DELETE FROM favorites WHERE id = ?").run(id);
}

export function reorderFavorites(ids: string[]): void {
  const db = getDb();
  const update = db.prepare("UPDATE favorites SET sort_order = ? WHERE id = ?");
  const tx = db.transaction((ordered: string[]) => {
    ordered.forEach((id, index) => update.run(index + 1, id));
  });
  tx(ids);
}

export function touchLastUsed(id: string): void {
  getDb().prepare("UPDATE favorites SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}
