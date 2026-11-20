import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import {
  type S3Location,
  S3_DIR_MODE,
  S3_FILE_MODE,
  assertEntryName,
  encodeCopySource,
  isRootPath,
  joinPath,
  keyForPath,
  normalizePath,
  prefixForPath,
} from "./s3-path";
import { normalizeS3Error, s3Call, s3Error } from "./s3-client";
import type { Entry } from "@shared/fs/fs.types";

/** Minimal command sender; the real S3Client and tests both satisfy it. */
export interface S3Like {
  send<T>(command: object): Promise<T>;
}

export interface S3Target {
  bucket: string;
  location: S3Location;
}

interface ListedObject {
  key: string;
  size: number;
  mtimeMs: number;
  etag?: string;
}

const MB = 1024 * 1024;
const GIB = 1024 * MB;
/** S3's single CopyObject limit. */
export const SINGLE_COPY_LIMIT = 5 * GIB;
const MULTIPART_MIN_PART = 5 * MB;
const MULTIPART_MAX_PART = 5 * GIB;
const MULTIPART_MAX_PARTS = 10_000;
const DELETE_BATCH = 1_000;

function lastModifiedMs(value: Date | undefined): number {
  return value ? value.getTime() : 0;
}

function stripQuotes(value: string | undefined): string | undefined {
  return value?.replace(/^"|"$/g, "");
}

async function headObject(
  client: S3Like,
  bucket: string,
  key: string,
): Promise<{ size: number; mtimeMs: number; etag?: string } | null> {
  try {
    const out = await client.send<{ ContentLength?: number; LastModified?: Date; ETag?: string }>(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      size: out.ContentLength ?? 0,
      mtimeMs: lastModifiedMs(out.LastModified),
      ...(out.ETag ? { etag: stripQuotes(out.ETag) } : {}),
    };
  } catch (err) {
    const normalized = normalizeS3Error(err);
    if (normalized.code === "ENOENT") return null;
    throw normalized;
  }
}

/** True when any key exists under a directory prefix, including a marker. */
export async function prefixHasObjects(client: S3Like, bucket: string, prefix: string): Promise<boolean> {
  if (prefix === "") return true;
  const out = await s3Call(() =>
    client.send<{ KeyCount?: number }>(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 })),
  );
  return (out.KeyCount ?? 0) > 0;
}

export interface S3Stat {
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  etag?: string;
}

export async function statKey(client: S3Like, target: S3Target, path: string): Promise<S3Stat> {
  const normalized = normalizePath(path);
  if (normalized === "/") return { kind: "dir", size: 0, mtimeMs: 0 };
  const key = keyForPath(target.location, normalized);
  const head = await headObject(client, target.bucket, key);
  if (head) return { kind: "file", ...head };
  const prefix = prefixForPath(target.location, normalized);
  if (await prefixHasObjects(client, target.bucket, prefix)) {
    return { kind: "dir", size: 0, mtimeMs: 0 };
  }
  throw Object.assign(new Error(`Remote path not found: ${normalized}`), { code: "ENOENT" });
}

export async function statPathOrNull(client: S3Like, target: S3Target, path: string): Promise<S3Stat | null> {
  try {
    return await statKey(client, target, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function entryFrom(path: string, name: string, kind: "file" | "dir", size: number, mtimeMs: number): Entry {
  return {
    name,
    path,
    kind,
    size,
    mtimeMs,
    mode: kind === "dir" ? S3_DIR_MODE : S3_FILE_MODE,
    hidden: name.startsWith("."),
  };
}

export interface S3Listing {
  path: string;
  files: Entry[];
  dirs: Entry[];
}

/**
 * One visual directory. Paginates to completion; an incomplete next page is
 * never returned as a finished listing. An object and a directory prefix with
 * the same visible name is an explicit failure rather than a silent merge.
 */
export async function listDirectory(client: S3Like, target: S3Target, dirPath: string): Promise<S3Listing> {
  const path = normalizePath(dirPath);
  const prefix = prefixForPath(target.location, path);
  const files: Entry[] = [];
  const dirs: Entry[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const out = await s3Call(() =>
      client.send<{
        Contents?: { Key?: string; Size?: number; LastModified?: Date }[];
        CommonPrefixes?: { Prefix?: string }[];
        NextContinuationToken?: string;
        IsTruncated?: boolean;
      }>(
        new ListObjectsV2Command({
          Bucket: target.bucket,
          Prefix: prefix,
          Delimiter: "/",
          ...(token ? { ContinuationToken: token } : {}),
        }),
      ),
    );

    for (const common of out.CommonPrefixes ?? []) {
      const key = common.Prefix ?? "";
      if (!key.startsWith(prefix) || key === prefix) continue;
      const relative = key.slice(prefix.length).replace(/\/$/, "");
      if (relative === "" || relative.includes("/")) {
        throw s3Error(
          "EINVAL",
          `S3 key "${key}" cannot be represented as a folder name; rename it outside Pallet to browse this location`,
        );
      }
      assertEntryName(relative);
      if (seen.has(`d\0${relative}`)) continue;
      seen.add(`d\0${relative}`);
      dirs.push(entryFrom(joinPath(path, relative), relative, "dir", 0, 0));
    }

    for (const object of out.Contents ?? []) {
      const key = object.Key ?? "";
      if (key === prefix || key.endsWith("/")) continue;
      if (!key.startsWith(prefix)) continue;
      const relative = key.slice(prefix.length);
      if (relative === "" || relative.includes("/")) {
        throw s3Error(
          "EINVAL",
          `S3 key "${key}" cannot be represented as one file name; rename it outside Pallet to browse this location`,
        );
      }
      assertEntryName(relative);
      if (seen.has(`f\0${relative}`)) continue;
      seen.add(`f\0${relative}`);
      files.push(entryFrom(joinPath(path, relative), relative, "file", object.Size ?? 0, lastModifiedMs(object.LastModified)));
    }

    token = out.IsTruncated ? out.NextContinuationToken : undefined;
    if (out.IsTruncated && !token) {
      throw s3Error("EIO", "S3 listing was truncated without a continuation token");
    }
  } while (token);

  for (const dir of dirs) {
    if (files.some((file) => file.name === dir.name)) {
      throw s3Error(
        "EAMBIGUOUS",
        `S3 contains both an object and a folder named "${dir.name}"; rename one outside Pallet to browse this folder`,
      );
    }
  }
  return { path, files, dirs };
}

export async function listAllKeys(client: S3Like, bucket: string, prefix: string): Promise<ListedObject[]> {
  const keys: ListedObject[] = [];
  let token: string | undefined;
  do {
    const out = await s3Call(() =>
      client.send<{
        Contents?: { Key?: string; Size?: number; LastModified?: Date; ETag?: string }[];
        NextContinuationToken?: string;
        IsTruncated?: boolean;
      }>(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      ),
    );
    for (const object of out.Contents ?? []) {
      if (!object.Key) continue;
      keys.push({
        key: object.Key,
        size: object.Size ?? 0,
        mtimeMs: lastModifiedMs(object.LastModified),
        ...(object.ETag ? { etag: stripQuotes(object.ETag) } : {}),
      });
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
    if (out.IsTruncated && !token) {
      throw s3Error("EIO", "S3 listing was truncated without a continuation token");
    }
  } while (token);
  return keys;
}

export async function createFolder(client: S3Like, target: S3Target, path: string): Promise<void> {
  if (isRootPath(path)) throw s3Error("EEXIST", "The connection root already exists");
  const normalized = normalizePath(path);
  const key = keyForPath(target.location, normalized);
  const prefix = `${key}/`;
  if ((await headObject(client, target.bucket, key)) || (await prefixHasObjects(client, target.bucket, prefix))) {
    throw Object.assign(new Error(`"${normalized.slice(normalized.lastIndexOf("/") + 1)}" already exists`), {
      code: "EEXIST",
    });
  }
  await s3Call(() => client.send(new PutObjectCommand({ Bucket: target.bucket, Key: prefix, Body: "", ContentLength: 0 })));
}

async function deleteKeys(client: S3Like, bucket: string, keys: string[]): Promise<void> {
  const failures: string[] = [];
  for (let index = 0; index < keys.length; index += DELETE_BATCH) {
    const batch = keys.slice(index, index + DELETE_BATCH);
    const out = await s3Call(() =>
      client.send<{ Errors?: { Key?: string; Code?: string; Message?: string }[] }>(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      ),
    );
    for (const error of out.Errors ?? []) {
      failures.push(`${error.Key ?? "unknown key"}: ${error.Code ?? "error"}${error.Message ? ` (${error.Message})` : ""}`);
    }
  }
  if (failures.length > 0) {
    const shown = failures.slice(0, 3).join("; ");
    const more = failures.length > 3 ? ` and ${failures.length - 3} more` : "";
    throw s3Error("EIO", `S3 deleted some objects but not all: ${shown}${more}`);
  }
}

/**
 * Recursive delete of exactly the selected prefix. Deletion is idempotent, so
 * staging cleanup can call it for a key that may never have been written.
 */
export async function removePath(client: S3Like, target: S3Target, path: string): Promise<void> {
  const normalized = normalizePath(path);
  if (normalized === "/") throw s3Error("EINVAL", "The connection root cannot be deleted");
  const stat = await statPathOrNull(client, target, normalized);
  if (!stat) return;
  const key = keyForPath(target.location, normalized);
  if (stat.kind === "file") {
    await deleteKeys(client, target.bucket, [key]);
    return;
  }
  const prefix = prefixForPath(target.location, normalized);
  const keys = (await listAllKeys(client, target.bucket, prefix)).map((object) => object.key);
  if (keys.length === 0) return;
  await deleteKeys(client, target.bucket, keys);
}

export interface CopyOptions {
  /** Test seam: force the multipart path without a multi-gigabyte fixture. */
  singleCopyLimit?: number;
  partSize?: number;
}

function multipartPartSize(size: number, requested?: number): number {
  if (requested && requested > 0) {
    return Math.min(MULTIPART_MAX_PART, Math.max(MULTIPART_MIN_PART, Math.floor(requested)));
  }
  return Math.min(MULTIPART_MAX_PART, Math.max(MULTIPART_MIN_PART, Math.ceil(size / MULTIPART_MAX_PARTS)));
}

/**
 * Server-side copy. Objects over the single-copy limit are copied in parts;
 * the destination is only replaced at CompleteMultipartUpload. A failure
 * aborts the destination upload and never deletes the existing destination.
 */
export async function copyObject(
  client: S3Like,
  bucket: string,
  fromKey: string,
  toKey: string,
  options: CopyOptions = {},
): Promise<void> {
  if (fromKey === toKey) return;
  if (!fromKey || !toKey) throw s3Error("EINVAL", "S3 copy requires a source and destination key");
  const head = await headObject(client, bucket, fromKey);
  if (!head) throw Object.assign(new Error(`S3 source object not found: ${fromKey}`), { code: "ENOENT" });
  const limit = options.singleCopyLimit ?? SINGLE_COPY_LIMIT;
  const copySource = encodeCopySource(bucket, fromKey);

  if (head.size <= limit) {
    await s3Call(() =>
      client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: toKey,
          CopySource: copySource,
        }),
      ),
    );
    return;
  }

  const partSize = multipartPartSize(head.size, options.partSize);
  const created = await s3Call(() =>
    client.send<{ UploadId?: string }>(new CreateMultipartUploadCommand({ Bucket: bucket, Key: toKey })),
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw s3Error("EIO", "S3 did not return a multipart upload id");
  try {
    const parts: { ETag?: string; PartNumber: number }[] = [];
    for (let offset = 0, partNumber = 1; offset < head.size; offset += partSize, partNumber++) {
      const end = Math.min(offset + partSize, head.size) - 1;
      const out = await s3Call(() =>
        client.send<{ CopyPartResult?: { ETag?: string } }>(
          new UploadPartCopyCommand({
            Bucket: bucket,
            Key: toKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            CopySource: copySource,
            CopySourceRange: `bytes=${offset}-${end}`,
          }),
        ),
      );
      const etag = out.CopyPartResult?.ETag;
      if (!etag) throw s3Error("EIO", `S3 did not return an ETag for copied part ${partNumber}`);
      parts.push({ ETag: etag, PartNumber: partNumber });
    }
    await s3Call(() =>
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: toKey,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
        }),
      ),
    );
  } catch (err) {
    await s3Call(() => client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: toKey, UploadId: uploadId }))).catch(
      () => {},
    );
    throw err;
  }
}

/** Rename with no-overwrite semantics, for a file or a whole directory prefix. */
export async function renamePath(client: S3Like, target: S3Target, from: string, to: string): Promise<void> {
  const source = normalizePath(from);
  const destination = normalizePath(to);
  if (source === "/" || destination === "/") throw s3Error("EINVAL", "The connection root cannot be renamed");
  if (source === destination) return;

  const stat = await statKey(client, target, source);
  const fromKey = keyForPath(target.location, source);
  const toKey = keyForPath(target.location, destination);
  const fromPrefix = `${fromKey}/`;
  const toPrefix = `${toKey}/`;

  if (stat.kind === "file") {
    if ((await headObject(client, target.bucket, toKey)) || (await prefixHasObjects(client, target.bucket, toPrefix))) {
      throw Object.assign(new Error(`"${destination.slice(destination.lastIndexOf("/") + 1)}" already exists`), {
        code: "EEXIST",
      });
    }
    await copyObject(client, target.bucket, fromKey, toKey);
    await deleteKeys(client, target.bucket, [fromKey]);
    return;
  }

  if (toPrefix.startsWith(fromPrefix)) {
    throw s3Error("EINVAL", "A folder cannot be moved into itself");
  }
  if ((await headObject(client, target.bucket, toKey)) || (await prefixHasObjects(client, target.bucket, toPrefix))) {
    throw Object.assign(new Error(`"${destination.slice(destination.lastIndexOf("/") + 1)}" already exists`), {
      code: "EEXIST",
    });
  }

  const sourceKeys = (await listAllKeys(client, target.bucket, fromPrefix)).map((object) => object.key);
  const moves = sourceKeys.map((key) => ({ from: key, to: `${toPrefix}${key.slice(fromPrefix.length)}` }));

  for (const move of moves) {
    if (await headObject(client, target.bucket, move.to)) {
      throw Object.assign(new Error(`A destination object already exists: ${move.to}`), { code: "EEXIST" });
    }
  }

  let copied = 0;
  try {
    for (const move of moves) {
      await copyObject(client, target.bucket, move.from, move.to);
      copied++;
    }
  } catch (err) {
    throw s3Error(
      "EIO",
      `Folder rename stopped after copying ${copied} of ${moves.length} objects; the source was left intact. ` +
        `Refresh and review both locations before retrying. ${(err as Error).message}`,
    );
  }

  await deleteKeys(
    client,
    target.bucket,
    moves.map((move) => move.from),
  );
}

/** Non-delimited walker used by folder sizes; directory markers add no bytes. */
export async function sumPrefixBytes(client: S3Like, target: S3Target, path: string): Promise<number> {
  const prefix = prefixForPath(target.location, normalizePath(path));
  const objects = await listAllKeys(client, target.bucket, prefix);
  let total = 0;
  for (const object of objects) {
    if (object.key.endsWith("/")) continue;
    total += object.size;
  }
  return total;
}

export interface ObjectBytes {
  data: Buffer;
  totalSize: number;
}

/** Bounded preview read; empty objects are read without an invalid Range. */
export async function readObjectBytes(client: S3Like, target: S3Target, path: string, maxBytes: number): Promise<ObjectBytes> {
  const key = keyForPath(target.location, normalizePath(path));
  const head = await headObject(client, target.bucket, key);
  if (!head) throw Object.assign(new Error(`Remote path not found: ${path}`), { code: "ENOENT" });
  if (maxBytes <= 0 || head.size === 0) return { data: Buffer.alloc(0), totalSize: head.size };
  const end = Math.min(maxBytes, head.size) - 1;
  const out = await s3Call(() =>
    client.send<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>(
      new GetObjectCommand({ Bucket: target.bucket, Key: key, Range: `bytes=0-${end}` }),
    ),
  );
  if (!out.Body) return { data: Buffer.alloc(0), totalSize: head.size };
  const bytes = await out.Body.transformToByteArray();
  return { data: Buffer.from(bytes), totalSize: head.size };
}

export function validateWritableTarget(path: string): void {
  if (normalizePath(path) === "/") throw s3Error("EINVAL", "The connection root cannot be modified");
}
