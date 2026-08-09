/**
 * Saved connection shapes shared across main, preload, and renderer.
 *
 * This file must stay dependency-free: no Node imports, no Electron imports.
 */

export type ColorLabel = "none" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";

export interface Favorite {
  id: string;
  name: string;
  protocol: "sftp";
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  /** True when an encrypted secret exists for this favorite (never the secret itself). */
  secretStored: boolean;
  privateKeyPath?: string;
  remotePath?: string;
  localPath?: string;
  note?: string;
  colorLabel: ColorLabel;
  sortOrder: number;
  createdAt: number;
  lastUsedAt?: number;
}

/** Renderer → main favorite payload; id absent means create. */
export interface FavoriteInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key";
  privateKeyPath?: string;
  remotePath?: string;
  localPath?: string;
  note?: string;
  colorLabel: ColorLabel;
}
