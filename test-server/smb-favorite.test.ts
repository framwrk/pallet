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
    name: "NAS",
    protocol: "smb",
    host: "nas.local",
    port: 445,
    username: "pallet",
    authMethod: "password",
    smbShare: "Public",
    smbDomain: "WORKGROUP",
    colorLabel: "none",
    ...overrides,
  };
}

test("an existing database gains the SMB columns and round-trips an SMB favorite", () => {
  const saved = store.saveFavorite(input(), "secret");
  expect(saved).toMatchObject({ protocol: "smb", authMethod: "password", smbShare: "Public", smbDomain: "WORKGROUP" });
  expect(saved.secretStored).toBe(true);
  expect(secrets.get(saved.id)).toBe("secret");

  const updated = store.saveFavorite(input({ id: saved.id, smbShare: " Media ", smbDomain: " " }));
  expect(updated.smbShare).toBe("Media");
  expect(updated.smbDomain).toBeUndefined();
  expect(updated.secretStored).toBe(true);
});

test("SMB favorites need a share and other protocols reject SMB fields", () => {
  expect(() => store.saveFavorite(input({ smbShare: " " }))).toThrow("SMB share is required");
  expect(() => store.saveFavorite(input({ protocol: "sftp", authMethod: "password" }))).toThrow(
    "SMB settings are only valid for SMB favorites",
  );
});

test("SMB favorites never store key or agent authentication", () => {
  const saved = store.saveFavorite(input({ authMethod: "key", privateKeyPath: "~/.ssh/id" }), "secret");
  expect(saved.authMethod).toBe("password");
  expect(saved.privateKeyPath).toBeUndefined();
});
