import { getDb } from "../db";

export interface KnownHostKey {
  keyType: string;
  fingerprint: string;
}

export function getKnownKey(host: string, port: number): KnownHostKey | null {
  const row = getDb().prepare("SELECT key_type, fingerprint FROM host_keys WHERE host = ? AND port = ?").get(host, port) as
    { key_type: string; fingerprint: string } | undefined;
  return row ? { keyType: row.key_type, fingerprint: row.fingerprint } : null;
}

export function touchKey(host: string, port: number): void {
  getDb().prepare("UPDATE host_keys SET last_seen_at = ? WHERE host = ? AND port = ?").run(Date.now(), host, port);
}

/** Insert or replace (also used when the user overrides a mismatch). */
export function trustKey(host: string, port: number, keyType: string, fingerprint: string): void {
  getDb()
    .prepare(
      `INSERT INTO host_keys (host, port, key_type, fingerprint, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(host, port) DO UPDATE SET
         key_type = excluded.key_type,
         fingerprint = excluded.fingerprint,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(host, port, keyType, fingerprint, Date.now(), Date.now());
}
