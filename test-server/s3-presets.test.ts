import { S3_PRESETS, findS3Preset, normalizePresetRegion, presetEndpoint } from "../src/shared/s3/s3-presets";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { copyObject, removePath } from "../src/main/services/s3/s3-ops";
import { createS3Client, validateEndpoint } from "../src/main/services/s3/s3-client";
import Database from "better-sqlite3";
import type { FavoriteInput } from "../src/shared/favorite/favorite.types";
import { S3Endpoint } from "../src/main/services/s3/s3-endpoint";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import { locationFor } from "../src/main/services/s3/s3-path";

const b2 = findS3Preset("b2")!;

test("Backblaze B2 derives its S3 endpoint from the region", () => {
  expect(b2.label).toBe("Backblaze B2");
  expect(b2.keyIdLabel).toBe("Key ID");
  expect(b2.secretLabel).toBe("Application key");
  expect(presetEndpoint(b2, "us-west-004")).toBe("https://s3.us-west-004.backblazeb2.com");
  expect(presetEndpoint(b2, "eu-central-003")).toBe("https://s3.eu-central-003.backblazeb2.com");
  expect(presetEndpoint(b2, "  US-East-005 ")).toBe("https://s3.us-east-005.backblazeb2.com");
});

test("a preset region is lowercased and limited to one 63-character label", () => {
  expect(normalizePresetRegion(" US-WEST-004 ")).toBe("us-west-004");
  expect(normalizePresetRegion("a".repeat(63))).toBe("a".repeat(63));
  expect(normalizePresetRegion("a".repeat(64))).toBeNull();
});

test("a region that is not one DNS label yields no endpoint", () => {
  for (const region of ["", " ", "us-west-004.evil.com", "us west", "-us-west", "us-west-", "us--west", "a/b", "x@y"]) {
    expect(presetEndpoint(b2, region)).toBeNull();
  }
});

test("every preset endpoint passes the main-process endpoint validation", () => {
  for (const preset of S3_PRESETS) {
    const endpoint = presetEndpoint(preset, preset.regionPlaceholder);
    expect(endpoint).not.toBeNull();
    expect(validateEndpoint(endpoint!)).toBe(endpoint!);
  }
});

test("a B2 client sends checksums only when an operation requires one", async () => {
  const client = createS3Client(
    { region: "us-west-004", bucket: "backups", endpoint: presetEndpoint(b2, "us-west-004")!, forcePathStyle: true },
    { accessKeyId: "004abc", secretAccessKey: "secret" },
  );
  expect(await client.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
  expect(await client.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
  client.destroy();
});

interface SentRequest {
  command: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
}

/** A real B2 client whose signed requests are recorded and answered locally. */
function recordingB2Client(): { client: ReturnType<typeof createS3Client>; sent: SentRequest[] } {
  const client = createS3Client(
    { region: "us-west-004", bucket: "backups", endpoint: presetEndpoint(b2, "us-west-004")!, forcePathStyle: true },
    { accessKeyId: "004abc", secretAccessKey: "secret" },
  );
  const sent: SentRequest[] = [];
  client.middlewareStack.add(
    (_next, context) => async (args) => {
      const request = args.request as { hostname: string; path: string; headers: Record<string, string> };
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
      sent.push({ command: String(context.commandName), hostname: request.hostname, path: request.path, headers });
      const output = context.commandName === "HeadObjectCommand" ? { ContentLength: 3, ETag: '"e"' } : { ETag: '"e"' };
      return { output: { ...output, $metadata: { httpStatusCode: 200 } }, response: {} } as never;
    },
    { step: "finalizeRequest", priority: "low", name: "recordB2Request" },
  );
  return { client, sent };
}

function checksumHeaders(request: SentRequest): string[] {
  return Object.keys(request.headers).filter(
    (key) => key.startsWith("x-amz-checksum-") || key === "x-amz-sdk-checksum-algorithm" || key === "x-amz-trailer",
  );
}

test("B2 uploads and copies send no optional checksum headers to the derived endpoint", async () => {
  const { client, sent } = recordingB2Client();
  const sessions = {
    s3Session: () => ({ client, target: { bucket: "backups", location: locationFor() } }),
    noteS3Failure: () => {},
  } as unknown as SessionManager;
  const stream = await new S3Endpoint(sessions, "session-1").createWriteStream("/a.txt");
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(Buffer.from("abc"), resolve);
  });
  await copyObject(client, "backups", "a.txt", "b.txt");

  const put = sent.find((request) => request.command === "PutObjectCommand");
  const copy = sent.find((request) => request.command === "CopyObjectCommand");
  expect(put).toMatchObject({ hostname: "s3.us-west-004.backblazeb2.com", path: "/backups/a.txt" });
  expect(copy).toBeDefined();
  expect(checksumHeaders(put!)).toEqual([]);
  expect(checksumHeaders(copy!)).toEqual([]);
  client.destroy();
});

test("B2 deletes send the CRC32 checksum DeleteObjects requires instead of Content-MD5", async () => {
  const { client, sent } = recordingB2Client();
  await removePath(client, { bucket: "backups", location: locationFor() }, "/a.txt");

  const remove = sent.find((request) => request.command === "DeleteObjectsCommand");
  expect(remove).toBeDefined();
  expect(remove!.headers["x-amz-checksum-crc32"]).toBeString();
  expect(remove!.headers["content-md5"]).toBeUndefined();
  client.destroy();
});

test("unknown or missing preset ids resolve to no preset", () => {
  expect(findS3Preset(undefined)).toBeUndefined();
  expect(findS3Preset("")).toBeUndefined();
  expect(findS3Preset("nope")).toBeUndefined();
});

let db: Database.Database;
let store: typeof import("../src/main/services/favorite-store.service");
const LEGACY_ID = "legacy-aws";

beforeAll(async () => {
  db = new Database(":memory:");
  // The favorites table as it was before the s3_preset column, holding a saved AWS favorite.
  db.exec(`
    CREATE TABLE favorites (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL DEFAULT 'sftp', host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL, auth_method TEXT NOT NULL,
      secret_stored INTEGER NOT NULL DEFAULT 0, private_key_path TEXT,
      tls_reject_unauthorized INTEGER NOT NULL DEFAULT 1, remote_path TEXT, local_path TEXT, note TEXT,
      color_label TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_used_at INTEGER,
      s3_endpoint TEXT, s3_region TEXT, s3_bucket TEXT, s3_force_path_style INTEGER NOT NULL DEFAULT 0,
      smb_share TEXT, smb_domain TEXT, webdav_root TEXT
    );
    INSERT INTO favorites (id, name, protocol, host, port, username, auth_method, secret_stored, color_label,
      created_at, s3_region, s3_bucket)
    VALUES ('${LEGACY_ID}', 'Logs', 's3', 's3.us-east-1.amazonaws.com', 443, 'AKIA1', 's3', 1, 'none', 1,
      'us-east-1', 'logs');
  `);
  const { initializeDatabase } = await import("../src/main/services/database-schema");
  initializeDatabase(db);
  mock.module("../src/main/services/database", () => ({ getDb: () => db }));
  mock.module("../src/main/services/secrets", () => ({
    storeSecret: () => {},
    readSecret: () => null,
    deleteSecret: () => {},
  }));
  store = await import("../src/main/services/favorite-store.service");
});

afterAll(() => {
  db.close();
  mock.restore();
});

function b2Input(overrides: Partial<FavoriteInput> = {}): FavoriteInput {
  return {
    name: "Backups",
    protocol: "s3",
    host: "s3.us-west-004.backblazeb2.com",
    port: 443,
    username: "004abc",
    authMethod: "s3",
    s3Preset: "b2",
    s3Region: "us-west-004",
    s3Bucket: "backups",
    s3ForcePathStyle: true,
    colorLabel: "none",
    ...overrides,
  };
}

test("an existing S3 favorite survives the s3_preset migration and keeps its secret on edit", () => {
  const columns = (db.prepare("PRAGMA table_info(favorites)").all() as { name: string }[]).map((column) => column.name);
  expect(columns).toContain("s3_preset");

  const legacy = store.getFavorite(LEGACY_ID);
  expect(legacy).toMatchObject({ protocol: "s3", s3Region: "us-east-1", s3Bucket: "logs", secretStored: true });
  expect(legacy?.s3Preset).toBeUndefined();
  expect(legacy?.s3Endpoint).toBeUndefined();

  const legacyInput = {
    id: LEGACY_ID,
    name: "Logs",
    protocol: "s3",
    host: "s3.us-east-1.amazonaws.com",
    port: 443,
    username: "AKIA1",
    authMethod: "s3",
    s3Region: "us-east-1",
    s3Bucket: "logs",
    colorLabel: "none",
  } satisfies FavoriteInput;
  expect(store.saveFavorite({ ...legacyInput, note: "edited" })).toMatchObject({ note: "edited", secretStored: true });
  expect(() => store.saveFavorite({ ...legacyInput, s3Preset: "b2", s3Region: "us-west-004" })).toThrow(
    "Re-enter the S3 credentials",
  );
});

test("a B2 favorite persists its preset and stores the endpoint derived from the region", () => {
  const saved = store.saveFavorite(b2Input({ s3Endpoint: "https://elsewhere.example.com" }));
  expect(saved).toMatchObject({
    s3Preset: "b2",
    s3Region: "us-west-004",
    s3Endpoint: "https://s3.us-west-004.backblazeb2.com",
  });

  const custom = store.saveFavorite(b2Input({ id: saved.id, s3Preset: undefined, s3Endpoint: "https://minio.local" }));
  expect(custom.s3Preset).toBeUndefined();
  expect(custom.s3Endpoint).toBe("https://minio.local");
});

test("a favorite with an unknown preset or an invalid preset region is rejected", () => {
  expect(() => store.saveFavorite(b2Input({ s3Preset: "nope" }))).toThrow("Unknown S3 provider preset");
  expect(() => store.saveFavorite(b2Input({ s3Region: "us-west-004.evil.com" }))).toThrow("Invalid Backblaze B2 region");
  expect(() => store.saveFavorite({ ...b2Input(), protocol: "sftp", authMethod: "password" })).toThrow(
    "S3 settings are only valid for S3 favorites",
  );
});

test("a B2 favorite stores a lowercase signing region", () => {
  const saved = store.saveFavorite(b2Input({ s3Region: "US-West-004" }));
  expect(saved.s3Region).toBe("us-west-004");
  expect(saved.s3Endpoint).toBe("https://s3.us-west-004.backblazeb2.com");
});

test("a B2 favorite refuses a session token", () => {
  expect(() => store.saveFavorite(b2Input(), { secretAccessKey: "k", sessionToken: "t" })).toThrow(
    "Backblaze B2 favorites do not use a session token",
  );
});

test("changing the provider of a favorite with a stored secret requires new credentials", () => {
  const aws = store.saveFavorite(
    b2Input({ s3Preset: undefined, s3Region: "us-east-1", host: "s3.us-east-1.amazonaws.com", username: "AKIA1" }),
    { secretAccessKey: "aws-secret", sessionToken: "aws-token" },
  );
  expect(aws.secretStored).toBe(true);
  expect(() => store.saveFavorite(b2Input({ id: aws.id }))).toThrow("Re-enter the S3 credentials");
  const b2Saved = store.saveFavorite(b2Input({ id: aws.id }), { secretAccessKey: "b2-key" });
  expect(b2Saved).toMatchObject({ s3Preset: "b2", secretStored: true });
  expect(store.saveFavorite(b2Input({ id: aws.id, name: "Renamed" })).name).toBe("Renamed");
});
