/**
 * Exercise the update handoff without a real DMG. The renderer only supplies a
 * version: main resolves the release, verifies the SHA-256, and mounts the
 * image. These tests cover the open/quit behavior plus invalid versions,
 * traversal, checksum mismatches, and oversized/incomplete/stalled responses.
 */
import {
  MAX_UPDATE_BYTES,
  UPDATE_DOWNLOAD_TIMEOUT_MS,
  canonicalUpdateVersion,
  normalizeSha256,
  parseChecksums,
  updateDownloadPath,
  validateAssetUrl,
} from "../src/main/services/update-download.utils";
import type { UpdateDownloadState, UpdateInfo } from "../src/shared/update/update.types";
import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "pallet-update-"));
const downloads = join(home, "Downloads");
const version = "9.9.9";
const filename = `pallet-${version}.dmg`;
const dest = join(downloads, filename);
const part = `${dest}.part`;
const image = Buffer.from("test disk image");
const checksum = createHash("sha256").update(image).digest("hex");
const otherChecksum = createHash("sha256").update("something else").digest("hex");

const apiUrl = `https://api.github.com/repos/framwrk/pallet/releases/tags/v${version}`;
const dmgUrl = `https://github.com/framwrk/pallet/releases/download/v${version}/${filename}`;
const checksumsUrl = `https://github.com/framwrk/pallet/releases/download/v${version}/checksums.txt`;

const info: UpdateInfo = {
  version,
  url: "https://github.com/framwrk/pallet/releases/tag/v9.9.9",
  prerelease: false,
  dmgUrl,
};

type FetchHandler = (url: string) => Response | Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function releaseResponse(
  options: { digest?: string | null; assetName?: string; assetUrl?: string; checksums?: string } = {},
): Response {
  const asset: Record<string, unknown> = {
    name: options.assetName ?? filename,
    browser_download_url: options.assetUrl ?? dmgUrl,
  };
  if (options.digest !== null) asset.digest = options.digest ?? `sha256:${checksum}`;
  const assets: Array<Record<string, unknown>> = [asset];
  if (options.checksums !== undefined) {
    assets.push({ name: "checksums.txt", browser_download_url: checksumsUrl, digest: null });
  }
  return jsonResponse({ tag_name: `v${version}`, draft: false, assets });
}

function imageResponse(): Response {
  return new Response(image, { headers: { "content-length": String(image.length) } });
}

const defaultHandler: FetchHandler = (url) => {
  if (url === apiUrl) return releaseResponse();
  if (url === dmgUrl) return imageResponse();
  throw new Error(`unexpected fetch ${url}`);
};

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let handler: FetchHandler = defaultHandler;

globalThis.fetch = ((input: RequestInfo | URL) => {
  const url = String(input);
  fetchCalls.push(url);
  return handler(url);
}) as typeof fetch;

let quitCalls = 0;
let states: UpdateDownloadState[] = [];
let openPathCalls: string[] = [];
let openPath: (path: string) => Promise<string> = async () => "";
let downloadUpdate: (info: UpdateInfo) => Promise<string>;

mock.module("node:os", () => ({ homedir: () => home }));
mock.module("electron", () => ({
  app: {
    quit: () => {
      quitCalls += 1;
    },
    getPath: () => home,
  },
  shell: {
    openPath: (path: string) => {
      openPathCalls.push(path);
      return openPath(path);
    },
  },
}));
mock.module("../src/main/services/logger", () => ({ log: () => {} }));
mock.module("../src/main/utils/broadcast", () => ({
  broadcast: (_channel: string, state: UpdateDownloadState) => states.push(state),
}));

beforeAll(async () => {
  mkdirSync(downloads, { recursive: true });
  ({ downloadUpdate } = await import("../src/main/services/update-downloader"));
});

beforeEach(() => {
  quitCalls = 0;
  states = [];
  fetchCalls = [];
  openPathCalls = [];
  handler = defaultHandler;
  openPath = async () => "";
  rmSync(dest, { force: true });
  rmSync(part, { force: true });
  // A verified image already in Downloads is the common happy path; individual
  // tests remove it when they want to exercise the download itself.
  writeFileSync(dest, image);
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
  mock.restore();
});

test("a successful open still auto-quits", async () => {
  await downloadUpdate(info);
  expect(states.map((state) => state.status)).toEqual(["done"]);
  expect(openPathCalls).toEqual([dest]);
  expect(quitCalls).toBe(0);
  jest.advanceTimersByTime(250);
  expect(quitCalls).toBe(1);
});

test("an open failure keeps Pallet running and reports the error", async () => {
  openPath = async () => "simulated failure";
  await expect(downloadUpdate(info)).rejects.toThrow("Could not open the disk image: simulated failure");
  jest.advanceTimersByTime(1_000);
  expect(quitCalls).toBe(0);
  expect(states.map((state) => state.status)).toEqual(["done", "error"]);
  expect(states.at(-1)?.error).toContain("simulated failure");
});

test("a rejected open keeps Pallet running and reports the error", async () => {
  openPath = async () => {
    throw new Error("launch services unavailable");
  };
  await expect(downloadUpdate(info)).rejects.toThrow("Could not open the disk image: launch services unavailable");
  jest.advanceTimersByTime(1_000);
  expect(quitCalls).toBe(0);
  expect(states.at(-1)).toMatchObject({
    status: "error",
    error: "Could not open the disk image: launch services unavailable",
  });
});

test("an open that never completes times out without quitting", async () => {
  let finishOpen!: (failure: string) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  openPath = () =>
    new Promise((resolve) => {
      finishOpen = resolve;
      markStarted();
    });

  const pending = downloadUpdate(info);
  await started;
  jest.advanceTimersByTime(10_000);
  let error: unknown;
  try {
    await pending;
  } catch (caught) {
    error = caught;
  }
  expect((error as Error).message).toContain("took too long to open");
  expect(quitCalls).toBe(0);
  expect(states.at(-1)?.status).toBe("error");

  // A late success must not quit after the user has already been told it failed.
  finishOpen("");
  await Promise.resolve();
  jest.advanceTimersByTime(1_000);
  expect(quitCalls).toBe(0);
});

test("a delayed successful open quits once the grace period elapses", async () => {
  let finishOpen!: (failure: string) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  openPath = () =>
    new Promise((resolve) => {
      finishOpen = resolve;
      markStarted();
    });

  const pending = downloadUpdate(info);
  await started;
  jest.advanceTimersByTime(5_000);
  expect(quitCalls).toBe(0);
  finishOpen("");
  await pending;
  expect(quitCalls).toBe(0);
  jest.advanceTimersByTime(250);
  expect(quitCalls).toBe(1);
});

test("canonicalUpdateVersion accepts only MAJOR.MINOR.PATCH", () => {
  expect(canonicalUpdateVersion("9.9.9")).toBe("9.9.9");
  expect(canonicalUpdateVersion("v9.9.9")).toBe("9.9.9");
  expect(canonicalUpdateVersion(" 09.009.0009 ")).toBe("9.9.9");
  for (const bad of ["", "9.9", "9.9.9.9", "9.9.9-beta", "../9.9.9", "9.9.9/../evil", 99, null, undefined]) {
    expect(() => canonicalUpdateVersion(bad)).toThrow("invalid version");
  }
});

test("a traversal version cannot produce a path outside Downloads", () => {
  expect(() => updateDownloadPath(downloads, "../../../evil")).toThrow("invalid version");
  expect(() => updateDownloadPath(downloads, `${version}/../../evil`)).toThrow("invalid version");
  expect(updateDownloadPath(downloads, version)).toBe(dest);
  expect(existsSync(join(home, "evil.dmg"))).toBe(false);
  expect(existsSync(join(downloads, "..", "evil.dmg"))).toBe(false);
});

test("a renderer-supplied traversal version is rejected before any request", async () => {
  await expect(downloadUpdate({ ...info, version: "../../../evil" })).rejects.toThrow("invalid version");
  expect(fetchCalls).toEqual([]);
  expect(openPathCalls).toEqual([]);
  expect(states.at(-1)?.status).toBe("error");
});

test("checksum helpers accept only SHA-256 digests", () => {
  expect(normalizeSha256(`sha256:${checksum}`)).toBe(checksum);
  expect(normalizeSha256(checksum.toUpperCase())).toBe(checksum);
  expect(normalizeSha256("sha256:not-a-digest")).toBeNull();
  expect(normalizeSha256(null)).toBeNull();
  expect(parseChecksums(`${checksum}  ${filename}\n`, filename)).toBe(checksum);
  expect(parseChecksums(`${checksum} *${filename}\n`, filename)).toBe(checksum);
  expect(parseChecksums(`${checksum}  other.dmg\n`, filename)).toBeNull();
});

test("asset URLs must be GitHub HTTPS URLs", () => {
  expect(validateAssetUrl(dmgUrl)).toBe(dmgUrl);
  for (const bad of ["http://github.com/pallet.dmg", "https://evil.test/pallet.dmg", "file:///tmp/pallet.dmg", null]) {
    expect(() => validateAssetUrl(bad)).toThrow("download URL");
  }
});

test("a verified existing disk image is not downloaded again", async () => {
  await downloadUpdate(info);
  expect(fetchCalls).toEqual([apiUrl]);
  expect(openPathCalls).toEqual([dest]);
});

test("a corrupt existing disk image is re-downloaded and verified", async () => {
  writeFileSync(dest, "corrupt");
  await downloadUpdate(info);
  expect(fetchCalls).toContain(dmgUrl);
  expect(readFileSync(dest)).toEqual(image);
  expect(openPathCalls).toEqual([dest]);
});

test("a checksum mismatch is discarded without mounting", async () => {
  rmSync(dest, { force: true });
  handler = (url) => {
    if (url === apiUrl) return releaseResponse({ digest: `sha256:${otherChecksum}` });
    if (url === dmgUrl) return imageResponse();
    throw new Error(`unexpected fetch ${url}`);
  };

  await expect(downloadUpdate(info)).rejects.toThrow("checksum");
  expect(openPathCalls).toEqual([]);
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(part)).toBe(false);
  expect(states.at(-1)?.status).toBe("error");
});

test("a checksum mismatch leaves an existing disk image untouched", async () => {
  const stale = Buffer.from("stale disk image");
  writeFileSync(dest, stale);
  handler = (url) => {
    if (url === apiUrl) return releaseResponse({ digest: `sha256:${otherChecksum}` });
    if (url === dmgUrl) return imageResponse();
    throw new Error(`unexpected fetch ${url}`);
  };

  await expect(downloadUpdate(info)).rejects.toThrow("checksum");
  expect(readFileSync(dest)).toEqual(stale);
  expect(openPathCalls).toEqual([]);
  expect(existsSync(part)).toBe(false);
});

test("an oversized response fails without writing a disk image", async () => {
  rmSync(dest, { force: true });
  handler = (url) => {
    if (url === apiUrl) return releaseResponse();
    if (url === dmgUrl) {
      return new Response(image, { headers: { "content-length": String(MAX_UPDATE_BYTES + 1) } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await expect(downloadUpdate(info)).rejects.toThrow("larger than expected");
  expect(openPathCalls).toEqual([]);
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(part)).toBe(false);
});

test("an incomplete response fails without mounting", async () => {
  rmSync(dest, { force: true });
  handler = (url) => {
    if (url === apiUrl) return releaseResponse();
    if (url === dmgUrl) {
      return new Response(image, { headers: { "content-length": String(image.length + 1) } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await expect(downloadUpdate(info)).rejects.toThrow("incomplete");
  expect(openPathCalls).toEqual([]);
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(part)).toBe(false);
});

test("a stalled download times out and aborts", async () => {
  rmSync(dest, { force: true });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  handler = (url) => {
    if (url === apiUrl) return releaseResponse();
    if (url === dmgUrl) {
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            markStarted();
            return new Promise(() => {});
          },
        }),
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const pending = downloadUpdate(info);
  await started;
  jest.advanceTimersByTime(UPDATE_DOWNLOAD_TIMEOUT_MS);
  await expect(pending).rejects.toThrow("timed out");
  expect(openPathCalls).toEqual([]);
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(part)).toBe(false);
});

test("falls back to checksums.txt when the asset has no digest", async () => {
  rmSync(dest, { force: true });
  handler = (url) => {
    if (url === apiUrl) return releaseResponse({ digest: null, checksums: `${checksum}  ${filename}\n` });
    if (url === checksumsUrl) return new Response(`${checksum}  ${filename}\n`);
    if (url === dmgUrl) return imageResponse();
    throw new Error(`unexpected fetch ${url}`);
  };

  await downloadUpdate(info);
  expect(fetchCalls).toContain(checksumsUrl);
  expect(readFileSync(dest)).toEqual(image);
  expect(openPathCalls).toEqual([dest]);
});

test("refuses to download when the release publishes no checksum", async () => {
  rmSync(dest, { force: true });
  handler = (url) => {
    if (url === apiUrl) return releaseResponse({ digest: null });
    throw new Error(`unexpected fetch ${url}`);
  };

  await expect(downloadUpdate(info)).rejects.toThrow("no checksum");
  expect(fetchCalls).toEqual([apiUrl]);
  expect(openPathCalls).toEqual([]);
});

test("refuses an asset URL outside GitHub", async () => {
  rmSync(dest, { force: true });
  handler = (url) => {
    if (url === apiUrl) return releaseResponse({ assetUrl: "https://evil.test/pallet-9.9.9.dmg" });
    throw new Error(`unexpected fetch ${url}`);
  };

  await expect(downloadUpdate(info)).rejects.toThrow("untrusted download URL");
  expect(fetchCalls).toEqual([apiUrl]);
  expect(openPathCalls).toEqual([]);
});

test("refuses a release without the expected asset name", async () => {
  rmSync(dest, { force: true });
  handler = (url) => {
    if (url === apiUrl) return releaseResponse({ assetName: "pallet-other.dmg" });
    throw new Error(`unexpected fetch ${url}`);
  };

  await expect(downloadUpdate(info)).rejects.toThrow(`has no ${filename} asset`);
  expect(openPathCalls).toEqual([]);
});
