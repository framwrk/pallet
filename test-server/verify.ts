import { Client, type SFTPWrapper } from "ssh2";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const host = "127.0.0.1";
const username = "pallet";
const password = process.env.PALLET_TEST_PASSWORD ?? "pallet";
const sftpPort = Number(process.env.PALLET_TEST_SERVER_PORT ?? 2222);
const ftpPort = Number(process.env.PALLET_TEST_FTP_PORT ?? 2121);
const ftpsPort = Number(process.env.PALLET_TEST_FTPS_PORT ?? 2122);
const expectedFixture = "This is Pallet's local transfer testing server.";

function runCurl(args: string[]): string {
  const result = spawnSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "5",
      "--max-time",
      "10",
      "--user",
      `${username}:${password}`,
      ...args,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `curl exited ${result.status}`);
  }

  return result.stdout;
}

function verifyFtp(label: string, port: number, useTls: boolean): void {
  const baseUrl = `ftp://${host}:${port}`;
  const tlsArgs = useTls ? ["--ssl-reqd", "--insecure"] : [];
  const remoteName = `.pallet-${label.toLowerCase()}-verify.txt`;
  const tempDirectory = mkdtempSync(join(tmpdir(), `pallet-${label.toLowerCase()}-`));
  const uploadPath = join(tempDirectory, remoteName);
  const payload = `Pallet ${label} upload verification\n`;

  try {
    const listing = runCurl([...tlsArgs, "--list-only", `${baseUrl}/`]);
    if (!listing.includes("README.txt")) throw new Error(`${label} listing omitted README.txt`);

    const fixture = runCurl([...tlsArgs, `${baseUrl}/README.txt`]);
    if (!fixture.includes(expectedFixture)) throw new Error(`${label} returned an unexpected fixture`);

    writeFileSync(uploadPath, payload);
    runCurl([...tlsArgs, "--upload-file", uploadPath, `${baseUrl}/${remoteName}`]);

    const downloaded = runCurl([...tlsArgs, `${baseUrl}/${remoteName}`]);
    if (downloaded !== payload) throw new Error(`${label} upload did not round-trip`);

    runCurl([...tlsArgs, "--quote", `DELE ${remoteName}`, "--list-only", `${baseUrl}/`]);
    console.log(`✓ ${label} login, listing, download, upload, and delete`);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

function readSftpFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (error, data) => (error ? reject(error) : resolve(data)));
  });
}

function writeSftpFile(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (error) => (error ? reject(error) : resolve()));
  });
}

function listSftpDirectory(sftp: SFTPWrapper, path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, entries) => (error ? reject(error) : resolve(entries.map((entry) => entry.filename))));
  });
}

function unlinkSftpFile(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => (error ? reject(error) : resolve()));
  });
}

async function verifySftp(): Promise<void> {
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    client
      .once("ready", resolve)
      .once("error", reject)
      .connect({
        host,
        port: sftpPort,
        username,
        password,
        readyTimeout: 5_000,
        // The ephemeral local SFTP server is intentionally accepted without a known-hosts file.
        hostVerifier: () => true,
      });
  });

  const remoteName = `/home/pallet/.pallet-sftp-verify.txt`;
  const payload = Buffer.from("Pallet SFTP upload verification\n");

  try {
    const sftp = await getSftp(client);
    const listing = await listSftpDirectory(sftp, "/home/pallet");
    if (!listing.includes("README.txt")) throw new Error("SFTP listing omitted README.txt");

    const fixture = await readSftpFile(sftp, "/home/pallet/README.txt");
    if (!fixture.toString().includes(expectedFixture)) throw new Error("SFTP returned an unexpected fixture");

    await writeSftpFile(sftp, remoteName, payload);
    const downloaded = await readSftpFile(sftp, remoteName);
    if (!downloaded.equals(payload)) throw new Error("SFTP upload did not round-trip");
    await unlinkSftpFile(sftp, remoteName);
    sftp.end();
    console.log("✓ SFTP login, listing, download, upload, and delete");
  } finally {
    client.end();
  }
}

await verifySftp();
verifyFtp("FTP", ftpPort, false);
verifyFtp("FTPS", ftpsPort, true);
console.log("All local transfer servers passed end-to-end verification.");
