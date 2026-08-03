/**
 * SFTP integration suite against a real Dockerized OpenSSH server.
 * Drives the actual main-process services (SessionManager + SftpService),
 * which are Electron-free by design.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionStatusEvent } from "../../src/shared/types";
import { SessionManager, type HostKeyDecisionInput } from "../../src/main/services/session-manager";
import { SftpService } from "../../src/main/services/sftp-service";
import { HARNESS, restartServer, startServer, stopServer } from "./harness";

const seenFingerprints: HostKeyDecisionInput[] = [];
const statusEvents: SessionStatusEvent[] = [];
let rejectHostKey = false;

const sessions = new SessionManager({
  verifyHostKey: async (input) => {
    seenFingerprints.push(input);
    return !rejectHostKey;
  },
  onStatus: (event) => statusEvents.push(event),
});
const sftp = new SftpService(sessions);

function passwordProfile(overrides: Record<string, unknown> = {}): Parameters<SessionManager["connect"]>[0] {
  return {
    host: HARNESS.host,
    port: HARNESS.port,
    username: HARNESS.username,
    auth: { method: "password", password: HARNESS.password },
    ...overrides,
  };
}

beforeAll(async () => {
  await startServer();
}, 120_000);

afterAll(() => {
  sessions.disconnectAll();
  stopServer();
});

describe("connect", () => {
  test("password auth resolves the home directory", async () => {
    const { sessionId, initialPath } = await sessions.connect(passwordProfile());
    expect(initialPath).toBe("/home/testuser");
    expect(sessions.status(sessionId)).toBe("connected");
    sessions.disconnect(sessionId);
  }, 30_000);

  test("private key auth works", async () => {
    const { sessionId } = await sessions.connect(passwordProfile({ auth: { method: "key", keyPath: HARNESS.keyPath } }));
    expect(sessions.status(sessionId)).toBe("connected");
    sessions.disconnect(sessionId);
  }, 30_000);

  test("wrong password fails cleanly", async () => {
    await expect(sessions.connect(passwordProfile({ auth: { method: "password", password: "nope" } }))).rejects.toThrow(
      /authentication/i,
    );
  }, 30_000);

  test("host key rejection blocks the connection", async () => {
    rejectHostKey = true;
    try {
      await expect(sessions.connect(passwordProfile())).rejects.toThrow();
    } finally {
      rejectHostKey = false;
    }
  }, 30_000);

  test("host key fingerprints were presented for every dial", () => {
    expect(seenFingerprints.length).toBeGreaterThan(0);
    for (const fp of seenFingerprints) {
      expect(fp.fingerprint).toStartWith("SHA256:");
      expect(fp.keyType).toMatch(/^(ssh-|ecdsa-|rsa-)/);
    }
  });

  test("remotePath option is honored", async () => {
    const { sessionId, initialPath } = await sessions.connect(passwordProfile({ remotePath: HARNESS.fixtures }));
    expect(initialPath).toBe(HARNESS.fixtures);
    sessions.disconnect(sessionId);
  }, 30_000);
});

describe("listing", () => {
  test("fixtures listing: kinds, symlinks, unicode, hidden", async () => {
    const { sessionId } = await sessions.connect(passwordProfile());
    try {
      const listing = await sftp.list(sessionId, HARNESS.fixtures);
      const byName = new Map(listing.entries.map((e) => [e.name, e]));

      expect(byName.get("hello.txt")?.kind).toBe("file");
      expect(byName.get("hello.txt")?.size).toBe(12);
      expect(byName.get("subdir")?.kind).toBe("dir");
      expect(byName.get(".hidden")?.hidden).toBe(true);
      expect(byName.has("naïve Dätei 文件.txt")).toBe(true);

      expect(byName.get("link-to-subdir")?.kind).toBe("symlink");
      expect(byName.get("link-to-subdir")?.targetKind).toBe("dir");
      expect(byName.get("link-to-file")?.targetKind).toBe("file");
      expect(byName.get("broken-link")?.targetKind).toBe("unknown");

      const nested = await sftp.list(sessionId, `${HARNESS.fixtures}/subdir`);
      expect(nested.entries.map((e) => e.name)).toContain("nested.txt");

      const stat = await sftp.stat(sessionId, `${HARNESS.fixtures}/hello.txt`);
      expect(stat.kind).toBe("file");
      expect(stat.size).toBe(12);

      await expect(sftp.list(sessionId, "/root")).rejects.toThrow();
    } finally {
      sessions.disconnect(sessionId);
    }
  }, 30_000);
});

describe("reconnect", () => {
  test("server restart triggers reconnecting → connected", async () => {
    const { sessionId } = await sessions.connect(passwordProfile());
    statusEvents.length = 0;

    await restartServer();

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && sessions.status(sessionId) !== "connected") {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(sessions.status(sessionId)).toBe("connected");
    expect(statusEvents.some((e) => e.status === "reconnecting")).toBe(true);

    // The browse channel works again after the drop.
    const listing = await sftp.list(sessionId, HARNESS.fixtures);
    expect(listing.entries.length).toBeGreaterThan(0);
    sessions.disconnect(sessionId);
  }, 60_000);
});
