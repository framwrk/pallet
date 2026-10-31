/**
 * In-app update download: streams the release DMG into ~/Downloads and mounts
 * it, so "update" is one click instead of a browser round-trip. Pallet cannot
 * install over itself — that needs code signing — so the finish line is the
 * drag-to-Applications window LaunchServices opens, not a relaunch. Pallet
 * quits once that window is open, so it never holds the old copy in place.
 *
 * The renderer is not trusted: it supplies a version only, and main derives the
 * release, the destination, and the expected SHA-256 itself.
 */
import {
  MAX_UPDATE_BYTES,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  canonicalUpdateVersion,
  updateDownloadPath,
} from "./update-download.utils";
import { Readable, Transform } from "node:stream";
import type { UpdateDownloadState, UpdateInfo } from "@shared/update/update.types";
import { type UpdateRelease, resolveUpdateRelease } from "./update-release";
import { access, rename, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { AppChannels } from "@shared/ipc/ipc.constants";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { broadcast } from "../utils/broadcast";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";
import { pipeline } from "node:stream/promises";
import { quitAfterTransfers } from "./quit";
import { shell } from "electron";

const BROADCAST_INTERVAL_MS = 100;

/** Grace period before quitting, so Finder can paint the drag-to-Applications window. */
const QUIT_DELAY_MS = 250;

/** How long to wait for the disk image to open before treating it as failed. */
const OPEN_TIMEOUT_MS = 10_000;

let active: Promise<string> | null = null;

function emit(state: UpdateDownloadState): void {
  broadcast(AppChannels.updateDownloadState, state);
}

/**
 * Download the DMG for `info.version` and mount it; resolves with the final
 * path. Concurrent calls coalesce onto the single in-flight download.
 */
export function downloadUpdate(info: UpdateInfo): Promise<string> {
  if (active) return active;
  active = run(info).finally(() => {
    active = null;
  });
  return active;
}

/**
 * Mount the disk image in Finder and quit Pallet, but only once the open
 * request succeeds. `shell.openPath` resolves with an error string instead of
 * rejecting, so an empty string is the only success. A request that fails,
 * rejects, or never settles leaves Pallet running: quitting there would strand
 * the user without a window to retry from, so the failure is surfaced instead.
 */
async function openDiskImage(dest: string): Promise<void> {
  const opening = shell.openPath(dest).then(
    (failure) => ({ failure }),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), OPEN_TIMEOUT_MS);
  });

  let result: { failure: string } | { error: string } | "timeout";
  try {
    result = await Promise.race([opening, timedOut]);
  } finally {
    clearTimeout(timer);
  }

  if (result === "timeout") {
    throw new Error("The disk image took too long to open — Pallet is still running.");
  }
  if ("error" in result) throw new Error(`Could not open the disk image: ${result.error}`);
  if (result.failure) throw new Error(`Could not open the disk image: ${result.failure}`);

  // The guarded quit cancels active transfers and waits for their staging cleanup.
  setTimeout(() => void quitAfterTransfers(), QUIT_DELAY_MS);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Stream the release DMG into `part`, refusing oversized or stalled responses,
 * and verify its SHA-256 before the caller renames it into place. A mismatch
 * leaves the part file for the caller to delete and never touches an existing
 * DMG.
 */
async function downloadVerified(
  release: UpdateRelease,
  part: string,
  version: string,
): Promise<{ received: number; total: number }> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const armTimeout = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, UPDATE_DOWNLOAD_TIMEOUT_MS);
  };

  try {
    armTimeout();
    const res = await fetch(release.dmgUrl, {
      headers: { "User-Agent": "pallet-update-download" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

    const declared = Number(res.headers.get("content-length") ?? 0);
    const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (total > MAX_UPDATE_BYTES) throw new Error("The update download is larger than expected");

    let received = 0;
    let lastEmit = 0;

    // Counting transform throttled like the transfer ticker: progress events
    // only while bytes actually flow, capped at 10/s so the renderer isn't flooded.
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > MAX_UPDATE_BYTES) {
          cb(new Error("The update download is larger than expected"));
          return;
        }
        armTimeout();
        const now = Date.now();
        if (now - lastEmit >= BROADCAST_INTERVAL_MS) {
          lastEmit = now;
          emit({ status: "downloading", version, receivedBytes: received, totalBytes: total });
        }
        cb(null, chunk);
      },
    });

    const source = Readable.fromWeb(res.body as NodeWebReadableStream);
    await pipeline(source, counter, createWriteStream(part), { signal: controller.signal });
    if (total > 0 && received !== total) throw new Error("The update download was incomplete");
    if ((await sha256File(part)) !== release.checksum) {
      throw new Error("The downloaded update failed its checksum and was discarded");
    }
    return { received, total };
  } catch (err) {
    if (timedOut) throw new Error("The update download timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function run(info: UpdateInfo): Promise<string> {
  let version = "";
  let part: string | null = null;

  try {
    version = canonicalUpdateVersion(info?.version);
    const dest = updateDownloadPath(join(homedir(), "Downloads"), version);
    part = `${dest}.part`;

    const release = await resolveUpdateRelease(version);

    if (await exists(dest)) {
      if ((await sha256File(dest)) === release.checksum) {
        // Already on disk and verified: skip straight to mounting.
        emit({ status: "done", version, receivedBytes: 0, totalBytes: 0, path: dest });
        await openDiskImage(dest);
        return dest;
      }
      log("update download", "existing disk image failed verification; downloading again");
    }

    emit({ status: "downloading", version, receivedBytes: 0, totalBytes: 0 });
    const { received, total } = await downloadVerified(release, part, version);
    await rename(part, dest);
    emit({ status: "done", version, receivedBytes: received, totalBytes: total, path: dest });
    await openDiskImage(dest);
    return dest;
  } catch (err) {
    if (part) await rm(part, { force: true }).catch(() => {});
    emit({
      status: "error",
      version,
      receivedBytes: 0,
      totalBytes: 0,
      error: (err as Error).message,
    });
    log("update failed", (err as Error).message);
    throw err;
  }
}
