/**
 * Read and small write operations for an S3 session. The service is a thin
 * session-bound wrapper over s3-ops: it resolves the checked client, maps
 * entries into the shared shape, and reports connectivity failures to the
 * session manager so only genuine outages reconnect.
 */
import type { DirListing, Entry } from "@shared/fs/fs.types";
import {
  type S3Like,
  type S3Target,
  createFolder,
  listDirectory,
  readObjectBytes,
  removePath,
  renamePath,
  statKey,
  sumPrefixBytes,
} from "./s3-ops";
import { S3_DIR_MODE, S3_FILE_MODE, normalizePath, prefixForPath } from "./s3-path";
import { normalizeS3Error, s3Error } from "./s3-client";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { SessionManager } from "../sftp/session-manager";

function dirEntry(path: string): Entry {
  const name = path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  return { name, path, kind: "dir", size: 0, mtimeMs: 0, mode: S3_DIR_MODE, hidden: name.startsWith(".") };
}

export class S3Service {
  constructor(private sessions: SessionManager) {}

  private async run<T>(sessionId: string, fn: (client: S3Like, target: S3Target) => Promise<T>): Promise<T> {
    const { client, target } = this.sessions.s3Session(sessionId);
    try {
      return await fn(client, target);
    } catch (err) {
      const normalized = normalizeS3Error(err);
      this.sessions.noteS3Failure(sessionId, normalized);
      throw normalized;
    }
  }

  async list(sessionId: string, dirPath: string): Promise<DirListing> {
    return this.run(sessionId, async (client, target) => {
      const listing = await listDirectory(client, target, dirPath);
      return { path: listing.path, entries: [...listing.dirs, ...listing.files], availBytes: null };
    });
  }

  async stat(sessionId: string, p: string): Promise<Entry> {
    return this.run(sessionId, async (client, target) => {
      const stat = await statKey(client, target, p);
      const path = normalizePath(p);
      if (stat.kind === "dir") return { ...dirEntry(path), mtimeMs: stat.mtimeMs };
      const name = path.slice(path.lastIndexOf("/") + 1);
      return {
        name,
        path,
        kind: "file",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: S3_FILE_MODE,
        hidden: name.startsWith("."),
      };
    });
  }

  async realpath(sessionId: string, p: string): Promise<string> {
    // S3 has no symlinks or server-side realpath; validation is the whole job.
    this.sessions.s3Session(sessionId);
    return normalizePath(p);
  }

  async mkdir(sessionId: string, p: string): Promise<void> {
    await this.run(sessionId, (client, target) => createFolder(client, target, p));
  }

  /** Create "untitled folder" (auto-numbered) inside dirPath; returns name. */
  async mkdirUnique(sessionId: string, dirPath: string): Promise<string> {
    const listing = await this.list(sessionId, dirPath);
    const names = new Set(listing.entries.map((entry) => entry.name));
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? "untitled folder" : `untitled folder ${i}`;
      if (!names.has(name)) {
        await this.mkdir(sessionId, `${listing.path === "/" ? "" : listing.path}/${name}`);
        return name;
      }
    }
    throw new Error("Could not find a free folder name");
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    await this.run(sessionId, (client, target) => renamePath(client, target, from, to));
  }

  async removeRecursive(sessionId: string, p: string): Promise<void> {
    await this.run(sessionId, (client, target) => removePath(client, target, p));
  }

  chmod(): Promise<void> {
    return Promise.reject(s3Error("ENOTSUP", "S3 objects do not have editable POSIX permissions"));
  }

  async readBytes(sessionId: string, p: string, maxBytes: number): Promise<Buffer> {
    return this.run(sessionId, async (client, target) => (await readObjectBytes(client, target, p, maxBytes)).data);
  }

  async folderSize(sessionId: string, p: string): Promise<number> {
    return this.run(sessionId, (client, target) => sumPrefixBytes(client, target, p));
  }

  /** True when the bucket/prefix still answers; used only by tests and tools. */
  async probe(sessionId: string): Promise<void> {
    await this.run(sessionId, async (client, target) => {
      await client.send(
        new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefixForPath(target.location, "/"), MaxKeys: 1 }),
      );
    });
  }
}
