import type {
  EndpointStat,
  ReadOptions,
  TransferEndpoint,
  TransferWriteStream,
  WriteOptions,
} from "../transfer/transfer-endpoint";
import { type RawStat, chmodScript, mkdirpScript, removeFileScript, replaceScript, scpError, touchScript } from "./scp-shell";
import { isDirMode, isSymlinkMode } from "../../utils/file-mode";
import { listScp, statScpOrNull } from "./scp.service";
import type { Readable } from "stream";
import type { ScpConnection } from "./scp-client";
import type { SessionManager } from "../sftp/session-manager";

const META_TIMEOUT_MS = 20_000;

function statFrom(stat: Pick<RawStat, "mode" | "size" | "mtimeMs">): EndpointStat {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    isDir: isDirMode(stat.mode),
    isSymlink: isSymlinkMode(stat.mode),
  };
}

/** SCP has no offsets: every transfer streams the whole file, so retries restart at byte 0. */
export class ScpEndpoint implements TransferEndpoint {
  kind = "sftp" as const;
  supportsRanges = false;
  writesMeta = true;

  constructor(
    private sessions: SessionManager,
    private sessionId: string,
  ) {}

  private get connection(): ScpConnection {
    return this.sessions.scpConnection(this.sessionId);
  }

  private async run(script: string, what: string): Promise<void> {
    await this.connection.run(script, what, META_TIMEOUT_MS);
  }

  async statOrNull(p: string): Promise<EndpointStat | null> {
    const stat = await statScpOrNull(this.connection, p, META_TIMEOUT_MS);
    return stat ? statFrom(stat) : null;
  }

  async listNames(dir: string): Promise<string[]> {
    try {
      return (await listScp(this.connection, dir, META_TIMEOUT_MS)).map((entry) => entry.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]> {
    return (await listScp(this.connection, dir, META_TIMEOUT_MS)).map((entry) => ({ name: entry.name, stat: statFrom(entry) }));
  }

  async mkdirp(p: string): Promise<void> {
    await this.run(mkdirpScript(p), "Could not create the folder");
  }

  async createReadStream(p: string, options: ReadOptions = {}): Promise<Readable> {
    if (options.start) throw scpError("ENOTSUP", "SCP transfers do not resume mid-file");
    return this.connection.openSource(p, {
      ...(options.end !== undefined ? { limit: options.end + 1 } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async createWriteStream(p: string, mode?: number, options: WriteOptions = {}): Promise<TransferWriteStream> {
    if (options.start) throw scpError("ENOTSUP", "SCP transfers do not resume mid-file");
    if (options.size === undefined) throw scpError("EINVAL", "SCP uploads need the file size up front");
    return this.connection.openSink(p, {
      size: options.size,
      mode: options.meta?.mode ?? mode ?? 0o644,
      ...(options.meta ? { mtimeMs: options.meta.mtimeMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async setMeta(p: string, meta: { mtimeMs: number; mode?: number }): Promise<void> {
    const script = `set -e\n${touchScript(p, meta.mtimeMs)}${meta.mode != null ? chmodScript(p, meta.mode) : ""}`;
    await this.run(script, "Could not set file info");
  }

  async renameReplacing(from: string, to: string): Promise<void> {
    await this.run(replaceScript(from, to), "Could not replace the file");
  }

  async removeFile(p: string): Promise<void> {
    await this.run(removeFileScript(p), "Could not remove the staged file");
  }

  dispose(): void {
    // Each operation opens and closes its own exec channel.
  }
}
