import { type Socket, createServer } from "node:net";
import type { ConnectionProtocol } from "../src/shared/sftp/sftp.types";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import assert from "node:assert/strict";
import { test } from "node:test";

async function firstClientByte(protocol: ConnectionProtocol): Promise<number | null> {
  const sockets: Socket[] = [];
  let resolveByte: (byte: number | null) => void = () => {};
  const firstByte = new Promise<number | null>((resolve) => (resolveByte = resolve));
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.once("data", (chunk) => resolveByte(chunk[0]));
    setTimeout(() => resolveByte(null), 300);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const manager = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
  const connecting = manager.connect(
    {
      protocol,
      host: "127.0.0.1",
      port: address.port,
      username: "pallet",
      auth: { method: "password", password: "pallet" },
      tlsRejectUnauthorized: false,
    },
    "attempt",
  );
  connecting.catch(() => {});
  try {
    return await firstByte;
  } finally {
    manager.cancelConnect("attempt");
    for (const socket of sockets) socket.destroy();
    server.close();
    await connecting.catch(() => {});
  }
}

test("implicit FTPS starts TLS before the FTP greeting", async () => {
  assert.equal(await firstClientByte("ftps-implicit"), 0x16);
});

test("explicit FTPS waits for the plaintext FTP greeting", async () => {
  assert.equal(await firstClientByte("ftps"), null);
});
