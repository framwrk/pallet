/** App-wide preferences, persisted in the SQLite `preferences` table. */

export type Appearance = "system" | "light" | "dark";

export interface Preferences {
  /** Show dotfiles in both panes (also toggled with ⇧⌘.). */
  showHidden: boolean;
  appearance: Appearance;
  /** Seeds the connect dialog's parallel transfer channels field. */
  defaultConcurrency: number;
}

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 7;

export const DEFAULT_PREFERENCES: Preferences = {
  showHidden: false,
  appearance: "system",
  defaultConcurrency: 4,
};
