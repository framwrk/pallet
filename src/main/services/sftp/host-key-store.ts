import { getDb } from "../database";

export interface KnownHostKey {
  keyType: string;
  fingerprint: string;
}

export function getKnownKey(host: string, port: number, keyType: string): KnownHostKey | null {
  const row = getDb()
    .prepare("SELECT key_type, fingerprint FROM host_keys WHERE host = ? AND port = ? AND key_type = ?")
    .get(host, port, keyType) as { key_type: string; fingerprint: string } | undefined;
  return row ? { keyType: row.key_type, fingerprint: row.fingerprint } : null;
}

export function touchKey(host: string, port: number, keyType: string): void {
  getDb()
    .prepare("UPDATE host_keys SET last_seen_at = ? WHERE host = ? AND port = ? AND key_type = ?")
    .run(Date.now(), host, port, keyType);
}

/** Insert or replace (also used when the user overrides a mismatch). */
export function trustKey(host: string, port: number, keyType: string, fingerprint: string): void {
  getDb()
    .prepare(
      `INSERT INTO host_keys (host, port, key_type, fingerprint, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(host, port, key_type) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(host, port, keyType, fingerprint, Date.now(), Date.now());
}
