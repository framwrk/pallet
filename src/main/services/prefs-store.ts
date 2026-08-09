import { DEFAULT_PREFERENCES, MAX_CONCURRENCY, MIN_CONCURRENCY } from "@shared/prefs/prefs.constants";
import type { Preferences } from "@shared/prefs/prefs.types";
import { getDb } from "./database";

/**
 * Values are stored as JSON so booleans and numbers round-trip through the
 * TEXT column. Anything unreadable falls back to the default for that key.
 */
function coerce(stored: Record<string, unknown>): Preferences {
  const { showHidden, appearance, defaultConcurrency, calculateFolderSizes, calculateRemoteFolderSizes } = stored;
  return {
    showHidden: typeof showHidden === "boolean" ? showHidden : DEFAULT_PREFERENCES.showHidden,
    appearance:
      appearance === "system" || appearance === "light" || appearance === "dark" ? appearance : DEFAULT_PREFERENCES.appearance,
    defaultConcurrency:
      typeof defaultConcurrency === "number" && Number.isFinite(defaultConcurrency)
        ? Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(defaultConcurrency)))
        : DEFAULT_PREFERENCES.defaultConcurrency,
    calculateFolderSizes:
      typeof calculateFolderSizes === "boolean" ? calculateFolderSizes : DEFAULT_PREFERENCES.calculateFolderSizes,
    calculateRemoteFolderSizes:
      typeof calculateRemoteFolderSizes === "boolean"
        ? calculateRemoteFolderSizes
        : DEFAULT_PREFERENCES.calculateRemoteFolderSizes,
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
 * checker's bookkeeping (`updates.prerelease`, `updates.lastCheck`).
 *
 * These store the string verbatim, where the typed accessors above store JSON.
 * The two happen to coincide for booleans and numbers, but not for strings, so
 * a key belongs to one accessor or the other and never both.
 */
export function getPreferenceRow(key: string, fallback: string): string {
  const row = getDb().prepare("SELECT value FROM preferences WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setPreferenceRow(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO preferences (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}
