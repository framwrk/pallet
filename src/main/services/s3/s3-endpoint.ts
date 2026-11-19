/**
 * S3 as a TransferEndpoint. Reads honor byte ranges (bounded previews and full
 * SHA-256 passes), while writes are streamed multipart uploads that finish only
 * after the SDK confirms completion. `supportsRanges` stays false because v1
 * does not persist multipart upload ids or resume a partial object; an
 * interrupted file that involves S3 restarts from byte zero.
 */
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  type EndpointStat,
  type ReadOptions,
  type TransferEndpoint,
  type TransferWriteStream,
  type WriteOptions,
} from "../transfer/transfer-endpoint";
import { PassThrough, Readable, Writable } from "stream";
import { type S3Like, type S3Target, copyObject, createFolder, listDirectory, statKey, statPathOrNull } from "./s3-ops";
import { S3_DIR_MODE, S3_FILE_MODE, keyForPath, normalizePath } from "./s3-path";
import { normalizeS3Error, s3Call, s3Error } from "./s3-client";
import type { SessionManager } from "../sftp/session-manager";
import { Upload } from "@aws-sdk/lib-storage";

/** Multipart part size for uploads; keeps memory bounded per worker. */
const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
const UPLOAD_QUEUE_SIZE = 2;

/** Test seam: the queue only needs completion and abort, not the SDK type. */
export interface S3Upload {
  done(): Promise<unknown>;
  abort(): Promise<void>;
}
export type S3UploadFactory = (input: { client: S3Client; bucket: string; key: string; body: Readable }) => S3Upload;

function createUpload(input: { client: S3Client; bucket: string; key: string; body: Readable }): S3Upload {
  return new Upload({
    client: input.client,
    params: { Bucket: input.bucket, Key: input.key, Body: input.body },
    partSize: UPLOAD_PART_SIZE,
    queueSize: UPLOAD_QUEUE_SIZE,
    leavePartsOnError: false,
  });
}

function statFrom(isDir: boolean, size: number, mtimeMs: number, etag?: string): EndpointStat {
  return {
    size,
    mtimeMs,
    mode: isDir ? S3_DIR_MODE : S3_FILE_MODE,
    isDir,
    isSymlink: false,
    ...(etag ? { etag } : {}),
  };
}

export class S3Endpoint implements TransferEndpoint {
  kind = "sftp" as const;
  /** S3-involved files restart from zero; this endpoint never resumes. */
  supportsRanges = false;
  writesMeta = false;

  constructor(
    private sessions: SessionManager,
    private sessionId: string,
    private uploadFactory: S3UploadFactory = createUpload,
  ) {}

  private context(): { client: S3Like; target: S3Target; raw: S3Client } {
    const session = this.sessions.s3Session(this.sessionId);
    return { ...session, raw: session.client as unknown as S3Client };
  }

  private async run<T>(fn: (client: S3Like, target: S3Target) => Promise<T>): Promise<T> {
    const { client, target } = this.context();
    try {
      return await fn(client, target);
    } catch (err) {
      const normalized = normalizeS3Error(err);
      this.sessions.noteS3Failure(this.sessionId, normalized);
      throw normalized;
    }
  }

  statOrNull(p: string): Promise<EndpointStat | null> {
    return this.run(async (client, target) => {
      const stat = await statPathOrNull(client, target, p);
      if (!stat) return null;
      return statFrom(stat.kind === "dir", stat.size, stat.mtimeMs, stat.etag);
    });
  }

  async fileVersion(p: string): Promise<{ size: number; mtimeMs: number; etag?: string }> {
    return this.run(async (client, target) => {
      const stat = await statKey(client, target, p);
      if (stat.kind === "dir") throw s3Error("EISDIR", `Not a file: ${p}`);
      return { size: stat.size, mtimeMs: stat.mtimeMs, ...(stat.etag ? { etag: stat.etag } : {}) };
    });
  }

  async fileSize(p: string): Promise<number> {
    const version = await this.fileVersion(p);
    return version.size;
  }

  listNames(dir: string): Promise<string[]> {
    return this.run(async (client, target) => {
      const listing = await listDirectory(client, target, dir);
      return [...listing.dirs, ...listing.files].map((entry) => entry.name);
    });
  }

  listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]> {
    return this.run(async (client, target) => {
      const listing = await listDirectory(client, target, dir);
      return [
        ...listing.dirs.map((entry) => ({ name: entry.name, stat: statFrom(true, 0, entry.mtimeMs) })),
        ...listing.files.map((entry) => ({
          name: entry.name,
          stat: statFrom(false, entry.size, entry.mtimeMs),
        })),
      ];
    });
  }

  async mkdirp(p: string): Promise<void> {
    const path = normalizePath(p);
    if (path === "/") return;
    await this.run(async (client, target) => {
      const existing = await statPathOrNull(client, target, path);
      if (existing?.kind === "dir") return;
      if (existing) throw s3Error("EEXIST", `A file already exists at ${path}`);
      try {
        await createFolder(client, target, path);
      } catch (err) {
        // Lost a race with a concurrent mkdir: fine if the folder exists now.
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const now = await statPathOrNull(client, target, path);
        if (now?.kind !== "dir") throw err;
      }
    });
  }

  async createReadStream(p: string, options: ReadOptions = {}): Promise<Readable> {
    options.signal?.throwIfAborted();
    const { client, target } = this.context();
    const key = keyForPath(target.location, normalizePath(p));
    try {
      const head = await s3Call(() =>
        client.send<{ ContentLength?: number }>(new HeadObjectCommand({ Bucket: target.bucket, Key: key })),
      );
      const size = head.ContentLength ?? 0;
      options.signal?.throwIfAborted();
      if (size === 0) return Readable.from([]);
      const start = options.start ?? 0;
      const end = Math.min(options.end ?? size - 1, size - 1);
      if (start > end) return Readable.from([]);
      const out = await s3Call(() =>
        client.send<{ Body?: Readable }>(
          new GetObjectCommand({
            Bucket: target.bucket,
            Key: key,
            Range: `bytes=${start}-${end}`,
            ...(options.signal ? { abortSignal: options.signal } : {}),
          }),
        ),
      );
      if (!out.Body) throw s3Error("EIO", `S3 returned no body for ${p}`);
      const body = out.Body;
      if (!options.signal) return body;
      const abort = (): void => {
        body.destroy(new Error("Transfer interrupted"));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      body.once("close", () => options.signal?.removeEventListener("abort", abort));
      return body;
    } catch (err) {
      const normalized = normalizeS3Error(err);
      this.sessions.noteS3Failure(this.sessionId, normalized);
      throw normalized;
    }
  }

  async createWriteStream(p: string, _mode?: number, options: WriteOptions = {}): Promise<TransferWriteStream> {
    options.signal?.throwIfAborted();
    if ((options.start ?? 0) > 0) {
      throw s3Error("ENOTSUP", "S3 uploads cannot resume from a byte offset; the file restarts from zero");
    }
    const { raw, target } = this.context();
    const sessions = this.sessions;
    const sessionId = this.sessionId;
    const key = keyForPath(target.location, normalizePath(p));
    const input = new PassThrough({ highWaterMark: 1024 * 1024 });
    input.on("error", () => {});
    const upload = this.uploadFactory({
      client: raw,
      bucket: target.bucket,
      key,
      body: input,
    });
    let settled = false;
    let aborted = false;
    // Start consuming immediately: Upload.done() is what reads the body, so
    // waiting to call it until `_final` would deadlock on backpressure.
    const completion = upload.done();
    completion.catch(() => {});
    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      input.destroy();
      void upload.abort().catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    const output = new Writable({
      write(chunk, encoding, callback) {
        if (input.write(chunk, encoding)) callback();
        else input.once("drain", callback);
      },
      final(callback) {
        if (aborted) {
          callback(new Error("Transfer interrupted"));
          return;
        }
        input.end();
        // Finish only after the SDK confirms PutObject/multipart completion.
        completion.then(
          () => {
            settled = true;
            options.signal?.removeEventListener("abort", abort);
            callback();
          },
          (err: unknown) => {
            settled = true;
            options.signal?.removeEventListener("abort", abort);
            const normalized = normalizeS3Error(err);
            sessions.noteS3Failure(sessionId, normalized);
            callback(normalized);
          },
        );
      },
      destroy(err, callback) {
        if (!settled && !aborted) {
          aborted = true;
          input.destroy();
          void upload.abort().catch(() => {});
        }
        callback(err);
      },
    });
    output.on("error", () => {});
    options.signal?.addEventListener("abort", () => output.destroy(new Error("Transfer interrupted")), { once: true });
    if (options.signal?.aborted) output.destroy(new Error("Transfer interrupted"));
    return output;
  }

  setMeta(): Promise<void> {
    // S3 has no settable POSIX mode or source mtime; provider timestamps win.
    return Promise.resolve();
  }

  async renameReplacing(from: string, to: string): Promise<void> {
    await this.run(async (client, target) => {
      const fromKey = keyForPath(target.location, normalizePath(from));
      const toKey = keyForPath(target.location, normalizePath(to));
      if (fromKey === toKey) return;
      // Copy first: the existing final object survives a failed copy.
      await copyObject(client, target.bucket, fromKey, toKey);
      await s3Call(() => client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: fromKey })));
    });
  }

  async removeFile(p: string): Promise<void> {
    await this.run(async (client, target) => {
      const key = keyForPath(target.location, normalizePath(p));
      await s3Call(() => client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key })));
    });
  }

  dispose(): void {
    // The SDK client belongs to the session, not to one queue job.
  }
}
