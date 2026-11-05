import {
  DEFAULT_PREFERENCES,
  MAX_CONCURRENCY,
  MAX_EDITOR_POLL_INTERVAL_MS,
  MAX_EDITOR_SAVE_DEBOUNCE_MS,
  MAX_EDITOR_UPLOAD_TIMEOUT_MS,
  MAX_KEEPALIVE_SECONDS,
  MAX_PREVIEW_MAX_BYTES,
  MAX_SPEED_STATS_WINDOW_SECONDS,
  MAX_TRANSFER_RETRIES,
  MAX_TRANSFER_TIMEOUT_SECONDS,
  MIN_CONCURRENCY,
  MIN_EDITOR_POLL_INTERVAL_MS,
  MIN_EDITOR_SAVE_DEBOUNCE_MS,
  MIN_EDITOR_UPLOAD_TIMEOUT_MS,
  MIN_KEEPALIVE_SECONDS,
  MIN_PREVIEW_MAX_BYTES,
  MIN_SPEED_STATS_WINDOW_SECONDS,
  MIN_TRANSFER_RETRIES,
  MIN_TRANSFER_TIMEOUT_SECONDS,
} from "@shared/prefs/prefs.constants";
import type { Preferences } from "@shared/prefs/prefs.types";
import { getDb } from "./database";

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/**
 * Values are stored as JSON so booleans and numbers round-trip through the
 * TEXT column. Anything unreadable falls back to the default for that key.
 */
function coerce(stored: Record<string, unknown>): Preferences {
  const {
    showHidden,
    appearance,
    defaultConcurrency,
    calculateFolderSizes,
    calculateRemoteFolderSizes,
    defaultSortKey,
    defaultSortDir,
    foldersFirst,
    rowDensity,
    previewMaxBytes,
    defaultKeepaliveSeconds,
    autoReconnect,
    transferTimeoutSeconds,
    transferMaxRetries,
    speedStatsWindowSeconds,
    editorSaveDebounceMs,
    editorPollIntervalMs,
    editorUploadTimeoutMs,
    automaticallyCheckForUpdates,
    receivePrereleaseUpdates,
  } = stored;
  return {
    showHidden: bool(showHidden, DEFAULT_PREFERENCES.showHidden),
    appearance:
      appearance === "system" || appearance === "light" || appearance === "dark" ? appearance : DEFAULT_PREFERENCES.appearance,
    defaultConcurrency: bounded(defaultConcurrency, DEFAULT_PREFERENCES.defaultConcurrency, MIN_CONCURRENCY, MAX_CONCURRENCY),
    calculateFolderSizes: bool(calculateFolderSizes, DEFAULT_PREFERENCES.calculateFolderSizes),
    calculateRemoteFolderSizes: bool(calculateRemoteFolderSizes, DEFAULT_PREFERENCES.calculateRemoteFolderSizes),
    defaultSortKey:
      defaultSortKey === "size" || defaultSortKey === "mtime" ? defaultSortKey : DEFAULT_PREFERENCES.defaultSortKey,
    defaultSortDir: defaultSortDir === "desc" ? "desc" : DEFAULT_PREFERENCES.defaultSortDir,
    foldersFirst: bool(foldersFirst, DEFAULT_PREFERENCES.foldersFirst),
    rowDensity: rowDensity === "comfortable" ? "comfortable" : DEFAULT_PREFERENCES.rowDensity,
    previewMaxBytes: bounded(
      previewMaxBytes,
      DEFAULT_PREFERENCES.previewMaxBytes,
      MIN_PREVIEW_MAX_BYTES,
      MAX_PREVIEW_MAX_BYTES,
    ),
    defaultKeepaliveSeconds: bounded(
      defaultKeepaliveSeconds,
      DEFAULT_PREFERENCES.defaultKeepaliveSeconds,
      MIN_KEEPALIVE_SECONDS,
      MAX_KEEPALIVE_SECONDS,
    ),
    autoReconnect: bool(autoReconnect, DEFAULT_PREFERENCES.autoReconnect),
    transferTimeoutSeconds: bounded(
      transferTimeoutSeconds,
      DEFAULT_PREFERENCES.transferTimeoutSeconds,
      MIN_TRANSFER_TIMEOUT_SECONDS,
      MAX_TRANSFER_TIMEOUT_SECONDS,
    ),
    transferMaxRetries: bounded(
      transferMaxRetries,
      DEFAULT_PREFERENCES.transferMaxRetries,
      MIN_TRANSFER_RETRIES,
      MAX_TRANSFER_RETRIES,
    ),
    speedStatsWindowSeconds: bounded(
      speedStatsWindowSeconds,
      DEFAULT_PREFERENCES.speedStatsWindowSeconds,
      MIN_SPEED_STATS_WINDOW_SECONDS,
      MAX_SPEED_STATS_WINDOW_SECONDS,
    ),
    editorSaveDebounceMs: bounded(
      editorSaveDebounceMs,
      DEFAULT_PREFERENCES.editorSaveDebounceMs,
      MIN_EDITOR_SAVE_DEBOUNCE_MS,
      MAX_EDITOR_SAVE_DEBOUNCE_MS,
    ),
    editorPollIntervalMs: bounded(
      editorPollIntervalMs,
      DEFAULT_PREFERENCES.editorPollIntervalMs,
      MIN_EDITOR_POLL_INTERVAL_MS,
      MAX_EDITOR_POLL_INTERVAL_MS,
    ),
    editorUploadTimeoutMs: bounded(
      editorUploadTimeoutMs,
      DEFAULT_PREFERENCES.editorUploadTimeoutMs,
      MIN_EDITOR_UPLOAD_TIMEOUT_MS,
      MAX_EDITOR_UPLOAD_TIMEOUT_MS,
    ),
    automaticallyCheckForUpdates: bool(automaticallyCheckForUpdates, DEFAULT_PREFERENCES.automaticallyCheckForUpdates),
    receivePrereleaseUpdates: bool(receivePrereleaseUpdates, DEFAULT_PREFERENCES.receivePrereleaseUpdates),
  };
}

export function getPreferences(): Preferences {
  const rows = getDb().prepare("SELECT key, value FROM preferences").all() as {
    key: string;
    value: string | null;
  }[];
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.value === null) continue;
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // Drop the corrupt row rather than losing every other preference.
    }
  }
  return coerce(stored);
}

/** Merges a patch over the current values; returns the full new set. */
export function setPreferences(patch: Partial<Preferences>): Preferences {
  const next = coerce({ ...getPreferences(), ...patch });
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO preferences (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const tx = db.transaction((prefs: Preferences) => {
    for (const [key, value] of Object.entries(prefs)) upsert.run(key, JSON.stringify(value));
  });
  tx(next);
  return next;
}

/**
 * Raw access for keys outside the typed `Preferences` set — the update
 * checker's last-check bookkeeping (`updates.lastCheck`).
 *
 * These store the string verbatim, where the typed accessors above store JSON.
 * The two happen to coincide for booleans and numbers, but not for strings, so
 * a key belongs to one accessor or the other and never both.
 */
export function setPreferenceRow(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO preferences (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}
