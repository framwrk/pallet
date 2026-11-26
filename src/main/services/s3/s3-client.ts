import type { ConnectProfile, S3ConnectionOptions } from "@shared/sftp/sftp.types";
import { GCS_ENDPOINT, GCS_PRESET_ID, GCS_REGION } from "@shared/s3/s3-presets";
import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ResolvedS3Config {
  /** Provider preset id; only the Google Cloud Storage preset changes the client. */
  preset?: string;
  region: string;
  bucket: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

export function s3Error(code: string, message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  return err;
}

/**
 * A custom endpoint is an origin only: no credentials, query, fragment, or
 * base path. TLS verification is always on and only http(s) is accepted.
 */
export function validateEndpoint(endpoint: string | undefined): string | undefined {
  const raw = endpoint?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw s3Error("EINVAL", "S3 endpoint must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw s3Error("EINVAL", "S3 endpoint must use http or https");
  }
  if (url.username || url.password) throw s3Error("EINVAL", "S3 endpoint must not include credentials");
  if (url.search || url.hash) throw s3Error("EINVAL", "S3 endpoint must not include a query or fragment");
  if (url.pathname !== "/" && url.pathname !== "") {
    throw s3Error("EINVAL", "S3 endpoint must not include a path prefix");
  }
  if (!url.hostname) throw s3Error("EINVAL", "S3 endpoint must include a host");
  return `${url.protocol}//${url.host}`;
}

export function resolveS3Config(options: S3ConnectionOptions): ResolvedS3Config {
  if (options.preset === GCS_PRESET_ID) return resolveGcsConfig(options);
  const endpoint = validateEndpoint(options.endpoint);
  const region = options.region?.trim();
  const bucket = options.bucket?.trim();
  if (!region) throw s3Error("EINVAL", "S3 region is required");
  if (!bucket) throw s3Error("EINVAL", "S3 bucket is required");
  if (/[^\w.-]/.test(bucket)) throw s3Error("EINVAL", `Invalid S3 bucket name: ${bucket}`);
  return {
    ...(options.preset ? { preset: options.preset } : {}),
    region,
    bucket,
    forcePathStyle: options.forcePathStyle ?? endpoint !== undefined,
    ...(endpoint ? { endpoint } : {}),
  };
}

/**
 * The preset owns the endpoint, signing region, and addressing: path-style
 * keeps dotted bucket names valid under the storage.googleapis.com
 * certificate, so stored values for those fields are ignored.
 */
function resolveGcsConfig(options: S3ConnectionOptions): ResolvedS3Config {
  const bucket = options.bucket?.trim();
  if (!bucket) throw s3Error("EINVAL", "Cloud Storage bucket is required");
  if (/[^\w.-]/.test(bucket)) throw s3Error("EINVAL", `Invalid Cloud Storage bucket name: ${bucket}`);
  return { preset: GCS_PRESET_ID, region: GCS_REGION, bucket, endpoint: GCS_ENDPOINT, forcePathStyle: true };
}

export function s3ConfigFromProfile(profile: ConnectProfile): ResolvedS3Config {
  if (!profile.s3) throw s3Error("EINVAL", "S3 connection is missing its bucket settings");
  return resolveS3Config(profile.s3);
}

export function credentialsFromProfile(profile: ConnectProfile): S3Credentials {
  if (profile.auth.method !== "s3") throw s3Error("EINVAL", "S3 requires an access key and secret access key");
  const accessKeyId = profile.username?.trim();
  if (!accessKeyId) throw s3Error("EINVAL", "S3 access key ID is required");
  if (!profile.auth.secretAccessKey) throw s3Error("EINVAL", "S3 secret access key is required");
  // HMAC keys have no session token; a leftover one would only break signing.
  const sessionToken = profile.s3?.preset === GCS_PRESET_ID ? undefined : profile.auth.sessionToken;
  return {
    accessKeyId,
    secretAccessKey: profile.auth.secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

export function createS3Client(config: ResolvedS3Config, credentials: S3Credentials): S3Client {
  const options: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
    },
    maxAttempts: 3,
    // Custom endpoints, Cloud Storage included, frequently reject the SDK's
    // default CRC32 trailers; asking only when an operation requires one
    // keeps them working.
    requestChecksumCalculation: config.endpoint ? "WHEN_REQUIRED" : "WHEN_SUPPORTED",
    responseChecksumValidation: config.endpoint ? "WHEN_REQUIRED" : "WHEN_SUPPORTED",
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  };
  const client = new S3Client(options);
  if (config.preset === GCS_PRESET_ID) {
    // Cloud Storage ignores Range when it decompresses a gzip-encoded object;
    // accepting gzip makes it serve the stored bytes, so ranges and sizes agree.
    client.middlewareStack.add(
      (next, context) => async (args) => {
        const request = args.request as { headers?: Record<string, string> };
        if (context.commandName === "GetObjectCommand" && request.headers) request.headers["accept-encoding"] = "gzip";
        return next(args);
      },
      { step: "build", name: "gcsStoredBytes" },
    );
  }
  return client;
}

function statusOf(err: unknown): number | undefined {
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const direct = (err as { statusCode?: number }).statusCode;
  return meta?.httpStatusCode ?? direct;
}

function nameOf(err: unknown): string {
  return String((err as { name?: string }).name ?? "");
}

function messageOf(err: unknown): string {
  const message = (err as Error).message;
  return message && message.length > 0 ? message : nameOf(err) || "S3 request failed";
}

/**
 * Machine-readable failures the rest of Pallet already understands. Access,
 * signature, token, and configuration errors stay actionable and never turn
 * into a reconnect loop.
 */
export function normalizeS3Error(err: unknown): NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException).code;
  const name = nameOf(err);
  const status = statusOf(err);
  const message = messageOf(err);

  if (err instanceof Error && (err as NodeJS.ErrnoException).code && name === "Error" && code) return err;

  if (["NoSuchBucket", "InvalidBucketName", "InvalidRegion"].includes(name)) {
    return Object.assign(new Error(message), { code: "EINVAL" });
  }
  if (["NoSuchKey", "NotFound", "NoSuchVersion"].includes(name) || status === 404) {
    return Object.assign(new Error(message), { code: "ENOENT" });
  }
  if (
    ["ExpiredToken", "ExpiredTokenException", "InvalidToken", "TokenRefreshRequired"].includes(name) ||
    /expired token|token has expired/i.test(message)
  ) {
    return Object.assign(new Error(`S3 session token expired or is invalid: ${message}`), { code: "EEXPIRED" });
  }
  if (["NoSuchBucket", "InvalidBucketName", "InvalidRegion"].includes(name)) {
    return Object.assign(new Error(message), { code: "EINVAL" });
  }
  if (
    ["AccessDenied", "AllAccessDisabled", "InvalidAccessKeyId", "SignatureDoesNotMatch", "AccountProblem"].includes(name) ||
    status === 403
  ) {
    return Object.assign(new Error(`S3 access denied: ${message}`), { code: "EACCES" });
  }
  if (["CredentialsProviderError", "CredentialsError", "InvalidCredentials"].includes(name)) {
    return Object.assign(new Error(`S3 credentials are unavailable or invalid: ${message}`), { code: "EACCES" });
  }
  if (["PreconditionFailed", "ConditionalRequestConflict"].includes(name) || /already exists/i.test(message)) {
    return Object.assign(new Error(message), { code: "EEXIST" });
  }
  if (isConnectivityError(err)) {
    const normalized =
      code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(code)
        ? code
        : "ECONNRESET";
    return Object.assign(new Error(`S3 connection failed: ${message}`), { code: normalized });
  }
  if (code) return Object.assign(new Error(message), { code });
  return Object.assign(new Error(message), { code: "EUNKNOWN" });
}

const CONNECTIVITY_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

export function isConnectivityError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (code && CONNECTIVITY_CODES.has(code)) return true;
  if ((err as { $retryable?: unknown }).$retryable) return true;
  const status = statusOf(err);
  if (status !== undefined && status >= 500) return true;
  return /socket hang up|network error|timed? ?out|connection (reset|refused|closed|lost)|getaddrinfo/i.test(
    (err as Error)?.message ?? "",
  );
}

/** Wrap every SDK call so callers only ever see normalized failures. */
export async function s3Call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw normalizeS3Error(err);
  }
}
