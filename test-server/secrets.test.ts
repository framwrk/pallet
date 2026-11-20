import { expect, test } from "bun:test";
import { join } from "node:path";

test("secret files are addressed only by a favorite UUID", () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "secrets-check.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
