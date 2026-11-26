import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import Database from "better-sqlite3";
import type { FavoriteInput } from "../src/shared/favorite/favorite.types";

let db: Database.Database;
let store: typeof import("../src/main/services/favorite-store.service");
const secrets = new Map<string, string>();

beforeAll(async () => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE favorites (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL DEFAULT 'sftp', host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, auth_method TEXT NOT NULL,
      secret_stored INTEGER NOT NULL DEFAULT 0, private_key_path TEXT, remote_path TEXT, local_path TEXT,
      note TEXT, color_label TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);
  const { initializeDatabase } = await import("../src/main/services/database-schema");
  initializeDatabase(db);
  mock.module("../src/main/services/database", () => ({ getDb: () => db }));
  mock.module("../src/main/services/secrets", () => ({
    storeSecret: (id: string, secret: string) => secrets.set(id, secret),
    readSecret: (id: string) => secrets.get(id) ?? null,
    deleteSecret: (id: string) => secrets.delete(id),
  }));
  store = await import("../src/main/services/favorite-store.service");
});

afterAll(() => {
  db.close();
  mock.restore();
});

function input(overrides: Partial<FavoriteInput> = {}): FavoriteInput {
  return {
    name: "Cloud",
    protocol: "webdavs",
    host: "cloud.example.com",
    port: 443,
    username: "alice",
    authMethod: "password",
    webdavRoot: "/remote.php/dav/files/alice",
    tlsRejectUnauthorized: false,
    colorLabel: "none",
    ...overrides,
  };
}

test("an existing database gains the WebDAV column and round-trips a WebDAV favorite", () => {
  const saved = store.saveFavorite(input(), "secret");
  expect(saved).toMatchObject({
    protocol: "webdavs",
    authMethod: "password",
    webdavRoot: "/remote.php/dav/files/alice",
    tlsRejectUnauthorized: false,
  });
  expect(secrets.get(saved.id)).toBe("secret");

  const updated = store.saveFavorite(input({ id: saved.id, protocol: "webdav", port: 80, webdavRoot: " " }));
  expect(updated.protocol).toBe("webdav");
  expect(updated.webdavRoot).toBeUndefined();
  expect(updated.secretStored).toBe(true);
});

test("other protocols reject the WebDAV server path, and WebDAV never stores key authentication", () => {
  expect(() => store.saveFavorite(input({ protocol: "ftp" }))).toThrow("WebDAV settings are only valid for WebDAV favorites");
  const saved = store.saveFavorite(input({ authMethod: "key", privateKeyPath: "~/.ssh/id" }), "secret");
  expect(saved.authMethod).toBe("password");
  expect(saved.privateKeyPath).toBeUndefined();
});
