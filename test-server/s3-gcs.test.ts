import {
  GCS_SINGLE_COPY_LIMIT,
  type S3Target,
  SINGLE_COPY_LIMIT,
  copyObject,
  copyOptionsFor,
  renamePath,
} from "../src/main/services/s3/s3-ops";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  createS3Client,
  credentialsFromProfile,
  resolveS3Config,
  s3ConfigFromProfile,
} from "../src/main/services/s3/s3-client";
import { describe, expect, test } from "bun:test";
import type { ConnectProfile } from "../src/shared/sftp/sftp.types";
import { Readable } from "node:stream";
import { Upload } from "@aws-sdk/lib-storage";
import { locationFor } from "../src/main/services/s3/s3-path";

const GIB = 1024 * 1024 * 1024;
const credentials = { accessKeyId: "GOOG1EXAMPLE", secretAccessKey: "secret" };

function gcsProfile(s3: Partial<NonNullable<ConnectProfile["s3"]>> = {}): ConnectProfile {
  return {
    protocol: "s3",
    host: "storage.googleapis.com",
    port: 443,
    username: credentials.accessKeyId,
    auth: { method: "s3", secretAccessKey: credentials.secretAccessKey },
    s3: { preset: "gcs", region: "auto", bucket: "my.bucket", ...s3 },
  };
}

describe("Google Cloud Storage preset config", () => {
  test("pins the XML API endpoint, auto region, and path-style addressing", () => {
    expect(s3ConfigFromProfile(gcsProfile())).toEqual({
      preset: "gcs",
      region: "auto",
      bucket: "my.bucket",
      endpoint: "https://storage.googleapis.com",
      forcePathStyle: true,
    });
  });

  test("ignores stored endpoint, region, and addressing overrides", () => {
    const config = resolveS3Config({
      preset: "gcs",
      endpoint: "https://s3.example.com",
      region: "us-west-2",
      bucket: " my-bucket ",
      forcePathStyle: false,
    });
    expect(config).toMatchObject({
      endpoint: "https://storage.googleapis.com",
      region: "auto",
      bucket: "my-bucket",
      forcePathStyle: true,
    });
  });

  test("still requires a valid bucket", () => {
    expect(() => resolveS3Config({ preset: "gcs", region: "", bucket: " " })).toThrow("Cloud Storage bucket is required");
    expect(() => resolveS3Config({ preset: "gcs", region: "", bucket: "a/b" })).toThrow("Invalid Cloud Storage bucket name");
  });

  test("leaves AWS and generic endpoints on their existing defaults", () => {
    expect(resolveS3Config({ region: "eu-west-1", bucket: "b" })).toEqual({
      region: "eu-west-1",
      bucket: "b",
      forcePathStyle: false,
    });
    expect(resolveS3Config({ endpoint: "https://minio.local:9000", region: "us-east-1", bucket: "b" })).toEqual({
      region: "us-east-1",
      bucket: "b",
      endpoint: "https://minio.local:9000",
      forcePathStyle: true,
    });
  });

  test("builds a client that only sends checksums when an operation requires one", async () => {
    const client = createS3Client(s3ConfigFromProfile(gcsProfile()), credentials);
    try {
      expect(await client.config.region()).toBe("auto");
      expect(client.config.forcePathStyle).toBe(true);
      expect(await client.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
      expect(await client.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
      const endpoint = await client.config.endpoint?.();
      expect(endpoint?.hostname).toBe("storage.googleapis.com");
      expect(endpoint?.protocol).toBe("https:");
    } finally {
      client.destroy();
    }
  });
});

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/** Answer every command in-process so lib-storage never touches the network. */
function captureCommands(client: S3Client): Sent[] {
  const sent: Sent[] = [];
  client.middlewareStack.add(
    (_next, context) => async (args) => {
      const commandName = String(context.commandName);
      sent.push({ name: commandName, input: args.input as Record<string, unknown> });
      const output =
        commandName === "CreateMultipartUploadCommand"
          ? { UploadId: "upload-1" }
          : commandName === "UploadPartCommand"
            ? { ETag: `"part-${(args.input as { PartNumber: number }).PartNumber}"` }
            : {};
      return { output: { ...output, $metadata: {} } as never, response: {} };
    },
    { step: "initialize", name: "captureCommands", priority: "high" },
  );
  return sent;
}

async function uploadMultipart(provider: "gcs" | "aws"): Promise<Sent[]> {
  const config =
    provider === "gcs" ? s3ConfigFromProfile(gcsProfile()) : resolveS3Config({ region: "us-east-1", bucket: "bucket" });
  const client = createS3Client(config, credentials);
  const sent = captureCommands(client);
  try {
    await new Upload({
      client,
      params: { Bucket: config.bucket, Key: "big.bin", Body: Buffer.alloc(9 * 1024 * 1024) },
      partSize: 8 * 1024 * 1024,
      queueSize: 1,
      leavePartsOnError: false,
    }).done();
  } finally {
    client.destroy();
  }
  return sent;
}

describe("Google Cloud Storage multipart upload", () => {
  test("lib-storage starts the upload without a default CRC32 checksum algorithm", async () => {
    const sent = await uploadMultipart("gcs");
    expect(sent.map((call) => call.name)).toEqual([
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "UploadPartCommand",
      "CompleteMultipartUploadCommand",
    ]);
    expect(sent[0].input.ChecksumAlgorithm).toBeUndefined();
  });

  test("AWS keeps the SDK's default CRC32 checksum", async () => {
    const sent = await uploadMultipart("aws");
    expect(sent[0]).toMatchObject({ name: "CreateMultipartUploadCommand", input: { ChecksumAlgorithm: "CRC32" } });
  });
});

/** Minimal fake: every key is a large object and copies always succeed. */
class LargeObjectS3 {
  readonly calls: Sent[] = [];
  readonly keys = new Set<string>(["big.bin"]);

  async send<T>(command: object): Promise<T> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    this.calls.push({ name, input });
    if (name === "HeadObjectCommand") {
      if (!this.keys.has(String(input.Key))) {
        throw Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      }
      return { ContentLength: 6 * GIB } as T;
    }
    if (name === "ListObjectsV2Command") return { KeyCount: 0, Contents: [] } as T;
    if (name === "CopyObjectCommand") this.keys.add(String(input.Key));
    if (name === "CreateMultipartUploadCommand") return { UploadId: "upload-1" } as T;
    if (name === "UploadPartCopyCommand") return { CopyPartResult: { ETag: '"part"' } } as T;
    return {} as T;
  }

  names(): string[] {
    return this.calls.map((call) => call.name);
  }
}

function target(preset?: string): S3Target {
  return { bucket: "bucket", location: locationFor(""), ...(preset ? { preset } : {}) };
}

describe("Google Cloud Storage server-side copy", () => {
  test("uses one CopyObject up to the 5 TiB object limit instead of UploadPartCopy", async () => {
    expect(copyOptionsFor(target("gcs"))).toEqual({ singleCopyLimit: GCS_SINGLE_COPY_LIMIT });
    expect(GCS_SINGLE_COPY_LIMIT).toBe(5 * 1024 * GIB);

    const client = new LargeObjectS3();
    await copyObject(client, "bucket", "big.bin", "copy.bin", copyOptionsFor(target("gcs")));
    expect(client.names()).toEqual(["HeadObjectCommand", "CopyObjectCommand"]);
  });

  test("renaming a large object on GCS never starts a multipart copy", async () => {
    const client = new LargeObjectS3();
    await renamePath(client, target("gcs"), "/big.bin", "/renamed.bin");
    expect(client.names()).not.toContain("UploadPartCopyCommand");
    expect(client.names()).toContain("CopyObjectCommand");
  });

  test("AWS, generic, and B2 targets keep multipart copy above 5 GB", async () => {
    expect(copyOptionsFor(target())).toEqual({});
    expect(copyOptionsFor(target("b2"))).toEqual({});
    expect(SINGLE_COPY_LIMIT).toBe(5_000_000_000);
    const client = new LargeObjectS3();
    await renamePath(client, target(), "/big.bin", "/renamed.bin");
    expect(client.names()).toContain("UploadPartCopyCommand");
    expect(client.names()).not.toContain("CopyObjectCommand");
  });
});

describe("Google Cloud Storage credentials", () => {
  test("drop a leftover session token, which HMAC keys never have", () => {
    const profile = gcsProfile();
    profile.auth = { method: "s3", secretAccessKey: "secret", sessionToken: "aws-token" };
    expect(credentialsFromProfile(profile)).toEqual(credentials);
  });

  test("generic S3 keeps its session token", () => {
    const profile = gcsProfile({ preset: undefined, region: "us-east-1" });
    profile.auth = { method: "s3", secretAccessKey: "secret", sessionToken: "aws-token" };
    expect(credentialsFromProfile(profile).sessionToken).toBe("aws-token");
  });
});

interface WireRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * Replace the HTTP handler so each request is fully built and signed, then
 * answered in-process: this is the request GCS would actually receive.
 */
function captureWire(
  client: S3Client,
  respond: (request: WireRequest) => { headers?: Record<string, string>; body?: string },
): WireRequest[] {
  const wire: WireRequest[] = [];
  (client.config as unknown as { requestHandler: unknown }).requestHandler = {
    handle: async (request: WireRequest & { body?: unknown }) => {
      const captured = { method: request.method, path: request.path, query: request.query, headers: { ...request.headers } };
      wire.push(captured);
      const answer = respond(captured);
      return {
        response: {
          statusCode: 200,
          headers: answer.headers ?? {},
          body: Readable.from([Buffer.from(answer.body ?? "")]),
        },
      };
    },
    destroy: () => {},
  };
  return wire;
}

function signedHeaders(request: WireRequest): string[] {
  return /SignedHeaders=([^,]+)/.exec(request.headers.authorization ?? "")?.[1].split(";") ?? [];
}

describe("Google Cloud Storage signed requests", () => {
  test("ranged reads ask for stored bytes, signed for region auto on a path-style URL", async () => {
    const client = createS3Client(s3ConfigFromProfile(gcsProfile()), credentials);
    const wire = captureWire(client, () => ({ body: "abc" }));
    try {
      await client.send(new GetObjectCommand({ Bucket: "my.bucket", Key: "a b.txt", Range: "bytes=0-2" }));
    } finally {
      client.destroy();
    }
    const [request] = wire;
    expect(request.headers.host).toBe("storage.googleapis.com");
    expect(request.path).toBe("/my.bucket/a%20b.txt");
    expect(request.headers.range).toBe("bytes=0-2");
    expect(request.headers["accept-encoding"]).toBe("gzip");
    expect(signedHeaders(request)).toContain("accept-encoding");
    expect(request.headers.authorization).toContain("/auto/s3/aws4_request");
  });

  test("AWS reads keep the SDK's default Accept-Encoding", async () => {
    const client = createS3Client(resolveS3Config({ region: "us-east-1", bucket: "bucket" }), credentials);
    const wire = captureWire(client, () => ({ body: "abc" }));
    try {
      await client.send(new GetObjectCommand({ Bucket: "bucket", Key: "a.txt", Range: "bytes=0-2" }));
    } finally {
      client.destroy();
    }
    expect(wire[0].headers["accept-encoding"]).toBeUndefined();
  });

  test("multipart upload sends no checksum headers or aws-chunked trailers", async () => {
    const client = createS3Client(s3ConfigFromProfile(gcsProfile()), credentials);
    const wire = captureWire(client, (request) => {
      if (request.method === "POST" && "uploads" in request.query) {
        return { body: "<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>" };
      }
      if (request.method === "PUT") return { headers: { etag: `"part-${String(request.query.partNumber)}"` } };
      return { body: '<CompleteMultipartUploadResult><ETag>"done"</ETag></CompleteMultipartUploadResult>' };
    });
    try {
      await new Upload({
        client,
        params: { Bucket: "my.bucket", Key: "big.bin", Body: Buffer.alloc(9 * 1024 * 1024) },
        partSize: 8 * 1024 * 1024,
        queueSize: 1,
        leavePartsOnError: false,
      }).done();
    } finally {
      client.destroy();
    }
    expect(wire.map((request) => request.method)).toEqual(["POST", "PUT", "PUT", "POST"]);
    for (const request of wire) {
      expect(request.path.startsWith("/my.bucket/big.bin")).toBe(true);
      expect(Object.keys(request.headers).filter((name) => /^x-amz-(sdk-)?checksum/.test(name))).toEqual([]);
      expect(request.headers["content-encoding"]).toBeUndefined();
      expect(request.headers["x-amz-content-sha256"]).not.toContain("STREAMING");
      expect(request.headers.authorization).toContain("/auto/s3/aws4_request");
    }
  });
});
