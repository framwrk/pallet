import { expect, test } from "bun:test";
import type { Configuration } from "electron-builder";
import { FileMatcher } from "app-builder-lib/out/fileMatcher";
import { join } from "node:path";
import { statSync } from "node:fs";

const root = join(import.meta.dir, "..");
const config = Bun.YAML.parse(await Bun.file(join(root, "electron-builder.yml")).text()) as Configuration;

test("macOS folder usage descriptions are top-level plist strings", () => {
  const info = config.mac?.extendInfo;
  expect(info).toBeDefined();
  expect(Array.isArray(info)).toBe(false);
  for (const folder of ["Documents", "Downloads", "Movies", "Music", "Pictures"]) {
    expect(info?.[`NS${folder}FolderUsageDescription`]).toBe(`Pallet browses and transfers files in your ${folder} folder.`);
  }
});

test("packaging includes runtime output and excludes project-only files", () => {
  const matcher = new FileMatcher(root, root, (pattern) => pattern, config.files as string[]);
  // Ignore-only patterns cause Electron Builder to implicitly include everything.
  expect(matcher.containsOnlyIgnore()).toBe(false);
  const filter = matcher.createFilter();
  const fileStat = statSync(join(root, "package.json"));

  for (const file of [
    "package.json",
    "out/main/index.js",
    "out/preload/index.js",
    "out/renderer/index.html",
    "out/renderer/assets/index.js",
    "out/renderer/assets/font.woff2",
  ]) {
    expect(filter(join(root, file), fileStat), file).toBe(true);
  }

  for (const file of [
    ".agents/plans/private.md",
    ".env.local",
    "src/main/index.ts",
    "test-server/fixtures/README.txt",
    "docs/ui-regression.md",
    "scripts/verify-release.sh",
    "assets/pallet-preview-1.png",
    "docker-compose.yml",
    "bun.lock",
    "electron.vite.config.ts",
    "README.md",
    "future-project-file.txt",
  ]) {
    expect(filter(join(root, file), fileStat), file).toBe(false);
  }
});
