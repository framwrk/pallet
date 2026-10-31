import type Database from "better-sqlite3";

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
  tls_reject_unauthorized INTEGER NOT NULL DEFAULT 1,
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
  PRIMARY KEY (host, port, key_type)
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

/** Apply the schema and migrations to an open database. */
export function initializeDatabase(db: Database.Database): void {
  db.exec(SCHEMA);
  migrateHostKeys(db);
  const favoriteColumns = new Set(
    (db.prepare("PRAGMA table_info(favorites)").all() as { name: string }[]).map((column) => column.name),
  );
  if (!favoriteColumns.has("tls_reject_unauthorized")) {
    db.exec("ALTER TABLE favorites ADD COLUMN tls_reject_unauthorized INTEGER NOT NULL DEFAULT 1");
  }
}

/**
 * Host keys used to be keyed by (host, port), which made a second key type look
 * like a changed fingerprint. SQLite cannot change a primary key in place, so
 * rebuild the table and copy the rows across.
 */
function migrateHostKeys(db: Database.Database): void {
  const primaryKey = (db.prepare("PRAGMA table_info(host_keys)").all() as { name: string; pk: number }[])
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  if (primaryKey.join(",") === "host,port,key_type") return;
  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS host_keys_new;
      CREATE TABLE host_keys_new (
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        key_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (host, port, key_type)
      );
      INSERT INTO host_keys_new (host, port, key_type, fingerprint, first_seen_at, last_seen_at)
        SELECT host, port, key_type, fingerprint, first_seen_at, last_seen_at FROM host_keys;
      DROP TABLE host_keys;
      ALTER TABLE host_keys_new RENAME TO host_keys;
    `);
  })();
}
