/** Defaults and bounds for the persisted preferences. */
import type { Preferences } from "./prefs.types";

export const DEFAULT_CONCURRENCY = 3;

/**
 * OpenSSH's default MaxSessions is 10. Browsing holds one channel and the
 * SFTP endpoint holds one for metadata, so capping streams at 7 keeps the
 * worst case at 9 and leaves headroom.
 */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 7;

export const DEFAULT_PREFERENCES: Preferences = {
  showHidden: false,
  appearance: "system",
  defaultConcurrency: 4,
  calculateFolderSizes: false,
  calculateRemoteFolderSizes: false,
};
