/**
 * S3 credentials are a versioned JSON envelope inside the single encrypted
 * secret blob, so legacy plaintext or a future version must never be mistaken
 * for usable credentials.
 */
import { S3_SECRET_VERSION, parseS3Secret, serializeS3Secret } from "../src/main/services/s3/s3-secret";
import { describe, expect, test } from "bun:test";

describe("serializeS3Secret", () => {
  test("round trips a secret without a session token", () => {
    const raw = serializeS3Secret({ secretAccessKey: "wJalrXUtnFEMI/K7MDENG" });
    expect(JSON.parse(raw)).toEqual({ v: S3_SECRET_VERSION, secretAccessKey: "wJalrXUtnFEMI/K7MDENG" });
    expect(parseS3Secret(raw)).toEqual({ secretAccessKey: "wJalrXUtnFEMI/K7MDENG" });
  });

  test("round trips a secret with a session token", () => {
    const raw = serializeS3Secret({ secretAccessKey: "secret-key", sessionToken: "session-token" });
    expect(parseS3Secret(raw)).toEqual({ secretAccessKey: "secret-key", sessionToken: "session-token" });
  });

  test("rejects an empty secret access key with EINVAL", () => {
    try {
      serializeS3Secret({ secretAccessKey: "" });
      throw new Error("expected serializeS3Secret to throw");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("EINVAL");
      expect((err as Error).message).not.toContain("secret-key");
    }
  });
});

describe("parseS3Secret", () => {
  test("returns null for null and empty values", () => {
    expect(parseS3Secret(null)).toBeNull();
    expect(parseS3Secret("")).toBeNull();
  });

  test("rejects legacy plaintext", () => {
    expect(parseS3Secret("hunter2")).toBeNull();
  });

  test("rejects a different envelope version", () => {
    expect(parseS3Secret(JSON.stringify({ v: 2, secretAccessKey: "secret-key" }))).toBeNull();
  });

  test("rejects an envelope with an empty secret access key", () => {
    expect(parseS3Secret(JSON.stringify({ v: S3_SECRET_VERSION, secretAccessKey: "" }))).toBeNull();
    expect(parseS3Secret(JSON.stringify({ v: S3_SECRET_VERSION }))).toBeNull();
  });

  test("ignores extra fields safely", () => {
    const parsed = parseS3Secret(
      JSON.stringify({
        v: S3_SECRET_VERSION,
        secretAccessKey: "secret-key",
        sessionToken: "session-token",
        accessKeyId: "AKIAEXAMPLE",
        extra: { secretAccessKey: "nested" },
      }),
    );
    expect(parsed).toEqual({ secretAccessKey: "secret-key", sessionToken: "session-token" });
  });
});
