/**
 * In-app update download: streams the release DMG into ~/Downloads and mounts
 * it, so "update" is one click instead of a browser round-trip. Pallet cannot
 * install over itself — that needs code signing — so the finish line is the
 * drag-to-Applications window LaunchServices opens, not a relaunch. Pallet
 * quits once that window is open, so it never holds the old copy in place.
 */
import type { UpdateDownloadState, UpdateInfo } from "@shared/update/update.types";
import { access, rename, rm } from "node:fs/promises";
import { app, shell } from "electron";
import { AppChannels } from "@shared/ipc/ipc.constants";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";
import { Transform } from "node:stream";
import { broadcast } from "../utils/broadcast";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger";
import { pipeline } from "node:stream/promises";

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
 * Download the DMG for `info` and mount it; resolves with the final path.
 * Concurrent calls coalesce onto the single in-flight download.
 */
export function downloadUpdate(info: UpdateInfo): Promise<string> {
  if (!info.dmgUrl) throw new Error("This release has no disk image to download");
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

  setTimeout(() => app.quit(), QUIT_DELAY_MS);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function run(info: UpdateInfo): Promise<string> {
  const version = info.version;
  const dest = join(homedir(), "Downloads", `pallet-${version}.dmg`);
  const part = `${dest}.part`;

  try {
    if (await exists(dest)) {
      // Already on disk (previous attempt or re-download): skip straight to mounting.
      emit({ status: "done", version, receivedBytes: 0, totalBytes: 0, path: dest });
      await openDiskImage(dest);
      return dest;
    }

    emit({ status: "downloading", version, receivedBytes: 0, totalBytes: 0 });
    const res = await fetch(info.dmgUrl as string, {
      headers: { "User-Agent": "pallet-update-download" },
    });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") ?? 0);
    let received = 0;
    let lastEmit = 0;

    // Counting transform throttled like the transfer ticker: progress events
    // only while bytes actually flow, capped at 10/s so the renderer isn't flooded.
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        const now = Date.now();
        if (now - lastEmit >= BROADCAST_INTERVAL_MS) {
          lastEmit = now;
          emit({ status: "downloading", version, receivedBytes: received, totalBytes: total });
        }
        cb(null, chunk);
      },
    });

    const source = Readable.fromWeb(res.body as NodeWebReadableStream);
    await pipeline(source, counter, createWriteStream(part));
    await rename(part, dest);
    emit({ status: "done", version, receivedBytes: received, totalBytes: total, path: dest });
    await openDiskImage(dest);
    return dest;
  } catch (err) {
    await rm(part, { force: true }).catch(() => {});
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
