import type { DirListing, Entry } from "@shared/fs/fs.types";
import {
  type RawStat,
  chmodScript,
  entryFrom,
  listScript,
  mkdirScript,
  parseListing,
  parseStat,
  realpathScript,
  removeTreeScript,
  renameScript,
  scpError,
  statScript,
} from "./scp-shell";
import type { ScpConnection } from "./scp-client";
import type { SessionManager } from "../sftp/session-manager";

export async function listScp(connection: ScpConnection, dir: string, timeoutMs?: number): Promise<Entry[]> {
  const { stdout, stderr } = await connection.run(listScript(dir, connection.dialect), "Could not list the folder", timeoutMs);
  const entries = parseListing(stdout, connection.dialect);
  const expected = stdout.toString("utf8").split("\0").indexOf("");
  // A missing stat record is fine only when the entry vanished mid-listing.
  if (entries.length < expected && stderr.trim() && !/no such file/i.test(stderr)) {
    throw scpError("EIO", `Could not list the folder: ${stderr.trim().split("\n").at(-1)}`);
  }
  return entries.map(({ name, stat }) => entryFrom(dir, name, stat));
}

export async function statScpOrNull(connection: ScpConnection, path: string, timeoutMs?: number): Promise<RawStat | null> {
  try {
    const { stdout } = await connection.run(statScript(path, connection.dialect), "Could not read file info", timeoutMs);
    return parseStat(stdout, path, connection.dialect);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Sum file sizes below root. Symlinks are listed by lstat and never descended into. */
export async function sumScp(connection: ScpConnection, root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Entry[];
    try {
      entries = await listScp(connection, dir);
    } catch (err) {
      if (connection.closed) throw err;
      continue;
    }
    for (const entry of entries) {
      if (entry.kind === "dir") stack.push(entry.path);
      else if (entry.kind === "file") total += entry.size;
    }
  }
  return total;
}

export class ScpService {
  constructor(private sessions: SessionManager) {}

  private connection(sessionId: string): ScpConnection {
    return this.sessions.scpConnection(sessionId);
  }

  async list(sessionId: string, dirPath: string): Promise<DirListing> {
    return { path: dirPath, entries: await listScp(this.connection(sessionId), dirPath), availBytes: null };
  }

  async stat(sessionId: string, p: string): Promise<Entry> {
    const stat = await statScpOrNull(this.connection(sessionId), p);
    if (!stat) throw scpError("ENOENT", `Remote path not found: ${p}`);
    if (p === "/") return { ...entryFrom("/", "/", stat), path: "/" };
    const slash = p.lastIndexOf("/");
    return entryFrom(p.slice(0, slash) || "/", p.slice(slash + 1), stat);
  }

  async realpath(sessionId: string, p: string): Promise<string> {
    const { stdout } = await this.connection(sessionId).run(realpathScript(p), "Could not open the folder");
    return stdout.toString("utf8").replace(/\n$/, "");
  }

  async mkdir(sessionId: string, p: string): Promise<void> {
    await this.connection(sessionId).run(mkdirScript(p), "Could not create the folder");
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    try {
      await this.connection(sessionId).run(renameScript(from, to), "Could not rename");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw scpError("EEXIST", `"${to.slice(to.lastIndexOf("/") + 1)}" already exists`);
      }
      throw err;
    }
  }

  async removeRecursive(sessionId: string, p: string): Promise<void> {
    await this.connection(sessionId).run(removeTreeScript(p), "Could not delete");
  }

  async chmod(sessionId: string, p: string, mode: number): Promise<void> {
    await this.connection(sessionId).run(chmodScript(p, mode), "Could not change permissions");
  }

  async readBytes(sessionId: string, p: string, maxBytes: number): Promise<Buffer> {
    if (maxBytes <= 0) return Buffer.alloc(0);
    const stream = await this.connection(sessionId).openSource(p, { limit: maxBytes });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  folderSize(sessionId: string, p: string): Promise<number> {
    return sumScp(this.connection(sessionId), p);
  }
}
