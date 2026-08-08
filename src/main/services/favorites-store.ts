import type { ColorLabel, Favorite, FavoriteInput } from "../../shared/types";
import { deleteSecret, storeSecret } from "./secrets";
import { getDb } from "../db";
import { randomUUID } from "crypto";

interface Row {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: string;
  secret_stored: number;
  private_key_path: string | null;
  remote_path: string | null;
  local_path: string | null;
  note: string | null;
  color_label: string | null;
  sort_order: number;
  created_at: number;
  last_used_at: number | null;
}

function fromRow(row: Row): Favorite {
  return {
    id: row.id,
    name: row.name,
    protocol: "sftp",
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod: row.auth_method === "key" ? "key" : "password",
    secretStored: row.secret_stored === 1,
    ...(row.private_key_path ? { privateKeyPath: row.private_key_path } : {}),
    ...(row.remote_path ? { remotePath: row.remote_path } : {}),
    ...(row.local_path ? { localPath: row.local_path } : {}),
    ...(row.note ? { note: row.note } : {}),
    colorLabel: (row.color_label as ColorLabel) ?? "none",
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
  };
}

/**
 * Manual order (sort_order) wins; until the user ever reorders, everything
 * has sort_order 0 and recency decides (M4 "last-used ordering").
 */
export function listFavorites(): Favorite[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM favorites
       ORDER BY sort_order ASC, COALESCE(last_used_at, created_at) DESC`,
    )
    .all() as Row[];
  return rows.map(fromRow);
}

export function getFavorite(id: string): Favorite | null {
  const row = getDb().prepare("SELECT * FROM favorites WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/**
 * Create or update. `secret` semantics: undefined = keep existing,
 * null = clear, string = replace.
 */
export function saveFavorite(input: FavoriteInput, secret?: string | null): Favorite {
  const db = getDb();
  const existing = input.id ? getFavorite(input.id) : null;
  const id = existing?.id ?? randomUUID();

  let secretStored = existing?.secretStored ?? false;
  if (secret === null) {
    deleteSecret(id);
    secretStored = false;
  } else if (typeof secret === "string" && secret.length > 0) {
    storeSecret(id, secret);
    secretStored = true;
  }

  if (existing) {
    db.prepare(
      `UPDATE favorites SET name=?, host=?, port=?, username=?, auth_method=?,
         secret_stored=?, private_key_path=?, remote_path=?, local_path=?,
         note=?, color_label=? WHERE id=?`,
    ).run(
      input.name,
      input.host,
      input.port,
      input.username,
      input.authMethod,
      secretStored ? 1 : 0,
      input.privateKeyPath ?? null,
      input.remotePath ?? null,
      input.localPath ?? null,
      input.note ?? null,
      input.colorLabel,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO favorites
         (id, name, protocol, host, port, username, auth_method, secret_stored,
          private_key_path, remote_path, local_path, note, color_label,
          sort_order, created_at)
       VALUES (?, ?, 'sftp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id,
      input.name,
      input.host,
      input.port,
      input.username,
      input.authMethod,
      secretStored ? 1 : 0,
      input.privateKeyPath ?? null,
      input.remotePath ?? null,
      input.localPath ?? null,
      input.note ?? null,
      input.colorLabel,
      Date.now(),
    );
  }
  const saved = getFavorite(id);
  if (!saved) throw new Error("Favorite vanished during save");
  return saved;
}

export function removeFavorite(id: string): void {
  deleteSecret(id);
  getDb().prepare("DELETE FROM favorites WHERE id = ?").run(id);
}

export function reorderFavorites(ids: string[]): void {
  const db = getDb();
  const update = db.prepare("UPDATE favorites SET sort_order = ? WHERE id = ?");
  const tx = db.transaction((ordered: string[]) => {
    ordered.forEach((id, index) => update.run(index + 1, id));
  });
  tx(ids);
}

export function touchLastUsed(id: string): void {
  getDb().prepare("UPDATE favorites SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}
