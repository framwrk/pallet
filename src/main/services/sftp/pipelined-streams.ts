/**
 * Pipelined SFTP stream adapters.
 *
 * ssh2's own ReadStream/WriteStream keep a single request in flight, so a
 * stream's throughput is capped at one chunk per round trip (256 KiB ÷ RTT,
 * e.g. ~3 MiB/s on a 20 ms link no matter how much bandwidth is available).
 * OpenSSH's sftp client and rclone keep dozens of reads/writes outstanding;
 * these adapters do the same on one leased channel while preserving Node
 * stream backpressure, abort handling, and the destination-confirmed byte
 * accounting the transfer queue uses to resume after a failure.
 */
import { Readable, Writable } from "stream";
import type { SFTPWrapper } from "ssh2";

/** In-flight requests per stream: 32 × 128 KiB keeps ~4 MiB in flight. */
const WINDOW = 32;
const CHUNK = 128 * 1024;

export interface PipelinedReadOptions {
  start?: number;
  /** Inclusive end offset, matching ssh2's createReadStream. */
  end?: number;
}

export interface PipelinedWriteOptions {
  start?: number;
}

/** Readable that issues up to WINDOW concurrent sftp.read requests. */
export interface PipelinedReadStream extends Readable {
  /** True once every byte was delivered and the handle was closed cleanly. */
  completed: boolean;
}

/** Writable that issues up to WINDOW concurrent sftp.write requests. */
export interface PipelinedWriteStream extends Writable {
  /** Highest contiguous byte offset the server has acknowledged so far. */
  confirmedBytes(): number;
  /** True once the server acknowledged the final CLOSE. */
  committed: boolean;
}

export function createPipelinedReadStream(
  sftp: SFTPWrapper,
  path: string,
  options: PipelinedReadOptions = {},
): Promise<PipelinedReadStream> {
  return new Promise((resolve, reject) => {
    sftp.open(path, "r", 0o600, (err, handle) => {
      if (err) reject(err);
      else resolve(new ReadStream(sftp, handle, options));
    });
  });
}

export function createPipelinedWriteStream(
  sftp: SFTPWrapper,
  path: string,
  mode: number | undefined,
  options: PipelinedWriteOptions = {},
): Promise<PipelinedWriteStream> {
  return new Promise((resolve, reject) => {
    const start = options.start ?? 0;
    sftp.open(path, start > 0 ? "r+" : "w", mode ?? 0o600, (err, handle) => {
      if (err) reject(err);
      else resolve(new WriteStream(sftp, handle, start));
    });
  });
}

/** Half-open byte range [start, end); end may be Infinity. */
interface Range {
  start: number;
  end: number;
}

class ReadStream extends Readable {
  completed = false;
  private handle: Buffer | null;
  private ranges: Range[] = [];
  /** Completed chunks waiting for their predecessors, keyed by offset. */
  private ready = new Map<number, Buffer>();
  private outstanding = 0;
  private nextPush: number;
  private needPush = false;
  private sawEof = false;

  constructor(
    private sftp: SFTPWrapper,
    handle: Buffer,
    options: PipelinedReadOptions,
  ) {
    super({ highWaterMark: CHUNK });
    this.handle = handle;
    this.nextPush = options.start ?? 0;
    this.ranges.push({ start: this.nextPush, end: options.end !== undefined ? options.end + 1 : Infinity });
  }

  _read(): void {
    this.needPush = false;
    this.drain();
    this.pump();
  }

  private pump(): void {
    if (this.destroyed || this.needPush) return;
    while (this.outstanding < WINDOW && this.ranges.length > 0) {
      const range = this.ranges.shift()!;
      const offset = range.start;
      const length = Math.min(CHUNK, range.end - offset);
      if (length <= 0) continue;
      // Keep the unread tail of this range queued behind its issue.
      if (range.end > offset + length) this.ranges.unshift({ start: offset + length, end: range.end });
      this.outstanding++;
      const buffer = Buffer.allocUnsafe(length);
      this.sftp.read(this.handle!, buffer, 0, length, offset, (err, bytesRead, data) => {
        this.outstanding--;
        if (this.destroyed) return;
        if (err) {
          this.destroy(err);
          return;
        }
        const chunk = data ?? buffer.subarray(0, bytesRead);
        if (bytesRead <= 0) {
          // EOF: no more requests make sense, drain what is buffered.
          this.sawEof = true;
          this.ranges.length = 0;
        } else {
          this.ready.set(offset, chunk);
          if (bytesRead < length) this.ranges.unshift({ start: offset + bytesRead, end: offset + length });
        }
        this.drain();
        this.pump();
      });
    }
  }

  private drain(): void {
    for (;;) {
      const chunk = this.ready.get(this.nextPush);
      if (!chunk) break;
      this.ready.delete(this.nextPush);
      this.nextPush += chunk.length;
      if (!this.push(chunk)) {
        this.needPush = true;
        return;
      }
    }
    if (this.outstanding === 0 && this.ready.size === 0 && (this.sawEof || this.nextPush >= this.knownEnd())) {
      this.completed = true;
      this.push(null);
    }
  }

  private knownEnd(): number {
    const first = this.ranges[0];
    return first ? first.end : this.nextPush;
  }

  _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    const handle = this.handle;
    this.handle = null;
    if (!handle) {
      callback(err);
      return;
    }
    this.sftp.close(handle, (closeErr) => callback(closeErr && !err ? closeErr : err));
  }
}

class WriteStream extends Writable {
  committed = false;
  private handle: Buffer | null;
  private pos: number;
  private acked: number;
  /** Issued writes in offset order, used to advance the contiguous ack frontier. */
  private entries: { end: number; done: boolean }[] = [];
  private front = 0;
  private outstanding = 0;
  /** The single _write callback Node is waiting on while the window is full. */
  private deferred: ((error?: Error | null) => void) | null = null;
  private finalCallback: ((error?: Error | null) => void) | null = null;
  private failure: Error | null = null;

  constructor(
    private sftp: SFTPWrapper,
    handle: Buffer,
    start: number,
  ) {
    super();
    this.handle = handle;
    this.pos = start;
    this.acked = start;
  }

  confirmedBytes(): number {
    return this.acked;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.failure) {
      callback(this.failure);
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const entry = { end: this.pos + buffer.length, done: false };
    const offset = this.pos;
    this.pos = entry.end;
    this.entries.push(entry);
    this.outstanding++;
    this.sftp.write(this.handle!, buffer, 0, buffer.length, offset, (err) => {
      this.outstanding--;
      if (this.destroyed) return;
      if (err) {
        this.failure = err as Error;
        entry.done = true; // stop the frontier from stalling on a failed write
        callback(err);
        this.destroy(err as Error);
        return;
      }
      entry.done = true;
      this.advanceAcked();
      this.releaseSlot();
    });
    if (this.outstanding < WINDOW) callback();
    else this.deferred = callback;
  }

  /** Advance the confirmed frontier over every consecutive completed write. */
  private advanceAcked(): void {
    while (this.front < this.entries.length && this.entries[this.front].done) {
      this.acked = this.entries[this.front].end;
      this.front++;
    }
    if (this.front > 64) {
      this.entries.splice(0, this.front);
      this.front = 0;
    }
  }

  private releaseSlot(): void {
    if (this.deferred && this.outstanding < WINDOW) {
      const callback = this.deferred;
      this.deferred = null;
      callback();
    }
    if (this.finalCallback && this.outstanding === 0) this.finish();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.failure) {
      callback(this.failure);
      return;
    }
    if (this.outstanding === 0) {
      this.finish(callback);
      return;
    }
    this.finalCallback = callback;
  }

  /** All writes are acknowledged; CLOSE decides success (quota errors land here). */
  private finish(callback = this.finalCallback ?? undefined): void {
    this.finalCallback = null;
    const handle = this.handle;
    this.handle = null;
    if (!handle || !callback) {
      callback?.();
      return;
    }
    this.sftp.close(handle, (err) => {
      if (!err) this.committed = true;
      callback(err as Error | undefined);
    });
  }

  _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    const handle = this.handle;
    this.handle = null;
    if (handle) this.sftp.close(handle, () => {});
    callback(err);
  }
}
