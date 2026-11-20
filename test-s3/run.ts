/**
 * Opt-in live S3 check against a disposable MinIO (or compatible) endpoint.
 *
 * This is not part of `bun test test-server`; it requires the four
 * PALLET_S3_TEST_* variables documented in test-s3/README.md. Every object it
 * creates lives under one unique prefix, and cleanup removes only that prefix.
 */
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  copyObject,
  listDirectory,
  removePath,
  renamePath,
  statPathOrNull,
  sumPrefixBytes,
} from "../src/main/services/s3/s3-ops";
import { createS3Client, resolveS3Config } from "../src/main/services/s3/s3-client";
import type { Readable } from "node:stream";
import { S3Endpoint } from "../src/main/services/s3/s3-endpoint";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import assert from "node:assert/strict";
import { locationFor } from "../src/main/services/s3/s3-path";
import { randomBytes } from "node:crypto";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `Missing ${name}.\n` +
        "Run this check only against a disposable MinIO started with:\n" +
        "  docker compose --profile s3 up -d minio\n" +
        "then export PALLET_S3_TEST_ENDPOINT, PALLET_S3_TEST_ACCESS_KEY,\n" +
        "PALLET_S3_TEST_SECRET_KEY, and PALLET_S3_TEST_BUCKET.\n" +
        "See test-s3/README.md.",
    );
    process.exit(1);
  }
  return value;
}

const endpointUrl = required("PALLET_S3_TEST_ENDPOINT");
const accessKeyId = required("PALLET_S3_TEST_ACCESS_KEY");
const secretAccessKey = required("PALLET_S3_TEST_SECRET_KEY");
const bucket = required("PALLET_S3_TEST_BUCKET");
const region = process.env.PALLET_S3_TEST_REGION?.trim() || "us-east-1";

const config = resolveS3Config({ endpoint: endpointUrl, region, bucket });
const client = createS3Client(config, { accessKeyId, secretAccessKey });
const target = { bucket: config.bucket, location: locationFor("") };

const sessions = {
  s3Session: () => ({ client, target }),
  noteS3Failure: () => {},
} as unknown as SessionManager;
const endpoint = new S3Endpoint(sessions, "s3-check");

const prefix = `pallet-s3-check-${Date.now()}-${randomBytes(4).toString("hex")}`;
const root = `/${prefix}`;

function step(message: string): void {
  console.log(`- ${message}`);
}

async function ensureBucket(): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch {
    // Missing bucket is expected; anything else surfaces from CreateBucket.
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Created bucket ${bucket}.`);
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
  }
}

async function writeFile(path: string, data: Buffer): Promise<void> {
  const stream = await endpoint.createWriteStream(path, 0o644);
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.once("finish", resolve);
    stream.end(data);
  });
}

async function readFile(path: string, options: { start?: number; end?: number } = {}): Promise<Buffer> {
  const stream: Readable = await endpoint.createReadStream(path, options);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  await ensureBucket();
  console.log(`Checking S3 endpoint ${config.endpoint} in bucket ${bucket} under ${prefix}.`);

  const payload = randomBytes(64 * 1024);
  const nestedFile = `${root}/nested/upload.bin`;

  step("uploads through S3Endpoint");
  await writeFile(nestedFile, payload);
  const stat = await endpoint.statOrNull(nestedFile);
  assert(stat, "uploaded object must exist");
  assert.equal(stat.isDir, false);
  assert.equal(stat.size, payload.length);
  assert(stat.etag, "S3 stat must expose an ETag");

  step("downloads the whole object and a byte range");
  assert.deepEqual(await readFile(nestedFile), payload);
  assert.deepEqual(await readFile(nestedFile, { start: 10, end: 19 }), payload.subarray(10, 20));

  step("lists a folder through paginated ListObjectsV2");
  const listing = await listDirectory(client, target, `${root}/nested`);
  assert.deepEqual(listing.files.map((file) => file.name).sort(), ["upload.bin"]);

  step("copies, then renames without overwriting");
  const copiedFile = `${root}/nested/copied.bin`;
  const renamedFile = `${root}/nested/renamed.bin`;
  await copyObject(client, bucket, `${prefix}/nested/upload.bin`, `${prefix}/nested/copied.bin`);
  assert.equal((await statPathOrNull(client, target, copiedFile))?.size, payload.length);
  await renamePath(client, target, copiedFile, renamedFile);
  assert.equal(await statPathOrNull(client, target, copiedFile), null);
  assert.equal((await statPathOrNull(client, target, renamedFile))?.size, payload.length);

  step("creates a folder marker through S3Endpoint");
  const emptyDir = `${root}/empty-dir`;
  await endpoint.mkdirp(emptyDir);
  assert.equal((await endpoint.statOrNull(emptyDir))?.isDir, true);

  step("paginates a listing with more than 1000 objects");
  const bulkCount = 1005;
  let nextIndex = 0;
  const workers = Array.from({ length: 32 }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= bulkCount) return;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${prefix}/bulk/file-${String(index).padStart(4, "0")}.txt`,
          Body: "",
          ContentLength: 0,
        }),
      );
    }
  });
  await Promise.all(workers);
  const bulk = await listDirectory(client, target, `${root}/bulk`);
  assert.equal(bulk.files.length, bulkCount);
  assert.equal(new Set(bulk.files.map((file) => file.name)).size, bulkCount);

  step("totals folder bytes and ignores directory markers");
  assert.equal(await sumPrefixBytes(client, target, root), payload.length * 2);

  step("deletes a directory prefix and a single file");
  await removePath(client, target, `${root}/bulk`);
  assert.equal(await statPathOrNull(client, target, `${root}/bulk`), null);
  await removePath(client, target, renamedFile);
  assert.equal(await statPathOrNull(client, target, renamedFile), null);

  step("reports a missing object as ENOENT");
  const missing = await statPathOrNull(client, target, `${root}/missing.bin`);
  assert.equal(missing, null);

  console.log("S3 check passed.");
}

try {
  await main();
} finally {
  try {
    await removePath(client, target, root);
  } catch (err) {
    console.error(`Cleanup of ${root} failed:`, err);
    process.exitCode = 1;
  }
}
