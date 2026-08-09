/**
 * Rotating file log in ~/Library/Logs/Pallet (§7). Nothing in the app logs a
 * secret deliberately, and every line is passed through `redact()` before it
 * hits disk in case an error message or stack carries one incidentally.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { app } from "electron";
import { join } from "path";
import { redact } from "@shared/redact/redact.utils";

const MAX_BYTES = 5 * 1024 * 1024;

let logDir: string | null = null;

export function logFilePath(): string {
  if (!logDir) {
    logDir = join(app.getPath("logs"));
    mkdirSync(logDir, { recursive: true });
  }
  return join(logDir, "pallet.log");
}

function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size > MAX_BYTES) {
      renameSync(file, file + ".1");
    }
  } catch {
    // First write; nothing to rotate.
  }
}

export function log(...parts: unknown[]): void {
  try {
    const file = logFilePath();
    rotateIfNeeded(file);
    const message = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    appendFileSync(file, `${new Date().toISOString()} ${redact(message)}\n`);
  } catch {
    // Logging must never take the app down.
  }
}

/** §7 DoD: surface unhandled rejections instead of losing them. */
export function installCrashHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    log("UNHANDLED-REJECTION", reason instanceof Error ? reason.stack : String(reason));
  });
  process.on("uncaughtException", (err) => {
    log("UNCAUGHT-EXCEPTION", err.stack ?? String(err));
  });
}
