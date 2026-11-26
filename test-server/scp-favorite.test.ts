import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import Database from "better-sqlite3";
import type { FavoriteInput } from "../src/shared/favorite/favorite.types";

let db: Database.Database;
let store: typeof import("../src/main/services/favorite-store.service");
const secrets = new Map<string, string>();

beforeAll(async () => {
  db = new Database(":memory:");
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
    name: "Router",
    protocol: "scp",
    host: "router.lan",
    port: 22,
    username: "root",
    authMethod: "key",
    privateKeyPath: "~/.ssh/id_ed25519",
    remotePath: "/tmp",
    colorLabel: "none",
    ...overrides,
  };
}

test("SCP favorites round-trip with SSH key and agent authentication", () => {
  const saved = store.saveFavorite(input(), "passphrase");
  expect(saved).toMatchObject({
    protocol: "scp",
    authMethod: "key",
    privateKeyPath: "~/.ssh/id_ed25519",
    remotePath: "/tmp",
  });
  expect(store.getFavorite(saved.id)?.protocol).toBe("scp");

  const agent = store.saveFavorite(input({ id: saved.id, authMethod: "agent", privateKeyPath: undefined }));
  expect(agent.authMethod).toBe("agent");
  expect(agent.secretStored).toBe(false);
});
