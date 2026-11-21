import type { DirListing, Entry } from "@shared/fs/fs.types";
import { SMB_DIR_MODE, SMB_FILE_MODE, type SmbConnection, type SmbStats, normalizePath, smbError } from "./smb-client";
import type { SessionManager } from "../sftp/session-manager";

function join(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function smbEntry(path: string, stats: SmbStats): Entry {
  const name = path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
  const isDir = stats.isDirectory();
  return {
    name,
    path,
    kind: isDir ? "dir" : "file",
    size: isDir ? 0 : stats.size,
    mtimeMs: stats.mtime.getTime(),
    mode: isDir ? SMB_DIR_MODE : SMB_FILE_MODE,
    hidden: name.startsWith("."),
  };
}

const ROOT_ENTRY: Entry = { name: "/", path: "/", kind: "dir", size: 0, mtimeMs: 0, mode: SMB_DIR_MODE, hidden: false };

export async function listSmb(connection: SmbConnection, dirPath: string): Promise<Entry[]> {
  const dir = normalizePath(dirPath);
  const raw = await connection.run((client) => client.readdir(connection.path(dir), { withFileTypes: true }));
  return raw.map((dirent) => smbEntry(join(dir, dirent.name), dirent));
}

export async function statSmb(connection: SmbConnection, p: string): Promise<Entry> {
  const path = normalizePath(p);
  if (path === "/") return ROOT_ENTRY;
  const stats = await connection.run((client) => client.stat(connection.path(path)));
  return smbEntry(path, { ...stats, isDirectory: () => stats.isDirectory });
}

export async function statSmbOrNull(connection: SmbConnection, p: string): Promise<Entry | null> {
  try {
    return await statSmb(connection, p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function removeSmb(connection: SmbConnection, p: string): Promise<void> {
  const entry = await statSmb(connection, p);
  if (entry.path === "/") throw smbError("EINVAL", "Cannot delete the share root");
  if (entry.kind === "dir") {
    for (const child of await listSmb(connection, entry.path)) await removeSmb(connection, child.path);
    await connection.run((client) => client.rmdir(connection.path(entry.path)));
  } else {
    await connection.run((client) => client.rm(connection.path(entry.path)));
  }
}

export async function sumSmb(connection: SmbConnection, root: string): Promise<number> {
  let total = 0;
  const stack = [normalizePath(root)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Entry[];
    try {
      entries = await listSmb(connection, dir);
    } catch (err) {
      if (connection.closed) throw err;
      continue;
    }
    for (const entry of entries) {
      if (entry.kind === "dir") stack.push(entry.path);
      else total += entry.size;
    }
  }
  return total;
}

export async function readSmbBytes(connection: SmbConnection, p: string, maxBytes: number): Promise<Buffer> {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const stream = connection.openRead(p);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).length;
    if (total >= maxBytes) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

export class SmbService {
  constructor(private sessions: SessionManager) {}

  private async run<T>(sessionId: string, fn: (connection: SmbConnection) => Promise<T>): Promise<T> {
    const connection = this.sessions.smbConnection(sessionId);
    try {
      return await fn(connection);
    } catch (err) {
      this.sessions.noteSmbFailure(sessionId, err);
      throw err;
    }
  }

  async list(sessionId: string, dirPath: string): Promise<DirListing> {
    const path = normalizePath(dirPath);
    return this.run(sessionId, async (connection) => ({
      path,
      entries: await listSmb(connection, path),
      availBytes: null,
    }));
  }

  stat(sessionId: string, p: string): Promise<Entry> {
    return this.run(sessionId, (connection) => statSmb(connection, p));
  }

  realpath(sessionId: string, p: string): Promise<string> {
    return this.run(sessionId, async (connection) => {
      const entry = await statSmb(connection, p);
      if (entry.kind !== "dir") throw smbError("ENOTDIR", `Not a folder: ${entry.path}`);
      return entry.path;
    });
  }

  mkdir(sessionId: string, p: string): Promise<void> {
    return this.run(sessionId, (connection) => connection.run((client) => client.mkdir(connection.path(p))));
  }

  rename(sessionId: string, from: string, to: string): Promise<void> {
    return this.run(sessionId, async (connection) => {
      if (await statSmbOrNull(connection, to)) {
        throw smbError("EEXIST", `"${to.slice(to.lastIndexOf("/") + 1)}" already exists`);
      }
      await connection.run((client) => client.rename(connection.path(from), connection.path(to)));
    });
  }

  removeRecursive(sessionId: string, p: string): Promise<void> {
    return this.run(sessionId, (connection) => removeSmb(connection, p));
  }

  chmod(): Promise<void> {
    return Promise.reject(smbError("ENOTSUP", "SMB shares do not expose editable POSIX permissions"));
  }

  readBytes(sessionId: string, p: string, maxBytes: number): Promise<Buffer> {
    return this.run(sessionId, (connection) => readSmbBytes(connection, p, maxBytes));
  }

  folderSize(sessionId: string, p: string): Promise<number> {
    return this.run(sessionId, (connection) => sumSmb(connection, p));
  }
}
