/**
 * `fs.rename` preserves mtime and mode on the same volume, but the copy used by
 * `copyMany` and by the EXDEV fallback in `moveMany` must opt into
 * `preserveTimestamps`. Each case runs in its own process because local-ops
 * imports electron and Bun shares module mocks across test files.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = join(import.meta.dir, "local-ops-copy-check.ts");

function run(mode: "copy" | "exdev"): void {
  const result = Bun.spawnSync([process.execPath, fixture, mode], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

test("copyMany preserves file mtime and mode", () => {
  run("copy");
});

test("EXDEV move preserves file mtime and mode", () => {
  run("exdev");
});
