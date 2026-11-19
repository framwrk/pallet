/**
 * Ejecting is driven by a renderer-supplied path, so local-ops only lets a
 * currently mounted, non-boot volume through to diskutil.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

test("ejectVolume rejects the boot volume and paths that are not mounted volumes", () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "local-ops-eject-check.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
