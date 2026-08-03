/**
 * Secret storage (§3.5): Electron safeStorage (Keychain-backed on macOS).
 * Encrypted blobs live as files under userData/secrets — never in SQLite.
 */
import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

function secretsDir(): string {
  const dir = join(app.getPath("userData"), "secrets");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pathFor(favoriteId: string): string {
  // favoriteId is a UUID we generate, safe as a filename.
  return join(secretsDir(), `${favoriteId}.bin`);
}

export function storeSecret(favoriteId: string, secret: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Keychain encryption is unavailable; secret was not saved");
  }
  writeFileSync(pathFor(favoriteId), safeStorage.encryptString(secret), { mode: 0o600 });
}

export function readSecret(favoriteId: string): string | null {
  try {
    const blob = readFileSync(pathFor(favoriteId));
    return safeStorage.decryptString(blob);
  } catch {
    return null;
  }
}

export function deleteSecret(favoriteId: string): void {
  rmSync(pathFor(favoriteId), { force: true });
}
