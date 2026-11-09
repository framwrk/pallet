import { afterEach, expect, test } from "bun:test";
import { getState, navigate, setBackend } from "../src/renderer/src/store/pane.store";
import type { DirListing } from "../src/shared/fs/fs.types";

const originalWindow = globalThis.window;

afterEach(() => {
  setBackend("right", { kind: "none" });
  globalThis.window = originalWindow;
});

function pendingListing(): {
  resolve: (listing: DirListing) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (listing: DirListing) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<DirListing>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  globalThis.window = { pallet: { sftp: { list: () => pending } } } as unknown as Window & typeof globalThis;
  setBackend("right", {
    kind: "sftp",
    protocol: "sftp",
    sessionId: "old-session",
    host: "localhost",
    username: "pallet",
    status: "connected",
  });
  return { resolve, reject };
}

test("disconnect discards a pending listing and clears loading", async () => {
  const pending = pendingListing();
  const navigation = navigate("right", "/old-server");
  expect(getState().panes.right.loading).toBe(true);

  setBackend("right", { kind: "none" });
  expect(getState().panes.right.loading).toBe(false);
  pending.resolve({ path: "/old-server", entries: [], availBytes: null });

  expect(await navigation).toBe(false);
  expect(getState().panes.right.cwd).toBe("");
  expect(getState().panes.right.history).toEqual([]);
});

test("replacing a backend discards the old listing's error", async () => {
  const pending = pendingListing();
  const navigation = navigate("right", "/old-server");
  setBackend("right", { kind: "local" });
  pending.reject(new Error("Old session closed"));

  expect(await navigation).toBe(false);
  expect(getState().panes.right.error).toBeNull();
  expect(getState().panes.right.loading).toBe(false);
});
