import { describe, expect, test } from "bun:test";
import { redact } from "../../src/shared/redact";

describe("redact", () => {
  test("strips inline credentials from URLs", () => {
    expect(redact("connecting to sftp://alice:hunter2@example.com:22/srv")).toBe(
      "connecting to sftp://alice:***@example.com:22/srv",
    );
  });

  test("strips password/passphrase/token assignments in any quoting style", () => {
    expect(redact("password=hunter2")).toBe("password=***");
    expect(redact('{"passphrase": "s3cret"}')).toBe('{"passphrase": ***}');
    expect(redact("token: 'abc123'")).toBe("token: ***");
    expect(redact("API_KEY = zzz")).toBe("API_KEY = ***");
  });

  test("strips PEM private key bodies", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r\nZXktdjE\n-----END OPENSSH PRIVATE KEY-----";
    const out = redact(`key load failed: ${pem}`);
    expect(out).not.toContain("b3BlbnNzaC1r");
    expect(out).toContain("BEGIN PRIVATE KEY");
  });

  test("leaves ordinary log lines alone", () => {
    const line = "app start 0.1.0 — listed /home/testuser in 12ms";
    expect(redact(line)).toBe(line);
  });

  test("does not mangle a hostname that merely contains a colon", () => {
    expect(redact("connect example.com:2222 failed")).toBe("connect example.com:2222 failed");
  });
});
