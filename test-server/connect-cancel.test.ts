import { type Server, type Socket, createServer } from "node:net";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import type { SessionStatusEvent } from "../src/shared/sftp/sftp.types";
import assert from "node:assert/strict";
import { test } from "node:test";

async function silentServer(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { server, port: address.port, sockets };
}

test("cancelling a hanging connect rejects promptly and drops the session", async () => {
  const { server, port, sockets } = await silentServer();
  const events: SessionStatusEvent[] = [];
  const manager = new SessionManager({ verifyHostKey: async () => true, onStatus: (event) => events.push(event) });
  try {
    const connecting = manager.connect(
      { host: "127.0.0.1", port, username: "nobody", auth: { method: "password", password: "x" } },
      "attempt-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    manager.cancelConnect("attempt-1");
    await assert.rejects(connecting, (err: NodeJS.ErrnoException) => err.code === "ECANCELED");
    assert.ok(Date.now() - started < 1000);
    const sessionId = events[0].sessionId;
    assert.equal(events.at(-1)?.status, "disconnected");
    assert.throws(() => manager.status(sessionId), /Unknown session/);
    manager.cancelConnect("attempt-1");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});
