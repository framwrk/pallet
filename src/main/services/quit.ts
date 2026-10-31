/**
 * Quit coordination for the main process. Streams abort when the process
 * exits, so an active transfer's `finally` staging cleanup never runs and its
 * `.pallet-part` files are left on the destination. Every quit path cancels
 * transfers and waits (bounded) for that cleanup before Electron quits.
 */
import { app } from "electron";
import { log } from "./logger";

type QuitCleanup = () => Promise<{ timedOut: boolean; remaining: number }>;

let cleanup: QuitCleanup | null = null;
let pending: Promise<void> | null = null;

/** Wired once at startup, after the transfer queue and sessions exist. */
export function setQuitCleanup(fn: QuitCleanup): void {
  cleanup = fn;
}

/**
 * Cancel active work, wait for its cleanup, then quit. The update auto-quit
 * calls this directly; `before-quit` calls it once the quit is held. Concurrent
 * callers share one cleanup pass.
 */
export function quitAfterTransfers(): Promise<void> {
  pending ??= run().finally(() => {
    pending = null;
  });
  return pending;
}

async function run(): Promise<void> {
  if (cleanup) {
    try {
      const { timedOut, remaining } = await cleanup();
      if (timedOut) log("quit", `${remaining} transfer(s) still cleaning up after the timeout`);
    } catch (err) {
      log("quit", `transfer cleanup failed: ${(err as Error).message}`);
    }
  }
  app.quit();
}
