/** Defaults and bounds for the persisted preferences. */
import type { Preferences, RowDensity } from "./prefs.types";

export const DEFAULT_CONCURRENCY = 3;

/**
 * OpenSSH's default MaxSessions is 10. Browsing holds one channel and the
 * transfer pool reserves one for metadata, so capping streams at 7 keeps the
 * worst case at 9 and leaves headroom.
 */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 7;

export const MIN_KEEPALIVE_SECONDS = 0;
export const MAX_KEEPALIVE_SECONDS = 300;

export const MIN_TRANSFER_TIMEOUT_SECONDS = 10;
export const MAX_TRANSFER_TIMEOUT_SECONDS = 600;

export const MIN_TRANSFER_RETRIES = 0;
export const MAX_TRANSFER_RETRIES = 20;

export const MIN_SPEED_STATS_WINDOW_SECONDS = 5;
export const MAX_SPEED_STATS_WINDOW_SECONDS = 120;
export const SPEED_STATS_WINDOW_OPTIONS = [10, 30, 60, 120] as const;

export const MIN_EDITOR_SAVE_DEBOUNCE_MS = 0;
export const MAX_EDITOR_SAVE_DEBOUNCE_MS = 10_000;

export const MIN_EDITOR_POLL_INTERVAL_MS = 100;
export const MAX_EDITOR_POLL_INTERVAL_MS = 10_000;

export const MIN_EDITOR_UPLOAD_TIMEOUT_MS = 10_000;
export const MAX_EDITOR_UPLOAD_TIMEOUT_MS = 300_000;

export const MIN_PREVIEW_MAX_BYTES = 64 * 1024;
export const MAX_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;
export const PREVIEW_SIZE_OPTIONS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024] as const;

/** File-list row heights per density, in pixels. */
export const ROW_HEIGHTS: Record<RowDensity, number> = {
  compact: 26,
  comfortable: 32,
};

export const DEFAULT_PREFERENCES: Preferences = {
  showHidden: false,
  appearance: "system",
  defaultConcurrency: 4,
  calculateFolderSizes: false,
  calculateRemoteFolderSizes: false,
  defaultSortKey: "name",
  defaultSortDir: "asc",
  foldersFirst: true,
  rowDensity: "compact",
  previewMaxBytes: 1024 * 1024,
  defaultKeepaliveSeconds: 15,
  autoReconnect: true,
  transferTimeoutSeconds: 60,
  transferMaxRetries: 5,
  speedStatsWindowSeconds: 30,
  editorSaveDebounceMs: 800,
  editorPollIntervalMs: 1000,
  editorUploadTimeoutMs: 60_000,
  automaticallyCheckForUpdates: true,
  receivePrereleaseUpdates: true,
};
