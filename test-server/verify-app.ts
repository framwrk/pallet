import type { ConnectProfile, ConnectionProtocol } from "../src/shared/sftp/sftp.types";
import { FolderSizes } from "../src/main/services/folder-size.service";
import { Readable } from "node:stream";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import { SftpService } from "../src/main/services/sftp/sftp.service";
import { makeEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { pipeline } from "node:stream/promises";

const host = "127.0.0.1";
const username = "pallet";
const password = process.env.PALLET_TEST_PASSWORD ?? "pallet";
const profiles: { protocol: ConnectionProtocol; port: number; remotePath: string; tlsRejectUnauthorized?: boolean }[] = [
  {
    protocol: "sftp",
    port: Number(process.env.PALLET_TEST_SERVER_PORT ?? 2222),
    remotePath: "/home/pallet",
  },
  { protocol: "ftp", port: Number(process.env.PALLET_TEST_FTP_PORT ?? 2121), remotePath: "/" },
  {
    protocol: "ftps",
    port: Number(process.env.PALLET_TEST_FTPS_PORT ?? 2122),
    remotePath: "/",
    // The local server's certificate is intentionally self-signed.
    tlsRejectUnauthorized: false,
  },
];

const sessions = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
const service = new SftpService(sessions);
const sizes = new FolderSizes(sessions);

for (const item of profiles) {
  const profile: ConnectProfile = {
    ...item,
    host,
    username,
    auth: { method: "password", password },
    concurrency: 2,
  };
  const { sessionId, initialPath } = await sessions.connect(profile);
  const endpoint = makeEndpoint(sessions, { kind: "sftp", sessionId });
  const base = initialPath === "/" ? "" : initialPath;
  const source = `${base}/.pallet-${item.protocol}-app-verify.txt`;
  const renamed = `${base}/.pallet-${item.protocol}-app-verify-renamed.txt`;
  const folder = `${base}/.pallet-${item.protocol}-app-verify-folder`;
  const payload = Buffer.from(`${item.protocol} application transfer verification\n`);

  try {
    // These overlap intentionally: FTP uses one serialized browse client.
    const [listing, readmeStat] = await Promise.all([
      service.list(sessionId, initialPath),
      service.stat(sessionId, `${base}/README.txt`),
    ]);
    if (!listing.entries.some((entry) => entry.name === "README.txt")) throw new Error("README.txt missing");
    if (readmeStat.kind !== "file") throw new Error("README.txt stat was not a file");

    const preview = await service.readBytes(sessionId, `${base}/README.txt`, 7);
    if (preview.length !== 7) throw new Error(`Bounded preview returned ${preview.length} bytes`);

    await pipeline(Readable.from(payload), await endpoint.createWriteStream(source, 0o644));
    const stat = await endpoint.statOrNull(source);
    if (!stat || stat.size !== payload.length) throw new Error("Uploaded file stat mismatch");

    const chunks: Buffer[] = [];
    for await (const chunk of await endpoint.createReadStream(source)) chunks.push(Buffer.from(chunk));
    if (!Buffer.concat(chunks).equals(payload)) throw new Error("Downloaded payload mismatch");

    await endpoint.renameReplacing(source, renamed);
    if (!(await endpoint.statOrNull(renamed))) throw new Error("Renamed file missing");

    await service.mkdir(sessionId, folder);
    const total = await sizes.get({ kind: "sftp", sessionId }, initialPath);
    if (total == null || total < payload.length) throw new Error("Folder sizing failed");
    await service.removeRecursive(sessionId, folder);
    await endpoint.removeFile(renamed);

    console.log(`✓ ${item.protocol}: connect/list/preview/upload/stat/download/rename/mkdir/size/delete`);
  } finally {
    await service.removeRecursive(sessionId, folder).catch(() => {});
    await endpoint.removeFile(source).catch(() => {});
    await endpoint.removeFile(renamed).catch(() => {});
    endpoint.dispose();
    sessions.disconnect(sessionId);
  }
}

console.log("Application-layer verification passed for SFTP, FTP, and explicit FTPS.");
