import { type ChildProcess, execFile, spawn } from "node:child_process";
import { Server as SshServer, utils } from "ssh2";
import type { ConnectProfile } from "../src/shared/sftp/sftp.types";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { test } from "node:test";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

function manager(): SessionManager {
  return new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
}

function agentProfile(port = 1): ConnectProfile {
  return {
    protocol: "sftp",
    host: "127.0.0.1",
    port,
    username: "pallet",
    auth: { method: "agent" },
  };
}

function restoreAgentSocket(previous: string | undefined): void {
  if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = previous;
}

async function startAgent(directory: string): Promise<{ process: ChildProcess; socketPath: string }> {
  const socketPath = join(directory, "agent.sock");
  const child = spawn("ssh-agent", ["-D", "-a", socketPath], { stdio: "ignore" });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`ssh-agent exited with code ${child.exitCode}`);
    try {
      await fs.access(socketPath);
      return { process: child, socketPath };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  child.kill("SIGTERM");
  throw new Error("ssh-agent did not create its socket");
}

async function stopAgent(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function generateKey(path: string): Promise<void> {
  await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]);
}

async function startSshServer(hostKeyPath: string, publicKeyPath: string): Promise<{ server: SshServer; port: number }> {
  const allowedKey = utils.parseKey(await fs.readFile(publicKeyPath));
  if (allowedKey instanceof Error) throw allowedKey;

  const server = new SshServer({ hostKeys: [await fs.readFile(hostKeyPath)] }, (client) => {
    client
      .on("authentication", (ctx) => {
        if (
          ctx.username !== "pallet" ||
          ctx.method !== "publickey" ||
          ctx.key.algo !== allowedKey.type ||
          !ctx.key.data.equals(allowedKey.getPublicSSH()) ||
          (ctx.signature && (!ctx.blob || allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true))
        ) {
          ctx.reject(["publickey"]);
          return;
        }
        ctx.accept();
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (accept) => {
            const sftp = accept();
            sftp.on("REALPATH", (reqid) => {
              sftp.name(reqid, [
                {
                  filename: "/home/pallet",
                  longname: "drwxr-xr-x 1 pallet pallet 0 Jan 1 00:00 .",
                  attrs: {},
                },
              ]);
            });
          });
        });
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SSH test server has no TCP address");
  return { server, port: address.port };
}

async function closeServer(server: SshServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

test("agent auth rejects a missing or empty SSH_AUTH_SOCK", async () => {
  const previous = process.env.SSH_AUTH_SOCK;
  try {
    for (const value of [undefined, ""]) {
      if (value === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = value;
      await assert.rejects(manager().connect(agentProfile()), /SSH_AUTH_SOCK is not set/);
    }
  } finally {
    restoreAgentSocket(previous);
  }
});

test("agent auth reports a dead socket", { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pallet-agent-dead-"));
  const agent = await startAgent(directory);
  const previous = process.env.SSH_AUTH_SOCK;
  agent.process.kill("SIGKILL");
  await once(agent.process, "exit");
  await fs.access(agent.socketPath);
  process.env.SSH_AUTH_SOCK = agent.socketPath;
  try {
    await assert.rejects(manager().connect(agentProfile()), /Unable to connect to the SSH agent/);
  } finally {
    restoreAgentSocket(previous);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("agent auth reports an agent with no usable keys", { timeout: 20000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pallet-agent-empty-"));
  const agent = await startAgent(directory);
  const previous = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = agent.socketPath;
  try {
    await assert.rejects(manager().connect(agentProfile()), /has no usable keys/);
  } finally {
    restoreAgentSocket(previous);
    await stopAgent(agent.process);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("agent auth connects using a key from a local ssh-agent", { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pallet-agent-auth-"));
  const agent = await startAgent(directory);
  const userKeyPath = join(directory, "id_ed25519");
  const hostKeyPath = join(directory, "host_ed25519");
  const previous = process.env.SSH_AUTH_SOCK;
  let sessions: SessionManager | undefined;
  let sessionId: string | undefined;
  let server: SshServer | undefined;
  try {
    await generateKey(userKeyPath);
    await generateKey(hostKeyPath);
    await execFileAsync("ssh-add", [userKeyPath], {
      env: { ...process.env, SSH_AUTH_SOCK: agent.socketPath },
    });
    const sshServer = await startSshServer(hostKeyPath, `${userKeyPath}.pub`);
    server = sshServer.server;
    process.env.SSH_AUTH_SOCK = agent.socketPath;

    sessions = manager();
    const result = await sessions.connect(agentProfile(sshServer.port));
    sessionId = result.sessionId;
    assert.equal(result.initialPath, "/home/pallet");
    sessions.disconnect(sessionId);
    sessionId = undefined;
  } finally {
    if (sessionId && sessions) sessions.disconnect(sessionId);
    restoreAgentSocket(previous);
    if (server) await closeServer(server);
    await stopAgent(agent.process);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
