/**
 * Pure helpers for the in-app update download. Kept free of Electron imports so
 * the security-critical pieces (version, destination, asset URL, checksum) can
 * be unit-tested without a running app.
 */
import { basename, dirname, join, resolve } from "node:path";
import { parseVersion } from "@shared/version/version.utils";

/** Ceiling for a release disk image; a bigger response is treated as hostile. */
export const MAX_UPDATE_BYTES = 300 * 1024 * 1024;

/** How long the download may go without receiving a byte before it is aborted. */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 60_000;

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const GITHUB_ASSET_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * Accept only a MAJOR.MINOR.PATCH version and return its canonical form. The
 * raw renderer string is never used to build a path or a URL.
 */
export function canonicalUpdateVersion(input: unknown): string {
  const parsed = typeof input === "string" ? parseVersion(input) : null;
  if (!parsed) throw new Error("This update has an invalid version");
  const { major, minor, patch } = parsed;
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error("This update has an invalid version");
  }
  return `${major}.${minor}.${patch}`;
}

export function updateAssetName(version: string): string {
  return `pallet-${version}.dmg`;
}

/**
 * Destination for `version` inside the Downloads directory. The canonical
 * version has no path separators, and the final path is re-checked, so a
 * renderer-supplied version can never escape the directory.
 */
export function updateDownloadPath(downloadsDir: string, version: string): string {
  const dir = resolve(downloadsDir);
  const name = updateAssetName(canonicalUpdateVersion(version));
  const dest = join(dir, name);
  if (dirname(dest) !== dir || basename(dest) !== name) {
    throw new Error("This update has an invalid destination");
  }
  return dest;
}

/** Normalize a GitHub asset `digest` (`sha256:<hex>`) or a bare hex digest. */
export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digest = value
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
  return SHA256_HEX.test(digest) ? digest : null;
}

/** Find the SHA-256 for `filename` in a `shasum -a 256` style checksums file. */
export function parseChecksums(text: string, filename: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2].trim() === filename) return match[1].toLowerCase();
  }
  return null;
}

/** Only the release asset's own GitHub HTTPS URL may be downloaded. */
export function validateAssetUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("This release has an invalid download URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("This release has an invalid download URL");
  }
  if (url.protocol !== "https:" || !GITHUB_ASSET_HOSTS.has(url.hostname)) {
    throw new Error("This release has an untrusted download URL");
  }
  return url.toString();
}
