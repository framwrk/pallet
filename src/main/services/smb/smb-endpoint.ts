import type {
  EndpointStat,
  ReadOptions,
  TransferEndpoint,
  TransferWriteStream,
  WriteOptions,
} from "../transfer/transfer-endpoint";
import { type SmbConnection, normalizePath, smbError } from "./smb-client";
import { listSmb, statSmbOrNull } from "./smb.service";
import type { Entry } from "@shared/fs/fs.types";
import { Readable } from "stream";
import type { SessionManager } from "../sftp/session-manager";

function statFrom(entry: Entry): EndpointStat {
  return { size: entry.size, mtimeMs: entry.mtimeMs, mode: entry.mode, isDir: entry.kind === "dir", isSymlink: false };
}

async function* limitBytes(source: Readable, limit: number): AsyncGenerator<Buffer> {
  let left = limit;
  for await (const chunk of source) {
    const buffer = chunk as Buffer;
    if (buffer.length >= left) {
      yield buffer.subarray(0, left);
      return;
    }
    left -= buffer.length;
    yield buffer;
  }
}

function abortWith(stream: Readable | TransferWriteStream, signal: AbortSignal | undefined): void {
  if (!signal) return;
  const abort = (): void => {
    stream.destroy(new Error("Transfer interrupted"));
  };
  signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
}

export class SmbEndpoint implements TransferEndpoint {
  kind = "sftp" as const;
  supportsRanges = false;
  writesMeta = false;

  constructor(
    private sessions: SessionManager,
    private sessionId: string,
  ) {}

  private async run<T>(fn: (connection: SmbConnection) => Promise<T>): Promise<T> {
    const connection = this.sessions.smbConnection(this.sessionId);
    try {
      return await fn(connection);
    } catch (err) {
      this.sessions.noteSmbFailure(this.sessionId, err);
      throw err;
    }
  }

  statOrNull(p: string): Promise<EndpointStat | null> {
    return this.run(async (connection) => {
      const entry = await statSmbOrNull(connection, p);
      return entry ? statFrom(entry) : null;
    });
  }

  listNames(dir: string): Promise<string[]> {
    return this.run(async (connection) => {
      try {
        return (await listSmb(connection, dir)).map((entry) => entry.name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    });
  }

  listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]> {
    return this.run(async (connection) =>
      (await listSmb(connection, dir)).map((entry) => ({ name: entry.name, stat: statFrom(entry) })),
    );
  }

  async mkdirp(p: string): Promise<void> {
    const path = normalizePath(p);
    if (path === "/") return;
    const existing = await this.statOrNull(path);
    if (existing?.isDir) return;
    if (existing) throw smbError("EEXIST", `A file already exists at ${path}`);
    await this.mkdirp(path.slice(0, path.lastIndexOf("/")) || "/");
    await this.run(async (connection) => {
      try {
        await connection.run((client) => client.mkdir(connection.path(path)));
      } catch (err) {
        if ((await statSmbOrNull(connection, path))?.kind !== "dir") throw err;
      }
    });
  }

  async createReadStream(p: string, options: ReadOptions = {}): Promise<Readable> {
    options.signal?.throwIfAborted();
    if (options.start) throw smbError("ENOTSUP", "SMB transfers do not resume mid-file");
    const source = this.sessions.smbConnection(this.sessionId).openRead(p);
    const stream = options.end === undefined ? source : Readable.from(limitBytes(source, options.end + 1));
    abortWith(stream, options.signal);
    return stream;
  }

  async createWriteStream(p: string, _mode?: number, options: WriteOptions = {}): Promise<TransferWriteStream> {
    options.signal?.throwIfAborted();
    if (options.start) throw smbError("ENOTSUP", "SMB transfers do not resume mid-file");
    const stream = this.sessions.smbConnection(this.sessionId).openWrite(p);
    abortWith(stream, options.signal);
    return stream;
  }

  setMeta(): Promise<void> {
    return Promise.resolve();
  }

  renameReplacing(from: string, to: string): Promise<void> {
    return this.run((connection) =>
      connection.run((client) => client.rename(connection.path(from), connection.path(to), { replace: true })),
    );
  }

  removeFile(p: string): Promise<void> {
    return this.run(async (connection) => {
      try {
        await connection.run((client) => client.rm(connection.path(p)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    });
  }

  dispose(): void {
    // The SMB connection belongs to the session, not to one queue job.
  }
}
