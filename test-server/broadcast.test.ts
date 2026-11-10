/** Isolate Electron and broadcast mocks from the rest of Bun's shared module registry. */
import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = join(import.meta.dir, "broadcast-check.ts");

function run(mode: string): void {
  const result = Bun.spawnSync([process.execPath, fixture, mode], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

test("broadcast skips destroyed windows and web contents", () => run("destroyed"));
test("broadcast isolates send failures and window-close races per recipient", () => run("send"));
test("transfers survive delivery failures and closing/reopening the window", () => run("transfer"));
