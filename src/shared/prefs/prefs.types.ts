/** App-wide preferences, persisted in the SQLite `preferences` table. */
import type { SortDir, SortKey } from "../fs/fs.types";

export type Appearance = "system" | "light" | "dark";

/** File-list row spacing; "comfortable" trades density for breathing room. */
export type RowDensity = "compact" | "comfortable";

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

  /** Sort applied to new listings and new windows. */
  defaultSortKey: SortKey;
  defaultSortDir: SortDir;
  /** Keep folders above files regardless of the sort key. */
  foldersFirst: boolean;
  rowDensity: RowDensity;
  /**
   * Largest file the inspector will preview inline. Bigger files still show
   * their metadata; only the text/image body is skipped.
   */
  previewMaxBytes: number;

  /** Seeds the connect dialog's keepalive field; 0 disables keepalive. */
  defaultKeepaliveSeconds: number;
  /** Reconnect dropped sessions with backoff instead of disconnecting. */
  autoReconnect: boolean;

  /** Abort a file transfer after this long without progress. */
  transferTimeoutSeconds: number;
  /** Reread source and staged destination with SHA-256 before replacement. */
  verifyCopiedFiles: boolean;
  /** Per-file retries after a dead channel before the file is reported failed. */
  transferMaxRetries: number;
  /** Trailing window for the drawer's recent average and median speed. */
  speedStatsWindowSeconds: number;

  /** Wait for the external editor to settle before uploading. */
  editorSaveDebounceMs: number;
  /** How often the external editor's local copy is polled for changes. */
  editorPollIntervalMs: number;
  /** Abort a stalled re-upload from the external editor. */
  editorUploadTimeoutMs: number;

  /** Check GitHub Releases on launch and daily. */
  automaticallyCheckForUpdates: boolean;
  /** Include GitHub releases flagged as prereleases. */
  receivePrereleaseUpdates: boolean;
}
