import { DEFAULT_PREFERENCES, MAX_CONCURRENCY, MIN_CONCURRENCY, type Preferences } from "../../shared/preferences";
import { getDb } from "../db";

/**
 * Values are stored as JSON so booleans and numbers round-trip through the
 * TEXT column. Anything unreadable falls back to the default for that key.
 */
function coerce(stored: Record<string, unknown>): Preferences {
  const { showHidden, appearance, defaultConcurrency } = stored;
  return {
    showHidden: typeof showHidden === "boolean" ? showHidden : DEFAULT_PREFERENCES.showHidden,
    appearance:
      appearance === "system" || appearance === "light" || appearance === "dark" ? appearance : DEFAULT_PREFERENCES.appearance,
    defaultConcurrency:
      typeof defaultConcurrency === "number" && Number.isFinite(defaultConcurrency)
        ? Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(defaultConcurrency)))
        : DEFAULT_PREFERENCES.defaultConcurrency,
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
