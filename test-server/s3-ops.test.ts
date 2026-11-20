import {
  type S3Like,
  type S3Target,
  copyObject,
  createFolder,
  listDirectory,
  readObjectBytes,
  removePath,
  renamePath,
  statKey,
  statPathOrNull,
  sumPrefixBytes,
} from "../src/main/services/s3/s3-ops";
import { describe, expect, test } from "bun:test";
import { locationFor } from "../src/main/services/s3/s3-path";

const MiB = 1024 * 1024;

interface FakeObject {
  size: number;
  body?: Buffer;
  etag: string;
  lastModified: Date;
}

type CommandInput = Record<string, unknown>;

interface Call {
  name: string;
  input: CommandInput;
}

class FakeS3 implements S3Like {
  readonly objects = new Map<string, FakeObject>();
  readonly calls: Call[] = [];
  deleteErrors: { Key?: string; Code?: string; Message?: string }[] = [];
  truncatedWithoutToken = false;
  failWhen?: (name: string, input: CommandInput) => Error | undefined;

  private uploadId = "upload-1";
  private nextEtag = 1;

  put(key: string, body: string | Buffer): void {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    this.objects.set(key, {
      size: buffer.length,
      body: buffer,
      etag: `etag-${this.nextEtag++}`,
      lastModified: new Date(1_700_000_000_000 + this.nextEtag * 1000),
    });
  }

  putSize(key: string, size: number): void {
    this.objects.set(key, {
      size,
      etag: `etag-${this.nextEtag++}`,
      lastModified: new Date(1_700_000_000_000 + this.nextEtag * 1000),
    });
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  names(): string[] {
    return this.calls.map((call) => call.name);
  }

  callsNamed(name: string): CommandInput[] {
    return this.calls.filter((call) => call.name === name).map((call) => call.input);
  }

  async send<T>(command: object): Promise<T> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: CommandInput }).input;
    this.calls.push({ name, input });
    const failure = this.failWhen?.(name, input);
    if (failure) throw failure;
    return (await this.handle(name, input)) as T;
  }

  private notFound(): Error {
    return Object.assign(new Error("The specified key does not exist."), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
  }

  private async handle(name: string, input: CommandInput): Promise<unknown> {
    switch (name) {
      case "HeadObjectCommand": {
        const object = this.objects.get(String(input.Key));
        if (!object) throw this.notFound();
        return {
          ContentLength: object.size,
          LastModified: object.lastModified,
          ETag: `"${object.etag}"`,
        };
      }
      case "ListObjectsV2Command":
        return this.list(input);
      case "GetObjectCommand": {
        const object = this.objects.get(String(input.Key));
        if (!object) throw this.notFound();
        const body = object.body ?? Buffer.alloc(object.size);
        const range = typeof input.Range === "string" ? /^bytes=(\d+)-(\d+)$/.exec(input.Range) : null;
        const data = range ? body.subarray(Number(range[1]), Number(range[2]) + 1) : body;
        return { Body: { transformToByteArray: async () => new Uint8Array(data) } };
      }
      case "PutObjectCommand": {
        const body = input.Body;
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
        this.put(String(input.Key), buffer);
        return {};
      }
      case "DeleteObjectsCommand": {
        const objects = (input.Delete as { Objects?: { Key?: string }[] } | undefined)?.Objects ?? [];
        for (const { Key } of objects) {
          if (!this.deleteErrors.some((error) => error.Key === Key)) this.objects.delete(String(Key));
        }
        return this.deleteErrors.length > 0 ? { Errors: this.deleteErrors } : {};
      }
      case "CopyObjectCommand": {
        const source = this.decodeCopySource(String(input.CopySource));
        const object = this.objects.get(source);
        if (!object) throw this.notFound();
        const copied: FakeObject = { ...object, etag: `etag-${this.nextEtag++}` };
        this.objects.set(String(input.Key), copied);
        return { CopyObjectResult: { ETag: `"${copied.etag}"` } };
      }
      case "CreateMultipartUploadCommand":
        return { UploadId: this.uploadId };
      case "UploadPartCopyCommand": {
        const part = Number(input.PartNumber);
        return { CopyPartResult: { ETag: `"etag-part-${part}"` } };
      }
      case "CompleteMultipartUploadCommand": {
        this.putSize(String(input.Key), 0);
        return {};
      }
      case "AbortMultipartUploadCommand":
        return {};
      default:
        throw new Error(`FakeS3 does not implement ${name}`);
    }
  }

  private list(input: CommandInput): unknown {
    const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
    const delimiter = typeof input.Delimiter === "string" ? input.Delimiter : undefined;
    const maxKeys = typeof input.MaxKeys === "number" ? input.MaxKeys : 1000;
    const offset = Number(input.ContinuationToken ?? 0);

    const entries = new Map<string, boolean>();
    for (const key of this.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf(delimiter);
        if (slash >= 0) entries.set(`${prefix}${rest.slice(0, slash + 1)}`, true);
        else entries.set(key, false);
      } else {
        entries.set(key, false);
      }
    }

    const all = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const page = all.slice(offset, offset + maxKeys);
    const truncated = this.truncatedWithoutToken || offset + page.length < all.length;
    return {
      Contents: page
        .filter(([, common]) => !common)
        .map(([key]) => {
          const object = this.objects.get(key);
          return { Key: key, Size: object?.size ?? 0, LastModified: object?.lastModified };
        }),
      CommonPrefixes: page.filter(([, common]) => common).map(([key]) => ({ Prefix: key })),
      KeyCount: page.length,
      IsTruncated: truncated,
      ...(truncated && !this.truncatedWithoutToken ? { NextContinuationToken: String(offset + page.length) } : {}),
    };
  }

  private decodeCopySource(source: string): string {
    const slash = source.indexOf("/");
    return source
      .slice(slash + 1)
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  }
}

function target(rootPrefix?: string): S3Target {
  return { bucket: "bucket", location: locationFor(rootPrefix) };
}

function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (err: NodeJS.ErrnoException) => err.code,
  );
}

describe("listDirectory", () => {
  test("paginates past the 1000-key page size without losing entries", async () => {
    const client = new FakeS3();
    for (let index = 0; index < 1005; index++) {
      client.put(`many/file-${String(index).padStart(4, "0")}.txt`, "");
    }

    const listing = await listDirectory(client, target(), "/many");
    expect(listing.files).toHaveLength(1005);
    expect(listing.dirs).toHaveLength(0);
    expect(new Set(listing.files.map((file) => file.name)).size).toBe(1005);

    const pages = client.callsNamed("ListObjectsV2Command");
    expect(pages).toHaveLength(2);
    expect(pages[0].ContinuationToken).toBeUndefined();
    expect(pages[1].ContinuationToken).toBe("1000");
    expect(pages[1].Prefix).toBe("many/");
  });

  test("turns CommonPrefixes into directories and keeps names relative", async () => {
    const client = new FakeS3();
    client.put("alpha/one.txt", "1");
    client.put("beta/two.txt", "22");
    client.put("root.txt", "333");
    client.put("beta/nested/deep.txt", "4");

    const listing = await listDirectory(client, target(), "/");
    expect(listing.path).toBe("/");
    expect(listing.dirs.map((dir) => dir.name)).toEqual(["alpha", "beta"]);
    expect(listing.dirs.map((dir) => dir.path)).toEqual(["/alpha", "/beta"]);
    expect(listing.files.map((file) => file.name)).toEqual(["root.txt"]);
    expect(listing.files[0].size).toBe(3);
    expect(listing.files[0].mode).toBe(0o100644);
    expect(listing.dirs[0].mode).toBe(0o040755);
  });

  test("maps listing onto a connection root prefix", async () => {
    const client = new FakeS3();
    client.put("photos/2024/cat.jpg", "cat");
    client.put("photos/readme.txt", "hi");

    const listing = await listDirectory(client, target("/photos"), "/2024");
    expect(listing.path).toBe("/2024");
    expect(listing.files.map((file) => file.name)).toEqual(["cat.jpg"]);
    expect(client.callsNamed("ListObjectsV2Command")[0].Prefix).toBe("photos/2024/");
  });

  test("suppresses the current directory's own marker", async () => {
    const client = new FakeS3();
    client.put("a/", "");
    client.put("a/file.txt", "x");

    const listing = await listDirectory(client, target(), "/a");
    expect(listing.files.map((file) => file.name)).toEqual(["file.txt"]);
    expect(listing.dirs).toHaveLength(0);
  });

  test("merges a zero-byte folder marker with the same common prefix once", async () => {
    const client = new FakeS3();
    client.put("sub/", "");
    client.put("sub/x.txt", "x");

    const root = await listDirectory(client, target(), "/");
    expect(root.files).toHaveLength(0);
    expect(root.dirs.map((dir) => dir.name)).toEqual(["sub"]);
    expect(root.dirs).toHaveLength(1);

    const inside = await listDirectory(client, target(), "/sub");
    expect(inside.dirs).toHaveLength(0);
    expect(inside.files.map((file) => file.name)).toEqual(["x.txt"]);
  });

  test("rejects an object and a folder that share a visible name", async () => {
    const client = new FakeS3();
    client.put("dup", "file");
    client.put("dup/inside.txt", "x");

    await expect(listDirectory(client, target(), "/")).rejects.toMatchObject({ code: "EAMBIGUOUS" });
  });

  test("rejects a truncated page that has no continuation token", async () => {
    const client = new FakeS3();
    client.put("a.txt", "x");
    client.truncatedWithoutToken = true;

    await expect(listDirectory(client, target(), "/")).rejects.toMatchObject({ code: "EIO" });
  });
});

describe("statKey", () => {
  test("reports files with size, mtime, and an unquoted etag", async () => {
    const client = new FakeS3();
    client.put("file.txt", "hello");
    const stat = await statKey(client, target(), "/file.txt");
    expect(stat.kind).toBe("file");
    expect(stat.size).toBe(5);
    expect(stat.etag).toStartWith("etag-");
    expect(stat.etag).not.toContain('"');
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  test("reports a directory when any key exists under its prefix", async () => {
    const client = new FakeS3();
    client.put("dir/deep/file.txt", "x");
    const stat = await statKey(client, target(), "/dir");
    expect(stat).toMatchObject({ kind: "dir", size: 0, mtimeMs: 0 });
  });

  test("treats the connection root as a directory", async () => {
    const client = new FakeS3();
    expect(await statKey(client, target(), "/")).toMatchObject({ kind: "dir" });
    expect(client.calls).toHaveLength(0);
  });

  test("throws ENOENT for a missing path and returns null via statPathOrNull", async () => {
    const client = new FakeS3();
    expect(await errorCode(statKey(client, target(), "/missing.txt"))).toBe("ENOENT");
    expect(await statPathOrNull(client, target(), "/missing.txt")).toBeNull();
  });

  test("propagates access denial instead of reporting a missing file", async () => {
    const client = new FakeS3();
    client.failWhen = (name) =>
      name === "HeadObjectCommand"
        ? Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
        : undefined;
    expect(await errorCode(statKey(client, target(), "/secret.txt"))).toBe("EACCES");
    expect(client.callsNamed("ListObjectsV2Command")).toHaveLength(0);
  });

  test("propagates non-ENOENT failures from statPathOrNull", async () => {
    const client = new FakeS3();
    client.failWhen = (name) =>
      name === "HeadObjectCommand"
        ? Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
        : undefined;
    expect(await errorCode(statPathOrNull(client, target(), "/secret.txt"))).toBe("EACCES");
  });
});

describe("createFolder", () => {
  test("writes a trailing-slash directory marker", async () => {
    const client = new FakeS3();
    await createFolder(client, target(), "/new folder");
    const puts = client.callsNamed("PutObjectCommand");
    expect(puts).toHaveLength(1);
    expect(puts[0].Key).toBe("new folder/");
    expect(puts[0].Body).toBe("");
    expect(client.objects.has("new folder/")).toBe(true);
  });

  test("refuses the connection root", async () => {
    const client = new FakeS3();
    expect(await errorCode(createFolder(client, target(), "/"))).toBe("EEXIST");
  });
});

describe("readObjectBytes", () => {
  test("reads a bounded range and reports the total size", async () => {
    const client = new FakeS3();
    client.put("preview.bin", "abcdefghij");
    const out = await readObjectBytes(client, target(), "/preview.bin", 4);
    expect(out.totalSize).toBe(10);
    expect(out.data.toString()).toBe("abcd");
    expect(client.callsNamed("GetObjectCommand")[0].Range).toBe("bytes=0-3");
  });

  test("caps the range at the object size", async () => {
    const client = new FakeS3();
    client.put("small.bin", "abc");
    const out = await readObjectBytes(client, target(), "/small.bin", 100);
    expect(out.data.toString()).toBe("abc");
    expect(client.callsNamed("GetObjectCommand")[0].Range).toBe("bytes=0-2");
  });

  test("reads an empty object without a Range request", async () => {
    const client = new FakeS3();
    client.put("empty.bin", Buffer.alloc(0));
    const out = await readObjectBytes(client, target(), "/empty.bin", 64);
    expect(out.data).toHaveLength(0);
    expect(out.totalSize).toBe(0);
    expect(client.callsNamed("GetObjectCommand")).toHaveLength(0);
  });

  test("skips the body for a non-positive limit", async () => {
    const client = new FakeS3();
    client.put("file.bin", "abc");
    const out = await readObjectBytes(client, target(), "/file.bin", 0);
    expect(out.data).toHaveLength(0);
    expect(out.totalSize).toBe(3);
    expect(client.callsNamed("GetObjectCommand")).toHaveLength(0);
  });

  test("throws ENOENT for a missing object", async () => {
    const client = new FakeS3();
    expect(await errorCode(readObjectBytes(client, target(), "/missing.bin", 1))).toBe("ENOENT");
  });
});

describe("sumPrefixBytes", () => {
  test("adds object sizes and ignores directory markers", async () => {
    const client = new FakeS3();
    client.put("size/a.bin", "abc");
    client.put("size/b.bin", "12345678");
    client.put("size/empty/", "");
    client.put("size/nested/c.bin", "xx");
    client.put("outside.bin", "ignored");

    expect(await sumPrefixBytes(client, target(), "/size")).toBe(13);
  });
});

describe("removePath", () => {
  test("deletes a single object", async () => {
    const client = new FakeS3();
    client.put("one.txt", "x");
    await removePath(client, target(), "/one.txt");
    expect(client.keys()).toEqual([]);
    expect(client.callsNamed("DeleteObjectsCommand")[0].Delete).toEqual({
      Objects: [{ Key: "one.txt" }],
      Quiet: true,
    });
  });

  test("batches recursive deletes at 1000 keys per request", async () => {
    const client = new FakeS3();
    for (let index = 0; index < 2500; index++) {
      client.putSize(`bulk/${String(index).padStart(5, "0")}`, 1);
    }

    await removePath(client, target(), "/bulk");
    const batches = client
      .callsNamed("DeleteObjectsCommand")
      .map((input) => (input.Delete as { Objects: { Key: string }[] }).Objects);
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 500]);
    expect(batches.flat().map((object) => object.Key)).toHaveLength(2500);
    expect(client.objects.size).toBe(0);
  });

  test("surfaces per-key delete errors", async () => {
    const client = new FakeS3();
    client.put("dir/ok.txt", "x");
    client.put("dir/denied.txt", "y");
    client.deleteErrors = [{ Key: "dir/denied.txt", Code: "AccessDenied", Message: "Denied" }];

    const err = await removePath(client, target(), "/dir").catch((error: Error) => error);
    expect((err as NodeJS.ErrnoException).code).toBe("EIO");
    expect((err as Error).message).toContain("dir/denied.txt");
    expect((err as Error).message).toContain("AccessDenied");
  });

  test("refuses to delete the connection root and ignores missing paths", async () => {
    const client = new FakeS3();
    expect(await errorCode(removePath(client, target(), "/"))).toBe("EINVAL");
    await removePath(client, target(), "/never-existed");
    expect(client.callsNamed("DeleteObjectsCommand")).toHaveLength(0);
  });
});

describe("renamePath", () => {
  test("copies a file before deleting the source", async () => {
    const client = new FakeS3();
    client.put("a.txt", "hello");

    await renamePath(client, target(), "/a.txt", "/b.txt");
    expect(client.objects.has("a.txt")).toBe(false);
    expect(client.objects.get("b.txt")?.body?.toString()).toBe("hello");

    const names = client.names();
    const copy = names.indexOf("CopyObjectCommand");
    const remove = names.indexOf("DeleteObjectsCommand");
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(copy);
  });

  test("refuses to overwrite an existing file", async () => {
    const client = new FakeS3();
    client.put("a.txt", "a");
    client.put("b.txt", "b");

    expect(await errorCode(renamePath(client, target(), "/a.txt", "/b.txt"))).toBe("EEXIST");
    expect(client.callsNamed("CopyObjectCommand")).toHaveLength(0);
    expect(client.objects.get("a.txt")?.body?.toString()).toBe("a");
    expect(client.objects.get("b.txt")?.body?.toString()).toBe("b");
  });

  test("refuses a destination directory that already has objects", async () => {
    const client = new FakeS3();
    client.put("src/a.txt", "a");
    client.put("dst/existing.txt", "e");

    expect(await errorCode(renamePath(client, target(), "/src", "/dst"))).toBe("EEXIST");
    expect(client.callsNamed("CopyObjectCommand")).toHaveLength(0);
    expect(client.callsNamed("DeleteObjectsCommand")).toHaveLength(0);
  });

  test("refuses to move a folder into its own descendant", async () => {
    const client = new FakeS3();
    client.put("a/x.txt", "x");
    expect(await errorCode(renamePath(client, target(), "/a", "/a/b"))).toBe("EINVAL");
    expect(client.callsNamed("CopyObjectCommand")).toHaveLength(0);
  });

  test("copies every descendant before deleting any source", async () => {
    const client = new FakeS3();
    client.put("movie/1.mp4", "one");
    client.put("movie/2.mp4", "two");

    await renamePath(client, target(), "/movie", "/show");
    expect(client.keys()).toEqual(["show/1.mp4", "show/2.mp4"]);
    expect(client.objects.get("show/2.mp4")?.body?.toString()).toBe("two");

    const names = client.names();
    const deletes = names.indexOf("DeleteObjectsCommand");
    const copies = names.map((name, index) => (name === "CopyObjectCommand" ? index : -1)).filter((index) => index >= 0);
    expect(copies).toHaveLength(2);
    expect(Math.max(...copies)).toBeLessThan(deletes);
  });

  test("leaves every source untouched when a descendant copy fails", async () => {
    const client = new FakeS3();
    client.put("movie/1.mp4", "one");
    client.put("movie/2.mp4", "two");
    client.failWhen = (name, input) =>
      name === "CopyObjectCommand" && String(input.Key).endsWith("2.mp4")
        ? Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
        : undefined;

    const err = await renamePath(client, target(), "/movie", "/show").catch((error: Error) => error);
    expect((err as NodeJS.ErrnoException).code).toBe("EIO");
    expect((err as Error).message).toContain("left intact");
    expect(client.callsNamed("DeleteObjectsCommand")).toHaveLength(0);
    expect(client.objects.has("movie/1.mp4")).toBe(true);
    expect(client.objects.has("movie/2.mp4")).toBe(true);
  });
});

describe("copyObject", () => {
  test("uses a single server-side copy below the limit", async () => {
    const client = new FakeS3();
    client.put("small.bin", "hello");

    await copyObject(client, "bucket", "small.bin", "copy.bin");
    expect(client.objects.get("copy.bin")?.body?.toString()).toBe("hello");
    expect(client.callsNamed("CreateMultipartUploadCommand")).toHaveLength(0);

    const copy = client.callsNamed("CopyObjectCommand")[0];
    expect(copy.CopySource).toBe("bucket/small.bin");
    expect(copy.Key).toBe("copy.bin");
  });

  test("encodes reserved characters in CopySource", async () => {
    const client = new FakeS3();
    client.put("dir/a+b c.txt", "x");
    await copyObject(client, "bucket", "dir/a+b c.txt", "out.txt");
    expect(client.callsNamed("CopyObjectCommand")[0].CopySource).toBe("bucket/dir/a%2Bb%20c.txt");
  });

  test("copies large objects in ordered parts", async () => {
    const client = new FakeS3();
    client.putSize("big.bin", 5 * MiB + 1);

    await copyObject(client, "bucket", "big.bin", "big-copy.bin", {
      singleCopyLimit: 0,
      partSize: 1,
    });

    expect(client.callsNamed("CreateMultipartUploadCommand")[0]).toMatchObject({
      Bucket: "bucket",
      Key: "big-copy.bin",
    });

    const parts = client.callsNamed("UploadPartCopyCommand");
    expect(parts.map((part) => part.PartNumber)).toEqual([1, 2]);
    expect(parts.map((part) => part.CopySourceRange)).toEqual([`bytes=0-${5 * MiB - 1}`, `bytes=${5 * MiB}-${5 * MiB}`]);
    for (const part of parts) {
      expect(part.UploadId).toBe("upload-1");
      expect(part.CopySource).toBe("bucket/big.bin");
    }

    expect(client.callsNamed("CompleteMultipartUploadCommand")[0]).toMatchObject({
      Bucket: "bucket",
      Key: "big-copy.bin",
      UploadId: "upload-1",
      MultipartUpload: {
        Parts: [
          { ETag: '"etag-part-1"', PartNumber: 1 },
          { ETag: '"etag-part-2"', PartNumber: 2 },
        ],
      },
    });
    expect(client.callsNamed("AbortMultipartUploadCommand")).toHaveLength(0);
  });

  test("aborts the upload and keeps the destination when a part fails", async () => {
    const client = new FakeS3();
    client.putSize("big.bin", 5 * MiB + 1);
    client.put("dest.bin", "original");
    client.failWhen = (name, input) =>
      name === "UploadPartCopyCommand" && input.PartNumber === 2
        ? Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
        : undefined;

    expect(await errorCode(copyObject(client, "bucket", "big.bin", "dest.bin", { singleCopyLimit: 0, partSize: 1 }))).toBe(
      "EACCES",
    );

    expect(client.callsNamed("AbortMultipartUploadCommand")[0]).toMatchObject({
      Bucket: "bucket",
      Key: "dest.bin",
      UploadId: "upload-1",
    });
    expect(client.callsNamed("CompleteMultipartUploadCommand")).toHaveLength(0);
    expect(client.callsNamed("DeleteObjectsCommand")).toHaveLength(0);
    expect(client.objects.get("dest.bin")?.body?.toString()).toBe("original");
  });

  test("is a no-op for identical keys and rejects missing sources", async () => {
    const client = new FakeS3();
    client.put("one.bin", "x");

    await copyObject(client, "bucket", "one.bin", "one.bin");
    expect(client.calls).toHaveLength(0);

    expect(await errorCode(copyObject(client, "bucket", "missing.bin", "out.bin"))).toBe("ENOENT");
  });
});
