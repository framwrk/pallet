/**
 * Docker OpenSSH harness. Builds the image and runs a disposable container
 * for the integration suite. Requires a local Docker daemon.
 *
 * Docker plumbing (daemon check, container teardown, banner wait) lives in
 * ../support/docker.ts and is shared with the SFTPGo suite.
 */
import { spawnSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { dockerOrThrow, ensureDockerAvailable, removeContainer, waitForSshBanner } from "../support/docker";

/**
 * Anchor on the repo root rather than import.meta.url: the Node-runtime suites
 * are bundled to a different directory before they run, which would otherwise
 * move the Docker build context out from under us.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate the repo root");
    dir = parent;
  }
  return dir;
}

const HERE = join(repoRoot(), "tests", "integration");

export const HARNESS = {
  host: "127.0.0.1",
  port: 2222,
  username: "testuser",
  password: "testpass",
  keyPath: join(HERE, "docker", "keys", "test_ed25519"),
  fixtures: "/home/testuser/fixtures",
};

const IMAGE = "pallet-openssh-test";
const CONTAINER = "pallet-openssh-test-run";

/**
 * Generate the throwaway keypair the container trusts. It is created on
 * demand and gitignored: a private key committed to a repo trips secret
 * scanners and teaches the wrong habit, even when it only unlocks a
 * disposable test container.
 */
function ensureTestKey(): void {
  const keyPath = join(HERE, "docker", "keys", "test_ed25519");
  if (existsSync(keyPath)) return;
  mkdirSync(join(HERE, "docker", "keys"), { recursive: true });
  const res = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "pallet-test", "-f", keyPath, "-q"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.status !== 0) {
    throw new Error(`ssh-keygen failed:\n${res.stderr || res.stdout}`);
  }
}

export async function startServer(): Promise<void> {
  // Fail with one clear line if Docker isn't running, rather than deep inside
  // a build or as a mysterious connection timeout.
  ensureDockerAvailable();
  ensureTestKey();
  dockerOrThrow(["build", "-q", "-t", IMAGE, join(HERE, "docker")], 300_000);
  // Wait for any previous container to be genuinely gone before rebinding the
  // port — `docker rm -f` returns before teardown finishes.
  removeContainer(CONTAINER);
  // No --rm: auto-removal races with `docker restart` in the drop test.
  dockerOrThrow(["run", "-d", "--name", CONTAINER, "-p", `${HARNESS.host}:${HARNESS.port}:22`, IMAGE]);
  await waitForSshBanner(HARNESS.host, HARNESS.port, 30_000);
}

export function stopServer(): void {
  // Teardown runs in `finally` blocks, including after a failure that may be a
  // dead daemon — never let cleanup throw and mask the original error.
  try {
    removeContainer(CONTAINER);
  } catch {
    // Nothing useful to do; the original failure matters more.
  }
}

/** Restart sshd's container to simulate a connection drop. */
export async function restartServer(): Promise<void> {
  dockerOrThrow(["restart", "-t", "0", CONTAINER]);
  await waitForSshBanner(HARNESS.host, HARNESS.port, 30_000);
}
