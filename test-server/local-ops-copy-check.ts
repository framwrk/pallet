/**
 * Runs a copy or cross-volume move in its own process. Bun's `mock.module`
 * registry is shared by every test file in one `bun test` run, and local-ops
 * imports `shell` from electron; mocking electron here would otherwise hide
 * the `app` export that test-server/update-download.test.ts relies on.
 */
import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import { tmpdir } from "node:os";

const mtime = new Date("2020-01-02T03:04:05.000Z");
const realRename = fs.rename;
let failRenameWithExdev = false;

mock.module("electron", () => ({
  shell: {
    trashItem: async () => {},
    showItemInFolder: () => {},
    openPath: async () => "",
  },
}));

fs.rename = async (from: string, to: string) => {
  if (failRenameWithExdev) {
    failRenameWithExdev = false;
    const err: NodeJS.ErrnoException = new Error("EXDEV: cross-device link not permitted");
    err.code = "EXDEV";
    throw err;
  }
  return realRename(from, to);
};

const { copyMany, moveMany } = await import("../src/main/services/local-ops");

const mode = process.argv[2];
assert.ok(mode === "copy" || mode === "exdev", `unknown mode: ${mode}`);

const root = await mkdtemp(join(tmpdir(), "pallet-local-ops-"));
try {
  const src = join(root, "src", "file.txt");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(src, "contents");
  await chmod(src, 0o640);
  await utimes(src, mtime, mtime);

  const destDir = join(root, "dest");
  let dest: string;
  if (mode === "copy") {
    [dest] = await copyMany([src], destDir);
  } else {
    failRenameWithExdev = true;
    [dest] = await moveMany([src], destDir);
    await assert.rejects(stat(src), { code: "ENOENT" });
  }

  const stats = await stat(dest);
  assert.ok(Math.abs(stats.mtimeMs - mtime.getTime()) <= 1, `mtime changed: expected ${mtime.getTime()}, got ${stats.mtimeMs}`);
  assert.equal(stats.mode & 0o777, 0o640, "mode changed");
} finally {
  fs.rename = realRename;
  await rm(root, { recursive: true, force: true });
}
