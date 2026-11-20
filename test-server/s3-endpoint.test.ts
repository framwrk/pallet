import { S3Endpoint, type S3UploadFactory } from "../src/main/services/s3/s3-endpoint";
import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import { locationFor } from "../src/main/services/s3/s3-path";

interface Call {
  name: string;
  input: Record<string, unknown>;
}

class FakeClient {
  readonly calls: Call[] = [];
  readonly objects = new Map<string, Buffer>();
  failWhen?: (name: string, input: Record<string, unknown>) => Error | undefined;

  getRange(): unknown {
    return this.calls.filter((call) => call.name === "GetObjectCommand")[0]?.input.Range;
  }

  getNames(): string[] {
    return this.calls.map((call) => call.name);
  }

  async send<T>(command: object): Promise<T> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    this.calls.push({ name, input });
    const failure = this.failWhen?.(name, input);
    if (failure) throw failure;
    switch (name) {
      case "HeadObjectCommand": {
        const body = this.objects.get(String(input.Key));
        if (!body) {
          throw Object.assign(new Error("Not Found"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        return { ContentLength: body.length, ETag: '"etag-1"', LastModified: new Date(1_700_000_000_000) } as T;
      }
      case "GetObjectCommand": {
        const body = this.objects.get(String(input.Key));
        if (!body) throw new Error("Missing fake object");
        const match = /^bytes=(\d+)-(\d+)$/.exec(String(input.Range));
        const data = match ? body.subarray(Number(match[1]), Number(match[2]) + 1) : body;
        return { Body: Readable.from([data]) } as T;
      }
      case "CopyObjectCommand": {
        const decoded = String(input.CopySource)
          .split("/")
          .slice(1)
          .map((segment) => decodeURIComponent(segment))
          .join("/");
        const body = this.objects.get(decoded);
        if (!body) {
          throw Object.assign(new Error("Not Found"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        }
        this.objects.set(String(input.Key), Buffer.from(body));
        return {} as T;
      }
      case "DeleteObjectCommand":
        this.objects.delete(String(input.Key));
        return {} as T;
      default:
        throw new Error(`FakeClient does not implement ${name}`);
    }
  }
}

function setup(factory?: S3UploadFactory): {
  client: FakeClient;
  endpoint: S3Endpoint;
  failures: NodeJS.ErrnoException[];
  uploads: { bucket: string; key: string; body: Readable }[];
} {
  const client = new FakeClient();
  const failures: NodeJS.ErrnoException[] = [];
  const uploads: { bucket: string; key: string; body: Readable }[] = [];
  const sessions = {
    s3Session: () => ({ client, target: { bucket: "bucket", location: locationFor() } }),
    noteS3Failure: (_sessionId: string, err: NodeJS.ErrnoException) => failures.push(err),
  } as unknown as SessionManager;
  const recordingFactory: S3UploadFactory = (input) => {
    uploads.push(input);
    return factory ? factory(input) : { done: async () => ({}), abort: async () => {} };
  };
  return { client, endpoint: new S3Endpoint(sessions, "session-1", recordingFactory), failures, uploads };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

test("S3Endpoint reports that it cannot resume ranges", () => {
  const { endpoint } = setup();
  expect(endpoint.supportsRanges).toBe(false);
  expect(endpoint.writesMeta).toBe(false);
  expect(endpoint.kind).toBe("sftp");
});

test("ranged reads ask for exactly the requested byte range", async () => {
  const { client, endpoint } = setup();
  client.objects.set("read.bin", Buffer.from("0123456789"));

  const stream = await endpoint.createReadStream("/read.bin", { start: 2, end: 4 });
  expect((await collect(stream)).toString()).toBe("234");
  expect(client.getRange()).toBe("bytes=2-4");
});

test("a full read defaults to the whole object", async () => {
  const { client, endpoint } = setup();
  client.objects.set("read.bin", Buffer.from("abcdef"));

  const stream = await endpoint.createReadStream("/read.bin");
  expect((await collect(stream)).toString()).toBe("abcdef");
  expect(client.getRange()).toBe("bytes=0-5");
});

test("an empty object returns an empty stream without a Range request", async () => {
  const { client, endpoint } = setup();
  client.objects.set("empty.bin", Buffer.alloc(0));

  const stream = await endpoint.createReadStream("/empty.bin");
  expect(await collect(stream)).toHaveLength(0);
  expect(client.getNames()).toEqual(["HeadObjectCommand"]);
});

test("an inverted range returns an empty stream without downloading", async () => {
  const { client, endpoint } = setup();
  client.objects.set("read.bin", Buffer.from("abcdef"));

  const stream = await endpoint.createReadStream("/read.bin", { start: 5, end: 2 });
  expect(await collect(stream)).toHaveLength(0);
  expect(client.getRange()).toBeUndefined();
});

test("maps a missing object to ENOENT and reports the failure", async () => {
  const { endpoint, failures } = setup();
  await expect(endpoint.createReadStream("/missing.bin")).rejects.toMatchObject({ code: "ENOENT" });
  expect(failures.map((err) => err.code)).toEqual(["ENOENT"]);
});

test("maps a denied read to EACCES", async () => {
  const { client, endpoint } = setup();
  client.failWhen = (name) =>
    name === "HeadObjectCommand"
      ? Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
      : undefined;
  await expect(endpoint.createReadStream("/secret.bin")).rejects.toMatchObject({ code: "EACCES" });
});

test("a write stream finishes only after the upload's done() resolves", async () => {
  const done = deferred<unknown>();
  const { endpoint, uploads } = setup(() => ({ done: () => done.promise, abort: async () => {} }));
  const stream = await endpoint.createWriteStream("/upload.bin", 0o644);
  expect(uploads[0]).toMatchObject({ bucket: "bucket", key: "upload.bin" });

  let finished = false;
  stream.on("finish", () => (finished = true));
  const finish = deferred<void>();
  stream.on("finish", () => finish.resolve());
  stream.end(Buffer.from("hello"));
  await tick();
  expect(finished).toBe(false);

  done.resolve({});
  await finish.promise;
  expect(finished).toBe(true);
});

test("starts upload.done() as soon as the write stream is created", async () => {
  const done = deferred<unknown>();
  let doneCalls = 0;
  const { endpoint, uploads } = setup(() => ({
    done: () => {
      doneCalls++;
      return done.promise;
    },
    abort: async () => {},
  }));

  const stream = await endpoint.createWriteStream("/eager.bin", 0o644);
  expect(doneCalls).toBe(1);
  expect(uploads[0]).toMatchObject({ bucket: "bucket", key: "eager.bin" });
  expect(uploads[0].body).toBeDefined();

  const finished = deferred<void>();
  stream.once("finish", () => finished.resolve());
  stream.end(Buffer.from("body"));
  await tick();
  expect(doneCalls).toBe(1);

  done.resolve({});
  await finished.promise;
  expect(doneCalls).toBe(1);
});

test("done() rejection fails the write stream with the normalized error", async () => {
  const done = deferred<unknown>();
  const { endpoint, failures } = setup(() => ({ done: () => done.promise, abort: async () => {} }));
  const stream = await endpoint.createWriteStream("/denied.bin");
  const failed = new Promise<NodeJS.ErrnoException>((resolve) => stream.once("error", resolve));
  stream.end(Buffer.from("hello"));
  await tick();

  done.reject(Object.assign(new Error("Access Denied"), { name: "AccessDenied" }));
  const err = await failed;
  expect(err.code).toBe("EACCES");
  expect(failures.map((failure) => failure.code)).toEqual(["EACCES"]);
});

test("aborting a write calls upload.abort()", async () => {
  const done = deferred<unknown>();
  let aborts = 0;
  const { endpoint } = setup(() => ({
    done: () => done.promise,
    abort: async () => {
      aborts++;
    },
  }));
  const controller = new AbortController();
  const stream = await endpoint.createWriteStream("/aborted.bin", 0o644, { signal: controller.signal });
  stream.write(Buffer.from("partial"));
  controller.abort();
  await tick();

  expect(aborts).toBeGreaterThanOrEqual(1);
  expect(stream.destroyed).toBe(true);
});

test("an immediately aborted signal destroys the write stream without an upload", async () => {
  const { endpoint, uploads } = setup();
  const controller = new AbortController();
  controller.abort();
  await expect(endpoint.createWriteStream("/never.bin", 0o644, { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(uploads).toHaveLength(0);
});

test("refuses to resume an upload from a byte offset", async () => {
  const { endpoint, uploads } = setup();
  await expect(endpoint.createWriteStream("/resume.bin", 0o644, { start: 10 })).rejects.toMatchObject({
    code: "ENOTSUP",
  });
  expect(uploads).toHaveLength(0);
});

test("setMeta is a no-op", async () => {
  const { client, endpoint } = setup();
  await expect(endpoint.setMeta("/file.bin", { mtimeMs: 1_700_000_000_000, mode: 0o600 })).resolves.toBeUndefined();
  expect(client.calls).toHaveLength(0);
});

test("renameReplacing copies before deleting the source", async () => {
  const { client, endpoint } = setup();
  client.objects.set("old.bin", Buffer.from("payload"));

  await endpoint.renameReplacing("/old.bin", "/new.bin");
  expect(client.objects.has("old.bin")).toBe(false);
  expect(client.objects.get("new.bin")?.toString()).toBe("payload");

  const names = client.getNames();
  expect(names.indexOf("CopyObjectCommand")).toBeLessThan(names.indexOf("DeleteObjectCommand"));
});

test("renameReplacing never deletes the source when the copy fails", async () => {
  const { client, endpoint, failures } = setup();
  client.objects.set("old.bin", Buffer.from("payload"));
  client.failWhen = (name) =>
    name === "CopyObjectCommand"
      ? Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })
      : undefined;

  await expect(endpoint.renameReplacing("/old.bin", "/new.bin")).rejects.toMatchObject({ code: "EACCES" });
  expect(client.getNames()).not.toContain("DeleteObjectCommand");
  expect(client.objects.get("old.bin")?.toString()).toBe("payload");
  expect(failures.map((err) => err.code)).toEqual(["EACCES"]);
});

test("removeFile deletes exactly one key", async () => {
  const { client, endpoint } = setup();
  client.objects.set("gone.bin", Buffer.from("x"));
  await endpoint.removeFile("/gone.bin");
  expect(client.objects.has("gone.bin")).toBe(false);
});
