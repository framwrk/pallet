/**
 * Exercise the update handoff without a real DMG: a failed, rejected, or
 * hanging `shell.openPath` must emit an error and leave Pallet running, while
 * a successful open still schedules the quit.
 */
import type { UpdateDownloadState, UpdateInfo } from "../src/shared/update/update.types";
import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "pallet-update-"));
const dest = join(home, "Downloads", "pallet-9.9.9.dmg");
const info: UpdateInfo = {
  version: "9.9.9",
  url: "https://example.test/release",
  prerelease: false,
  dmgUrl: "https://example.test/pallet.dmg",
};

let quitCalls = 0;
let states: UpdateDownloadState[] = [];
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
  shell: { openPath: (path: string) => openPath(path) },
}));
mock.module("../src/main/services/logger", () => ({ log: () => {} }));
mock.module("../src/main/utils/broadcast", () => ({
  broadcast: (_channel: string, state: UpdateDownloadState) => states.push(state),
}));

beforeAll(async () => {
  mkdirSync(join(home, "Downloads"), { recursive: true });
  writeFileSync(dest, "test disk image");
  ({ downloadUpdate } = await import("../src/main/services/update-downloader"));
});

beforeEach(() => {
  quitCalls = 0;
  states = [];
  openPath = async () => "";
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  mock.restore();
});

test("a successful open still auto-quits", async () => {
  await downloadUpdate(info);
  expect(states.map((state) => state.status)).toEqual(["done"]);
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
