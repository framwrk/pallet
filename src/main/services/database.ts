import Database from "better-sqlite3";
import { app } from "electron";
import { join } from "path";

/**
 * SQLite holds metadata only (§3.5). Secrets never touch this file — they go
 * to Electron safeStorage (M4).
 */
let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'sftp',
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  secret_stored INTEGER NOT NULL DEFAULT 0,
  private_key_path TEXT,
  remote_path TEXT,
  local_path TEXT,
  note TEXT,
  color_label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS host_keys (
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  key_type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (host, port)
);
CREATE TABLE IF NOT EXISTS transfer_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  favorite_id TEXT,
  direction TEXT NOT NULL,
  source TEXT NOT NULL,
  dest TEXT NOT NULL,
  bytes INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(join(app.getPath("userData"), "pallet.db"));
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
  }
  return db;
}
