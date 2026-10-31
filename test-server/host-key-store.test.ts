/**
 * Host keys are stored per (host, port, key type), so a server that offers
 * more than one algorithm does not look like a changed fingerprint.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "pallet-host-keys-"));
const databaseFile = join(dir, "pallet.db");

let db: Database.Database;
let initializeDatabase: typeof import("../src/main/services/database-schema").initializeDatabase;
let store: typeof import("../src/main/services/sftp/host-key-store");

beforeAll(async () => {
  // A database from before the migration: one row per host and port.
  db = new Database(databaseFile);
  db.exec(`
    CREATE TABLE host_keys (
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      key_type TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (host, port)
    );
    INSERT INTO host_keys (host, port, key_type, fingerprint, first_seen_at, last_seen_at)
      VALUES ('legacy.test', 22, 'ssh-ed25519', 'SHA256:legacy', 1, 2);
  `);
  ({ initializeDatabase } = await import("../src/main/services/database-schema"));
  initializeDatabase(db);
  mock.module("../src/main/services/database", () => ({ getDb: () => db }));
  store = await import("../src/main/services/sftp/host-key-store");
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

test("migrates legacy rows and keys them by host, port, and key type", () => {
  const primaryKey = (db.prepare("PRAGMA table_info(host_keys)").all() as { name: string; pk: number }[])
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  expect(primaryKey).toEqual(["host", "port", "key_type"]);
  expect(store.getKnownKey("legacy.test", 22, "ssh-ed25519")).toEqual({
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:legacy",
  });
});

test("the migration is idempotent", () => {
  initializeDatabase(db);
  expect(store.getKnownKey("legacy.test", 22, "ssh-ed25519")?.fingerprint).toBe("SHA256:legacy");
});

test("stores two key types for the same host independently", () => {
  store.trustKey("multi.test", 22, "ssh-ed25519", "SHA256:ed");
  store.trustKey("multi.test", 22, "ssh-rsa", "SHA256:rsa");
  expect(store.getKnownKey("multi.test", 22, "ssh-ed25519")?.fingerprint).toBe("SHA256:ed");
  expect(store.getKnownKey("multi.test", 22, "ssh-rsa")?.fingerprint).toBe("SHA256:rsa");
  expect(store.getKnownKey("multi.test", 22, "ecdsa-sha2-nistp256")).toBeNull();
});

test("a changed fingerprint replaces only the same key type", () => {
  store.trustKey("multi.test", 22, "ssh-ed25519", "SHA256:ed2");
  expect(store.getKnownKey("multi.test", 22, "ssh-ed25519")?.fingerprint).toBe("SHA256:ed2");
  expect(store.getKnownKey("multi.test", 22, "ssh-rsa")?.fingerprint).toBe("SHA256:rsa");
});

test("touchKey only updates the presented key type", () => {
  store.trustKey("touch.test", 22, "ssh-ed25519", "SHA256:a");
  store.trustKey("touch.test", 22, "ssh-rsa", "SHA256:b");
  db.prepare("UPDATE host_keys SET last_seen_at = 1 WHERE host = ?").run("touch.test");
  store.touchKey("touch.test", 22, "ssh-ed25519");
  const rows = db
    .prepare("SELECT key_type, last_seen_at FROM host_keys WHERE host = ? ORDER BY key_type")
    .all("touch.test") as { key_type: string; last_seen_at: number }[];
  expect(rows).toEqual([
    { key_type: "ssh-ed25519", last_seen_at: expect.any(Number) },
    { key_type: "ssh-rsa", last_seen_at: 1 },
  ]);
  expect(rows[0]?.last_seen_at).toBeGreaterThan(1);
});
