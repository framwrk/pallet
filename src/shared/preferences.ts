/** App-wide preferences, persisted in the SQLite `preferences` table. */

export type Appearance = "system" | "light" | "dark";

export interface Preferences {
  /** Show dotfiles in both panes (also toggled with ⇧⌘.). */
  showHidden: boolean;
  appearance: Appearance;
  /** Seeds the connect dialog's parallel transfer channels field. */
  defaultConcurrency: number;
  /**
   * Walk folders to total their contents instead of showing "--". Local panes
   * only; a local walk is cheap enough to be the safe default for the switch.
   */
  calculateFolderSizes: boolean;
  /**
   * Extend folder sizing to remote panes. Gated behind its own switch because
   * sizing a remote tree is the most expensive thing the app asks of a server,
   * and it is inert while calculateFolderSizes is off.
   */
  calculateRemoteFolderSizes: boolean;
}

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
