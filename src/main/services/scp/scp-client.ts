import type { ClientChannel, Client as SshClient } from "ssh2";
import {
  PROBE_SCRIPT,
  READY_MARKER,
  type StatDialect,
  exitError,
  octalMode,
  parseProbe,
  scpError,
  sinkScript,
  sourceScript,
} from "./scp-shell";
import { Readable, Writable } from "stream";
import type { TransferWriteStream } from "../transfer/transfer-endpoint";

const ACQUIRE_TIMEOUT_MS = 20_000;
const MAX_LINE = 4096;
const MAX_STDERR = 8192;
/** Startup files (e.g. a chatty ~/.bashrc) may print before the script runs. */
const MAX_PREAMBLE = 64 * 1024;
const HIGH_WATER = 1024 * 1024;

/** Buffered pull reader over a channel's stdout, pausing the channel when full. */
class ChannelReader {
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;
  private wake: (() => void) | null = null;

  constructor(private stream: Readable) {
    stream.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      if (this.buffer.length >= HIGH_WATER) stream.pause();
      this.notify();
    });
    const end = (): void => {
      this.ended = true;
      this.notify();
    };
    stream.once("end", end);
    stream.once("close", end);
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async fill(): Promise<void> {
    if (this.ended) throw scpError("ECONNABORTED", "SCP channel closed unexpectedly");
    this.stream.resume();
    await new Promise<void>((resolve) => (this.wake = resolve));
  }

  private take(n: number): Buffer {
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    if (this.buffer.length < HIGH_WATER) this.stream.resume();
    return out;
  }

  async byte(): Promise<number> {
    while (this.buffer.length < 1) await this.fill();
    return this.take(1)[0];
  }

  async line(max = MAX_LINE): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf(10);
      if (end !== -1 && end < max) return this.take(end + 1).toString("utf8", 0, end);
      if (this.buffer.length >= max) throw scpError("EPROTO", "SCP protocol line too long");
      await this.fill();
    }
  }

  /** Up to `max` bytes, at least one. */
  async chunk(max: number): Promise<Buffer> {
    while (this.buffer.length < 1) await this.fill();
    return this.take(Math.min(max, this.buffer.length));
  }

  async rest(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for (;;) {
      if (this.buffer.length) chunks.push(this.take(this.buffer.length));
      if (this.ended) return Buffer.concat(chunks);
      this.stream.resume();
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  /** Skip anything printed before the script's marker line. */
  async marker(): Promise<void> {
    let skipped = 0;
    for (;;) {
      const line = await this.line(MAX_PREAMBLE);
      if (`${line}\n` === READY_MARKER) return;
      skipped += line.length + 1;
      if (skipped > MAX_PREAMBLE)
        throw scpError("EPROTO", "The server printed unexpected output before running Pallet's command");
    }
  }
}

interface Exec {
  channel: ClientChannel;
  reader: ChannelReader;
  /** Resolves with the exit code (null when killed or not reported) once the channel closes. */
  done: Promise<number | null>;
  stderr(): string;
}

function protocolError(message: string): NodeJS.ErrnoException {
  const detail = message.replace(/^scp: /, "").trim();
  if (/no such file/i.test(detail)) return scpError("ENOENT", detail);
  if (/permission denied/i.test(detail)) return scpError("EACCES", detail);
  if (/is a directory|not a regular file/i.test(detail)) return scpError("EISDIR", detail);
  return scpError("EIO", detail || "SCP transfer failed");
}

async function readAck(reader: ChannelReader): Promise<void> {
  const status = await reader.byte();
  if (status === 0) return;
  const message = await reader.line();
  if (status === 1 || status === 2) throw protocolError(message);
  throw scpError("EPROTO", "Unexpected reply from the remote scp");
}

/** One SSH connection used through short-lived `sh -s` exec channels. */
export class ScpConnection {
  closed = false;
  private active = 0;
  private waiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

  private constructor(
    private client: SshClient,
    private limit: number,
    readonly dialect: StatDialect,
    readonly home: string,
  ) {}

  /** Probe the server and fail early when it lacks what SCP browsing needs. */
  static async open(client: SshClient, limit: number): Promise<ScpConnection> {
    const probeConnection = new ScpConnection(client, limit, "gnu", "/");
    const probe = parseProbe((await probeConnection.run(PROBE_SCRIPT, "Could not inspect the server")).stdout);
    if (!probe.dialect) {
      throw scpError(
        "ENOTSUP",
        "SCP connections need the stat and xargs commands on the server, and this server has neither in a supported form",
      );
    }
    if (!probe.hasScp) throw scpError("ENOTSUP", "The server has no scp command");
    return new ScpConnection(client, limit, probe.dialect, probe.home);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(scpError("ENOTCONN", "Connection lost"));
  }

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) throw scpError("ENOTCONN", "Not connected");
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      // A waiter leaves the queue synchronously when it gives up, so a release can never hand it a permit.
      await new Promise<void>((resolve, reject) => {
        const settle = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
        };
        const waiter = {
          resolve: () => {
            settle();
            resolve();
          },
          reject: (err: Error) => {
            settle();
            reject(err);
          },
        };
        const onAbort = (): void => waiter.reject(new Error("Transfer interrupted"));
        const timer = setTimeout(
          () => waiter.reject(scpError("ETIMEDOUT", "Transfer connection timed out")),
          ACQUIRE_TIMEOUT_MS,
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(waiter);
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.resolve();
      else this.active--;
    };
  }

  /** Open an exec channel. Its permit is held until the channel closes. */
  private async exec(signal?: AbortSignal): Promise<Exec> {
    const release = await this.acquire(signal);
    let channel: ClientChannel;
    try {
      channel = await new Promise<ClientChannel>((resolve, reject) =>
        this.client.exec("sh -s", (err, stream) => (err ? reject(err) : resolve(stream))),
      );
    } catch (err) {
      release();
      throw scpError("ECONNABORTED", `Could not open an SSH channel: ${(err as Error).message}`);
    }
    let stderr = "";
    channel.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
    });
    let code: number | null = null;
    channel.on("exit", (exitCode: number | null) => (code = exitCode));
    channel.on("error", () => {});
    const done = new Promise<number | null>((resolve) =>
      channel.once("close", () => {
        release();
        resolve(code);
      }),
    );
    return { channel, reader: new ChannelReader(channel), done, stderr: () => stderr };
  }

  /** Run a script to completion. Nonzero exit becomes an errno-coded error. */
  async run(script: string, what: string, timeoutMs?: number): Promise<{ stdout: Buffer; stderr: string }> {
    const exec = await this.exec();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      if (!timeoutMs) return;
      timer = setTimeout(() => {
        exec.channel.close();
        reject(scpError("ETIMEDOUT", `${what}: the server did not respond`));
      }, timeoutMs);
    });
    try {
      exec.channel.end(`printf 'PALLET-READY\\n'\n${script}`);
      const stdout = await Promise.race([exec.reader.marker().then(() => exec.reader.rest()), timedOut]);
      const code = await Promise.race([exec.done, timedOut]);
      if (code !== 0) throw exitError(code, exec.stderr(), what);
      return { stdout, stderr: exec.stderr() };
    } catch (err) {
      exec.channel.close();
      if ((err as NodeJS.ErrnoException).code === "ECONNABORTED") {
        const code = await exec.done;
        throw exitError(code, exec.stderr(), what);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private static async finish(exec: Exec): Promise<void> {
    const code = await exec.done;
    if (code !== 0) throw exitError(code, exec.stderr(), "Remote scp failed");
  }

  /**
   * Download with `scp -f`. Stops after `limit` bytes when given; otherwise
   * the stream ends only after the source's final status and a clean exit.
   */
  async openSource(path: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<Readable> {
    const exec = await this.exec(options.signal);
    const { channel, reader } = exec;
    let size: number;
    try {
      channel.write(sourceScript(path));
      await reader.marker();
      channel.write("\0");
      for (;;) {
        const line = await reader.line();
        if (line.startsWith("T")) {
          channel.write("\0");
          continue;
        }
        if (line.startsWith("\x01") || line.startsWith("\x02")) throw protocolError(line.slice(1));
        if (line.startsWith("D")) throw scpError("EISDIR", `Not a file: ${path}`);
        // The wire name is escaped by OpenSSH and ignored here: the requested path is the identity.
        const match = /^C[0-7]{4} (\d+) /.exec(line);
        if (!match) throw scpError("EPROTO", "Unexpected reply from the remote scp");
        size = Number(match[1]);
        if (!Number.isSafeInteger(size)) throw scpError("EPROTO", "Invalid file size from the remote scp");
        channel.write("\0");
        break;
      }
    } catch (err) {
      channel.close();
      throw err;
    }
    const wanted = Math.min(options.limit ?? size, size);
    let remaining = size;
    let emitted = 0;
    let pumping = false;
    let finished = false;
    const out = new Readable({
      read: () => void pump(),
      destroy: (err, callback) => {
        if (!finished) channel.close();
        options.signal?.removeEventListener("abort", abort);
        callback(err);
      },
    });
    const pump = async (): Promise<void> => {
      if (pumping || finished) return;
      pumping = true;
      try {
        while (emitted < wanted) {
          const chunk = await reader.chunk(Math.min(remaining, wanted - emitted));
          remaining -= chunk.length;
          emitted += chunk.length;
          if (!out.push(chunk) && emitted < wanted) return;
        }
        if (remaining > 0) {
          // A bounded read: the remaining bytes are not needed.
          finished = true;
          channel.close();
          out.push(null);
          return;
        }
        await readAck(reader);
        channel.end("\0");
        await ScpConnection.finish(exec);
        finished = true;
        out.push(null);
      } catch (err) {
        out.destroy(err as Error);
      } finally {
        pumping = false;
      }
    };
    const abort = (): void => {
      out.destroy(new Error("Transfer interrupted"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    return out;
  }

  /**
   * Upload with `scp -p -t` to `path`. The C record carries the exact size and
   * mode (applied exactly because of -p); a T record sets mtime when given.
   * The stream finishes only after the sink's final ack and a clean exit.
   */
  async openSink(
    path: string,
    options: { size: number; mode: number; mtimeMs?: number; signal?: AbortSignal },
  ): Promise<TransferWriteStream> {
    const exec = await this.exec(options.signal);
    const { channel, reader } = exec;
    try {
      channel.write(sinkScript(path));
      await reader.marker();
      await readAck(reader);
      if (options.mtimeMs !== undefined) {
        const seconds = Math.floor(options.mtimeMs / 1000);
        channel.write(`T${seconds} 0 ${seconds} 0\n`);
        await readAck(reader);
      }
      // The target is a file path, so the sink ignores this name.
      channel.write(`C${octalMode(options.mode)} ${options.size} pallet-upload\n`);
      await readAck(reader);
    } catch (err) {
      channel.close();
      throw err;
    }
    let written = 0;
    let committed = false;
    const out = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        if (written + chunk.length > options.size) {
          callback(scpError("EPROTO", "More data than the announced file size"));
          return;
        }
        written += chunk.length;
        if (channel.write(chunk)) callback();
        else channel.once("drain", () => callback());
      },
      final: (callback) => {
        if (written !== options.size) {
          callback(scpError("EPROTO", "Less data than the announced file size"));
          return;
        }
        channel.write("\0");
        readAck(reader)
          .then(() => {
            channel.end();
            return ScpConnection.finish(exec);
          })
          .then(
            () => {
              committed = true;
              callback();
            },
            (err: Error) => callback(err),
          );
      },
      destroy: (err, callback) => {
        if (!committed) channel.close();
        options.signal?.removeEventListener("abort", abort);
        callback(err);
      },
    });
    const abort = (): void => {
      out.destroy(new Error("Transfer interrupted"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    return out;
  }
}
