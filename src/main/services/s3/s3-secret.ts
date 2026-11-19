/**
 * S3 credentials share the single encrypted Keychain blob with every other
 * favorite secret. The blob holds a small versioned JSON document so the
 * access key secret and the optional session token survive a round trip.
 *
 * Pure Node so it can be exercised by the Bun test suite without Electron.
 */
import type { S3FavoriteSecret } from "@shared/favorite/favorite.types";

export const S3_SECRET_VERSION = 1;

interface S3SecretEnvelope {
  v: number;
  secretAccessKey: string;
  sessionToken?: string;
}

function invalid(message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = "EINVAL";
  return err;
}

/** Serialize an S3 credential for safeStorage; never logs the value. */
export function serializeS3Secret(secret: S3FavoriteSecret): string {
  if (typeof secret.secretAccessKey !== "string" || !secret.secretAccessKey) {
    throw invalid("S3 secret access key is required");
  }
  const envelope: S3SecretEnvelope = { v: S3_SECRET_VERSION, secretAccessKey: secret.secretAccessKey };
  if (typeof secret.sessionToken === "string" && secret.sessionToken) {
    envelope.sessionToken = secret.sessionToken;
  }
  return JSON.stringify(envelope);
}

/**
 * Parse a stored S3 credential. Returns null for anything that is not a
 * recognized S3 envelope, including legacy plaintext secrets, so callers can
 * ask for credentials again instead of leaking a malformed value into a
 * connection attempt.
 */
export function parseS3Secret(raw: string | null): S3FavoriteSecret | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.v !== S3_SECRET_VERSION) return null;
  if (typeof record.secretAccessKey !== "string" || !record.secretAccessKey) return null;
  const secret: S3FavoriteSecret = { secretAccessKey: record.secretAccessKey };
  if (typeof record.sessionToken === "string" && record.sessionToken) {
    secret.sessionToken = record.sessionToken;
  }
  return secret;
}
