/**
 * Regression tests for local rename. A case-only rename must not replace a
 * different file on a case-sensitive volume (external drives, Linux/ext4).
 * macOS's default volume is case-insensitive, so the case-sensitive cases run
 * on a temporary HFSX disk image and skip cleanly when it cannot be created.
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mayReplaceDestination, rename } from "../src/main/services/local-rename";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

type FileIdentity = { dev: number; ino: number } | null;

const root = mkdtempSync(join(tmpdir(), "pallet-rename-"));
const mounts: string[] = [];

function isCaseSensitive(dir: string): boolean {
  const probe = join(dir, "pallet-case-probe");
  writeFileSync(probe, "probe");
  try {
    return !existsSync(join(dir, "PALLET-CASE-PROBE"));
  } finally {
    rmSync(probe, { force: true });
  }
}

/** Mount a small case-sensitive HFSX image; null when hdiutil is unavailable. */
function createCaseSensitiveVolume(): string | null {
  if (process.platform !== "darwin") return null;
  const image = join(root, "case-sensitive.dmg");
  const mount = join(root, "case-sensitive");
  mkdirSync(mount);
  try {
    execFileSync("hdiutil", ["create", "-size", "16m", "-fs", "HFSX", "-volname", "PalletCaseSensitive", image], {
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("hdiutil", ["attach", image, "-mountpoint", mount, "-nobrowse", "-readwrite", "-noautoopen"], {
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    return null;
  }
  mounts.push(mount);
  return isCaseSensitive(mount) ? mount : null;
}

const rootIsCaseSensitive = isCaseSensitive(root);
const caseSensitiveDir = rootIsCaseSensitive ? root : createCaseSensitiveVolume();
const caseInsensitiveDir = rootIsCaseSensitive ? null : root;

afterAll(() => {
  for (const mount of mounts) {
    try {
      execFileSync("hdiutil", ["detach", mount, "-force"], { stdio: "ignore", timeout: 60_000 });
    } catch {
      // The volume was already detached or never finished mounting.
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test("mayReplaceDestination allows only a missing or identical destination", () => {
  const source: FileIdentity = { dev: 1, ino: 2 };
  expect(mayReplaceDestination(null, null)).toBe(true);
  expect(mayReplaceDestination(source, null)).toBe(true);
  expect(mayReplaceDestination(source, { dev: 1, ino: 2 })).toBe(true);
  expect(mayReplaceDestination(source, { dev: 1, ino: 3 })).toBe(false);
  expect(mayReplaceDestination(source, { dev: 2, ino: 2 })).toBe(false);
  expect(mayReplaceDestination(null, { dev: 1, ino: 2 })).toBe(false);
});

test("rename refuses to replace a different existing file", async () => {
  const dir = mkdtempSync(join(root, "collision-"));
  const from = join(dir, "source.txt");
  const to = join(dir, "destination.txt");
  writeFileSync(from, "source");
  writeFileSync(to, "destination");

  await expect(rename(from, to)).rejects.toMatchObject({ code: "EEXIST" });

  expect(readFileSync(from, "utf8")).toBe("source");
  expect(readFileSync(to, "utf8")).toBe("destination");
});

test.skipIf(caseSensitiveDir === null)(
  "case-only rename refuses to replace a different file on a case-sensitive volume",
  async () => {
    const dir = mkdtempSync(join(caseSensitiveDir as string, "case-"));
    const from = join(dir, "report.txt");
    const to = join(dir, "REPORT.txt");
    writeFileSync(from, "lower");
    writeFileSync(to, "upper");
    expect(lstatSync(from).ino).not.toBe(lstatSync(to).ino);

    await expect(rename(from, to)).rejects.toMatchObject({ code: "EEXIST" });

    expect(readFileSync(from, "utf8")).toBe("lower");
    expect(readFileSync(to, "utf8")).toBe("upper");
    expect(readdirSync(dir).sort()).toEqual(["REPORT.txt", "report.txt"]);
  },
);

test.skipIf(caseSensitiveDir === null)("case-only rename to a free name still works on a case-sensitive volume", async () => {
  const dir = mkdtempSync(join(caseSensitiveDir as string, "case-free-"));
  const from = join(dir, "report.txt");
  const to = join(dir, "REPORT.txt");
  writeFileSync(from, "content");

  await rename(from, to);

  expect(readFileSync(to, "utf8")).toBe("content");
  expect(readdirSync(dir)).toEqual(["REPORT.txt"]);
});

test.skipIf(caseInsensitiveDir === null)(
  "case-only rename of the same file still works on a case-insensitive volume",
  async () => {
    const dir = mkdtempSync(join(caseInsensitiveDir as string, "case-change-"));
    const from = join(dir, "report.txt");
    const to = join(dir, "REPORT.txt");
    writeFileSync(from, "content");
    expect(lstatSync(from).ino).toBe(lstatSync(to).ino);

    await rename(from, to);

    expect(readFileSync(to, "utf8")).toBe("content");
    expect(readdirSync(dir)).toEqual(["REPORT.txt"]);
  },
);
