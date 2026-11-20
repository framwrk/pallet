import { describe, expect, test } from "bun:test";
import {
  isConnectivityError,
  normalizeS3Error,
  resolveS3Config,
  s3Call,
  s3Error,
  validateEndpoint,
} from "../src/main/services/s3/s3-client";
import type { S3ConnectionOptions } from "../src/shared/sftp/sftp.types";

function options(overrides: Partial<S3ConnectionOptions> = {}): S3ConnectionOptions {
  return { region: "us-east-1", bucket: "my-bucket", ...overrides } as S3ConnectionOptions;
}

function sdkError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${name} failure`), { name, ...extra });
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
  return undefined;
}

function validationCode(fn: () => unknown): string | undefined {
  const code = errorCode(fn);
  expect(code).toBe("EINVAL");
  return code;
}

function normalizedValidationCode(err: unknown): string | undefined {
  const code = normalizeS3Error(err).code;
  expect(code).toBe("EINVAL");
  return code;
}

describe("validateEndpoint", () => {
  test("accepts http(s) origins and returns the normalized origin", () => {
    expect(validateEndpoint("https://s3.us-east-1.amazonaws.com")).toBe("https://s3.us-east-1.amazonaws.com");
    expect(validateEndpoint("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000");
    expect(validateEndpoint("  http://localhost:9000  ")).toBe("http://localhost:9000");
    expect(validateEndpoint("HTTP://MinIO.Local:9000")).toBe("http://minio.local:9000");
    expect(validateEndpoint(undefined)).toBeUndefined();
    expect(validateEndpoint("")).toBeUndefined();
    expect(validateEndpoint("   ")).toBeUndefined();
  });

  test("rejects non-absolute and non-http(s) endpoints", () => {
    for (const endpoint of ["example.com:9000", "ftp://example.com", "file:///srv/s3", "s3://bucket"]) {
      validationCode(() => validateEndpoint(endpoint));
    }
    validationCode(() => validateEndpoint("http://"));
  });

  test("rejects embedded credentials, query strings, and fragments", () => {
    for (const endpoint of [
      "http://user:secret@example.com",
      "http://user@example.com",
      "https://example.com/?token=abc",
      "https://example.com/#fragment",
    ]) {
      validationCode(() => validateEndpoint(endpoint));
    }
  });

  test("rejects a path prefix so keys can never be silently rebased", () => {
    for (const endpoint of ["https://example.com/prefix", "https://example.com/prefix/"]) {
      validationCode(() => validateEndpoint(endpoint));
    }
  });
});

describe("resolveS3Config", () => {
  test("requires a region and bucket and trims surrounding whitespace", () => {
    validationCode(() => resolveS3Config(options({ region: "  " })));
    validationCode(() => resolveS3Config(options({ bucket: "" })));
    expect(resolveS3Config(options({ region: " eu-west-1 ", bucket: " photos " }))).toMatchObject({
      region: "eu-west-1",
      bucket: "photos",
    });
  });

  test("rejects bucket names that are not a single safe label", () => {
    for (const bucket of ["bad bucket", "a/b", "bucket\nname"]) {
      validationCode(() => resolveS3Config(options({ bucket })));
    }
  });

  test("defaults path-style on for custom endpoints and off for AWS", () => {
    expect(resolveS3Config(options()).forcePathStyle).toBe(false);

    const custom = resolveS3Config(options({ endpoint: "http://127.0.0.1:9000" }));
    expect(custom.forcePathStyle).toBe(true);
    expect(custom.endpoint).toBe("http://127.0.0.1:9000");

    expect(resolveS3Config(options({ endpoint: "http://127.0.0.1:9000", forcePathStyle: false })).forcePathStyle).toBe(false);
    expect(resolveS3Config(options({ forcePathStyle: true })).forcePathStyle).toBe(true);
  });

  test("omits the endpoint key entirely for AWS", () => {
    expect("endpoint" in resolveS3Config(options())).toBe(false);
  });
});

describe("normalizeS3Error", () => {
  test("maps missing objects to ENOENT", () => {
    expect(normalizeS3Error(sdkError("NoSuchKey")).code).toBe("ENOENT");
    expect(normalizeS3Error(sdkError("NotFound")).code).toBe("ENOENT");
    expect(normalizeS3Error(sdkError("NoSuchVersion")).code).toBe("ENOENT");
    expect(normalizeS3Error(sdkError("Whatever", { $metadata: { httpStatusCode: 404 } })).code).toBe("ENOENT");
  });

  test("maps access failures to EACCES", () => {
    expect(normalizeS3Error(sdkError("AccessDenied")).code).toBe("EACCES");
    expect(normalizeS3Error(sdkError("InvalidAccessKeyId")).code).toBe("EACCES");
    expect(normalizeS3Error(sdkError("SignatureDoesNotMatch")).code).toBe("EACCES");
    expect(normalizeS3Error(sdkError("Forbidden", { $metadata: { httpStatusCode: 403 } })).code).toBe("EACCES");
    expect(normalizeS3Error(sdkError("CredentialsError")).code).toBe("EACCES");
  });

  test("maps expired tokens to EEXPIRED", () => {
    expect(normalizeS3Error(sdkError("ExpiredToken")).code).toBe("EEXPIRED");
    expect(normalizeS3Error(sdkError("ExpiredTokenException")).code).toBe("EEXPIRED");
    expect(normalizeS3Error(sdkError("Unknown", { message: "The provided token has expired" })).code).toBe("EEXPIRED");
  });

  test("maps configuration failures to a validation code", () => {
    normalizedValidationCode(sdkError("NoSuchBucket"));
    normalizedValidationCode(sdkError("InvalidBucketName"));
    normalizedValidationCode(sdkError("InvalidRegion"));
  });

  test("maps precondition failures to EEXIST", () => {
    expect(normalizeS3Error(sdkError("PreconditionFailed")).code).toBe("EEXIST");
    expect(normalizeS3Error(sdkError("Unknown", { message: "The object already exists" })).code).toBe("EEXIST");
  });

  test("keeps socket and 5xx failures as connectivity errors", () => {
    expect(normalizeS3Error(sdkError("NetworkingError", { code: "ECONNRESET" })).code).toBe("ECONNRESET");
    expect(normalizeS3Error(sdkError("NetworkingError", { code: "ECONNREFUSED" })).code).toBe("ECONNREFUSED");
    expect(normalizeS3Error(sdkError("TimeoutError", { code: "ETIMEDOUT" })).code).toBe("ETIMEDOUT");
    expect(normalizeS3Error(sdkError("ServiceUnavailable", { $metadata: { httpStatusCode: 503 } })).code).toBe("ECONNRESET");
    expect(normalizeS3Error(sdkError("SlowDown", { $retryable: { throttling: false } })).code).toBe("ECONNRESET");
    expect(normalizeS3Error(sdkError("NetworkingError", { message: "socket hang up" })).code).toBe("ECONNRESET");
  });

  test("falls back to the original code or EUNKNOWN", () => {
    expect(normalizeS3Error(sdkError("CustomError", { code: "EIO" })).code).toBe("EIO");
    expect(normalizeS3Error(sdkError("WeirdFailure")).code).toBe("EUNKNOWN");
    expect(normalizeS3Error("not an error").code).toBe("EUNKNOWN");
  });

  test("passes Pallet's own coded errors through unchanged", () => {
    const original = s3Error("EINVAL", "S3 bucket is required");
    expect(normalizeS3Error(original)).toBe(original);
  });
});

describe("isConnectivityError", () => {
  test("recognizes socket codes, retryable failures, 5xx, and network messages", () => {
    expect(isConnectivityError(sdkError("NetworkingError", { code: "ECONNRESET" }))).toBe(true);
    expect(isConnectivityError(sdkError("NetworkingError", { code: "ENOTFOUND" }))).toBe(true);
    expect(isConnectivityError(sdkError("NetworkingError", { code: "ERR_STREAM_PREMATURE_CLOSE" }))).toBe(true);
    expect(isConnectivityError(sdkError("NetworkingError", { $retryable: {} }))).toBe(true);
    expect(isConnectivityError(sdkError("InternalError", { $metadata: { httpStatusCode: 500 } }))).toBe(true);
    expect(isConnectivityError(new Error("getaddrinfo ENOTFOUND example.com"))).toBe(true);
    expect(isConnectivityError(sdkError("NoSuchKey"))).toBe(false);
    expect(isConnectivityError(sdkError("AccessDenied"))).toBe(false);
  });
});

describe("s3Call", () => {
  test("returns results and normalizes thrown SDK errors", async () => {
    expect(await s3Call(async () => 7)).toBe(7);
    await expect(
      s3Call(async () => {
        throw sdkError("NoSuchKey");
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
