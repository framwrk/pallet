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
