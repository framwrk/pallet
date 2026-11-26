import type { DirListing, Entry } from "@shared/fs/fs.types";
import {
  WEBDAV_DIR_MODE,
  WEBDAV_FILE_MODE,
  type WebDavConnection,
  type WebDavResource,
  normalizePath,
  webdavError,
} from "./webdav-client";
import type { SessionManager } from "../sftp/session-manager";

export function webdavEntry(resource: WebDavResource): Entry {
  const name = resource.path === "/" ? "/" : resource.path.slice(resource.path.lastIndexOf("/") + 1);
  return {
    name,
    path: resource.path,
    kind: resource.isDir ? "dir" : "file",
    size: resource.size,
    mtimeMs: resource.mtimeMs,
    mode: resource.isDir ? WEBDAV_DIR_MODE : WEBDAV_FILE_MODE,
    hidden: name.startsWith("."),
  };
}

export async function listWebDav(connection: WebDavConnection, dirPath: string): Promise<Entry[]> {
  const dir = normalizePath(dirPath);
  const resources = await connection.propfind(dir, 1, true);
  return resources.filter((resource) => resource.path !== dir).map(webdavEntry);
}

export async function statWebDav(connection: WebDavConnection, p: string): Promise<Entry> {
  const path = normalizePath(p);
  const resources = await connection.propfind(path, 0, path === "/");
  const resource = resources.find((r) => r.path === path) ?? resources[0];
  if (!resource) throw webdavError("ENOENT", `Not found: ${path}`);
  return webdavEntry({ ...resource, path });
}

export async function statWebDavOrNull(connection: WebDavConnection, p: string): Promise<Entry | null> {
  try {
    return await statWebDav(connection, p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function moveWebDav(
  connection: WebDavConnection,
  from: string,
  to: string,
  options: { dir: boolean; overwrite: boolean },
): Promise<void> {
  await connection.expectOk("MOVE", from, {
    dir: options.dir,
    headers: { Destination: connection.url(to, options.dir), Overwrite: options.overwrite ? "T" : "F" },
  });
}

export async function removeWebDav(connection: WebDavConnection, p: string): Promise<void> {
  const entry = await statWebDav(connection, p);
  if (entry.path === "/") throw webdavError("EINVAL", "Cannot delete the server folder Pallet is connected to");
  await connection.expectOk("DELETE", entry.path, { dir: entry.kind === "dir" });
}

export async function sumWebDav(connection: WebDavConnection, root: string): Promise<number> {
  let total = 0;
  const stack = [normalizePath(root)];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Entry[];
    try {
      entries = await listWebDav(connection, dir);
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

export async function readWebDavBytes(connection: WebDavConnection, p: string, maxBytes: number): Promise<Buffer> {
  if (maxBytes <= 0) return Buffer.alloc(0);
  const stream = await connection.openRead(p, { end: maxBytes - 1 });
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

export class WebDavService {
  constructor(private sessions: SessionManager) {}

  private async run<T>(sessionId: string, fn: (connection: WebDavConnection) => Promise<T>): Promise<T> {
    const connection = this.sessions.webdavConnection(sessionId);
    try {
      return await fn(connection);
    } catch (err) {
      this.sessions.noteWebDavFailure(sessionId, err);
      throw err;
    }
  }

  async list(sessionId: string, dirPath: string): Promise<DirListing> {
    const path = normalizePath(dirPath);
    return this.run(sessionId, async (connection) => ({
      path,
      entries: await listWebDav(connection, path),
      availBytes: null,
    }));
  }

  stat(sessionId: string, p: string): Promise<Entry> {
    return this.run(sessionId, (connection) => statWebDav(connection, p));
  }

  realpath(sessionId: string, p: string): Promise<string> {
    return this.run(sessionId, async (connection) => {
      const entry = await statWebDav(connection, p);
      if (entry.kind !== "dir") throw webdavError("ENOTDIR", `Not a folder: ${entry.path}`);
      return entry.path;
    });
  }

  mkdir(sessionId: string, p: string): Promise<void> {
    return this.run(sessionId, (connection) => connection.expectOk("MKCOL", p, { dir: true }));
  }

  rename(sessionId: string, from: string, to: string): Promise<void> {
    return this.run(sessionId, async (connection) => {
      if (await statWebDavOrNull(connection, to)) {
        throw webdavError("EEXIST", `"${to.slice(to.lastIndexOf("/") + 1)}" already exists`);
      }
      const source = await statWebDav(connection, from);
      await moveWebDav(connection, from, to, { dir: source.kind === "dir", overwrite: false });
    });
  }

  removeRecursive(sessionId: string, p: string): Promise<void> {
    return this.run(sessionId, (connection) => removeWebDav(connection, p));
  }

  chmod(): Promise<void> {
    return Promise.reject(webdavError("ENOTSUP", "WebDAV servers do not expose editable POSIX permissions"));
  }

  readBytes(sessionId: string, p: string, maxBytes: number): Promise<Buffer> {
    return this.run(sessionId, (connection) => readWebDavBytes(connection, p, maxBytes));
  }

  folderSize(sessionId: string, p: string): Promise<number> {
    return this.run(sessionId, (connection) => sumWebDav(connection, p));
  }
}
