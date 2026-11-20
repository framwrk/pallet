import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "bun:test";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "pallet-secrets-"));
const userData = join(root, "userData");
mkdirSync(userData);

mock.module("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (blob: Buffer) => blob.toString(),
  },
}));

const { deleteSecret, readSecret, storeSecret } = await import("../src/main/services/secrets");

try {
  const outside = [join(userData, "victim.bin"), join(root, "victim.bin")];
  for (const id of ["../victim", "../../victim", "a/b", "", "not-a-uuid"]) {
    for (const file of outside) writeFileSync(file, "keep");
    assert.throws(() => deleteSecret(id), /Invalid favorite id/, `deleteSecret(${JSON.stringify(id)})`);
    assert.throws(() => storeSecret(id, "secret"), /Invalid favorite id/, `storeSecret(${JSON.stringify(id)})`);
    assert.equal(readSecret(id), null, `readSecret(${JSON.stringify(id)})`);
    for (const file of outside) assert.ok(existsSync(file), `${JSON.stringify(id)} must not reach ${file}`);
  }

  const id = crypto.randomUUID();
  storeSecret(id, "hunter2");
  assert.equal(readSecret(id), "hunter2");
  deleteSecret(id);
  assert.equal(readSecret(id), null);
} finally {
  rmSync(root, { recursive: true, force: true });
}
