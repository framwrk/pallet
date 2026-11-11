import { type Readable, Writable } from "stream";
import type { TransferEndpoint } from "./transfer-endpoint";
import { createHash } from "crypto";
import { pipeline } from "stream/promises";

export class TransferIntegrityError extends Error {
  readonly code = "EINTEGRITY";
}

/** Full-file digest, bounded by stream backpressure. Waits for CLOSE before returning a lease. */
export async function digestEndpoint(
  endpoint: TransferEndpoint,
  path: string,
  expectedBytes: number,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  signal.throwIfAborted();
  const hash = createHash("sha256");
  let bytes = 0;
  let stream: Readable | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => (rejectAbort = reject));
  const abort = (): void => {
    stream?.destroy();
    rejectAbort(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    stream = await Promise.race([
      endpoint.createReadStream(path, { signal }).then((read) => {
        read.on("error", () => {});
        if (signal.aborted) read.destroy();
        return read;
      }),
      aborted,
    ]);
    signal.throwIfAborted();
    await Promise.race([
      pipeline(
        stream,
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > expectedBytes) {
              callback(new TransferIntegrityError(`SHA-256 verification read too many bytes: ${path}`));
              return;
            }
            hash.update(chunk);
            onProgress(chunk.length);
            callback();
          },
        }),
        { signal },
      ),
      aborted,
    ]);
    signal.throwIfAborted();
    if (bytes !== expectedBytes) throw new TransferIntegrityError(`SHA-256 verification read ended early: ${path}`);
    return hash.digest("hex");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || Number(code) === 3 || Number(code) === 550)
      throw new TransferIntegrityError(`SHA-256 verification requires read permission for ${path}. ${(err as Error).message}`);
    throw err;
  } finally {
    signal.removeEventListener("abort", abort);
    stream?.destroy();
  }
}
