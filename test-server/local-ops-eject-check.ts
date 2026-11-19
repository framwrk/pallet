/**
 * Runs ejectVolume's validation in its own process: local-ops imports electron
 * and Bun shares module mocks across test files. Only rejection paths run here,
 * so no volume is ever actually ejected.
 */
import assert from "node:assert/strict";
import { mock } from "bun:test";

mock.module("electron", () => ({ shell: {} }));

const { ejectVolume } = await import("../src/main/services/local-ops");

for (const path of ["/", "/tmp", "/Volumes"]) {
  const err: unknown = await ejectVolume(path).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error, `${path} should be rejected`);
  assert.equal((err as NodeJS.ErrnoException).code, "EINVAL", `${path} should be rejected with EINVAL`);
}
