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
      last_used_at INTEGER, s3_endpoint TEXT, s3_region TEXT, s3_bucket TEXT,
      s3_force_path_style INTEGER NOT NULL DEFAULT 0
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
    name: "Backups",
    protocol: "s3",
    host: "storage.googleapis.com",
    port: 443,
    username: "GOOG1EXAMPLE",
    authMethod: "s3",
    s3Provider: "gcs",
    s3Endpoint: "https://storage.googleapis.com",
    s3Region: "auto",
    s3Bucket: "backups",
    s3ForcePathStyle: true,
    colorLabel: "none",
    ...overrides,
  };
}

test("an existing S3 favorites table gains the provider column and reopens with the GCS preset", () => {
  const saved = store.saveFavorite(input(), { secretAccessKey: "hmac-secret" });
  expect(store.getFavorite(saved.id)).toMatchObject({
    protocol: "s3",
    s3Provider: "gcs",
    s3Endpoint: "https://storage.googleapis.com",
    s3Region: "auto",
    s3Bucket: "backups",
    s3ForcePathStyle: true,
    secretStored: true,
  });
});

test("a GCS favorite stores the preset's endpoint, region, and addressing, not stale input", () => {
  const saved = store.saveFavorite(
    input({ s3Endpoint: "https://s3.example.com", s3Region: "us-west-2", s3ForcePathStyle: false }),
    { secretAccessKey: "hmac-secret" },
  );
  expect(saved).toMatchObject({
    s3Endpoint: "https://storage.googleapis.com",
    s3Region: "auto",
    s3ForcePathStyle: true,
  });
});

test("switching a favorite back to generic S3 clears the preset", () => {
  const saved = store.saveFavorite(input(), { secretAccessKey: "hmac-secret" });
  const updated = store.saveFavorite(
    input({ id: saved.id, s3Provider: undefined, s3Endpoint: undefined, s3Region: "us-east-1", s3ForcePathStyle: false }),
  );
  expect(updated.s3Provider).toBeUndefined();
  expect(updated.secretStored).toBe(true);
});

test("non-S3 favorites reject the provider", () => {
  expect(() =>
    store.saveFavorite(
      {
        name: "x",
        protocol: "sftp",
        host: "h",
        port: 22,
        username: "u",
        authMethod: "password",
        s3Provider: "gcs",
        colorLabel: "none",
      },
      "pw",
    ),
  ).toThrow("S3 settings are only valid for S3 favorites");
});
