import type { ConnectProfile, TerminalExitEvent } from "../src/shared/sftp/sftp.types";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import { SftpService } from "../src/main/services/sftp/sftp.service";
import { TerminalDataEvent } from "../src/shared/terminal/terminal.types";
import { TerminalSessions } from "../src/main/services/ssh/terminal-sessions";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "bun:test";

const host = "127.0.0.1";
const password = process.env.PALLET_TEST_PASSWORD ?? "pallet";
const sftpPort = Number(process.env.PALLET_TEST_SERVER_PORT ?? 2222);
const ftpPort = Number(process.env.PALLET_TEST_FTP_PORT ?? 2121);

async function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const dockerReady = await reachable(sftpPort);
const dockerTest = test.skipIf(!dockerReady);

function manager(): SessionManager {
  return new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
}

function profile(protocol: "sftp" | "ftp", port: number): ConnectProfile {
  return {
    protocol,
    host,
    port,
    username: "pallet",
    auth: { method: "password", password },
    concurrency: 2,
  };
}

interface Harness {
  sessions: TerminalSessions;
  events: TerminalExitEvent[];
  output: string[];
}

function harness(sessions: SessionManager): Harness {
  const events: TerminalExitEvent[] = [];
  const output: string[] = [];
  const terminals = new TerminalSessions(sessions, {
    onData: (event: TerminalDataEvent) => output.push(Buffer.from(event.data).toString("utf8")),
    onExit: (event: TerminalExitEvent) => events.push(event),
  });
  return { sessions: terminals, events, output };
}

async function until(check: () => boolean, description: string, timeout = 15000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Deadline exceeded: ${description}`);
}

dockerTest("terminal runs a login shell and echoes commands", async () => {
  const sessions = manager();
  const terminal = harness(sessions);
  try {
    const { sessionId } = await sessions.connect(profile("sftp", sftpPort));
    await terminal.sessions.open("t1", sessionId, 80, 24);
    await until(() => terminal.output.join("").includes("$"), "shell prompt");
    terminal.sessions.write("t1", "echo pallet-$((6*7))\n");
    await until(() => terminal.output.join("").includes("pallet-42"), "echo output");
  } finally {
    terminal.sessions.closeAll();
    sessions.disconnectAll();
  }
});

dockerTest("terminal resize updates the PTY size", async () => {
  const sessions = manager();
  const terminal = harness(sessions);
  try {
    const { sessionId } = await sessions.connect(profile("sftp", sftpPort));
    await terminal.sessions.open("t2", sessionId, 80, 24);
    terminal.sessions.write("t2", "stty size\n");
    await until(() => terminal.output.join("").includes("24 80"), "initial stty size");
    terminal.sessions.resize("t2", 100, 30);
    terminal.sessions.write("t2", "stty size\n");
    await until(() => terminal.output.join("").includes("30 100"), "resized stty size");
  } finally {
    terminal.sessions.closeAll();
    sessions.disconnectAll();
  }
});

dockerTest("exiting the shell reports exactly one clean exit", async () => {
  const sessions = manager();
  const terminal = harness(sessions);
  try {
    const { sessionId } = await sessions.connect(profile("sftp", sftpPort));
    await terminal.sessions.open("t3", sessionId, 80, 24);
    terminal.sessions.write("t3", "exit\n");
    await until(() => terminal.events.length > 0, "exit event");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(terminal.events.length, 1);
    assert.equal(terminal.events[0].reason, "exit");
  } finally {
    terminal.sessions.closeAll();
    sessions.disconnectAll();
  }
});

dockerTest("closing for a disconnected session ends the shell without an exit event", async () => {
  const sessions = manager();
  const terminal = harness(sessions);
  try {
    const { sessionId } = await sessions.connect(profile("sftp", sftpPort));
    await terminal.sessions.open("t4", sessionId, 80, 24);
    sessions.disconnect(sessionId);
    terminal.sessions.closeForSession(sessionId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(terminal.events, []);
    await assert.rejects(terminal.sessions.open("t5", sessionId, 80, 24), /Unknown session/);
  } finally {
    terminal.sessions.closeAll();
    sessions.disconnectAll();
  }
});

dockerTest("only SFTP sessions accept a terminal, one per session", async () => {
  const sessions = manager();
  const terminal = harness(sessions);
  try {
    const ftp = await sessions.connect(profile("ftp", ftpPort));
    await assert.rejects(terminal.sessions.open("ftp-t", ftp.sessionId, 80, 24), (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, "ENOTSSH");
      return true;
    });

    const { sessionId } = await sessions.connect(profile("sftp", sftpPort));
    await terminal.sessions.open("t6", sessionId, 80, 24);
    await assert.rejects(terminal.sessions.open("t7", sessionId, 80, 24), (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, "EEXIST");
      return true;
    });
  } finally {
    terminal.sessions.closeAll();
    sessions.disconnectAll();
  }
});

dockerTest("the file session keeps listing while a terminal is open", async () => {
  const sessions = manager();
  const terminal = harness(sessions);
  const service = new SftpService(sessions);
  try {
    const { sessionId, initialPath } = await sessions.connect(profile("sftp", sftpPort));
    await terminal.sessions.open("t8", sessionId, 80, 24);
    const listings = await Promise.all([
      service.list(sessionId, initialPath),
      service.list(sessionId, initialPath),
      service.list(sessionId, initialPath),
    ]);
    for (const listing of listings) {
      assert.ok(listing.entries.some((entry) => entry.name === "README.txt"));
    }
  } finally {
    terminal.sessions.closeAll();
    sessions.disconnectAll();
  }
});
