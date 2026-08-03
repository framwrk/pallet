/**
 * Shared Docker helpers for every suite that needs a container.
 *
 * All of these exist to make failures loud and fast. A test suite that hangs
 * is worse than one that fails: it burns CI minutes, it gives no diagnosis,
 * and locally it looks like your machine is broken. Every wait in here has a
 * deadline, and every subprocess call has a timeout.
 *
 * Works under both Bun (the `bun test` suites) and Node (the bundled
 * `tests/node` suites), so it uses nothing runtime-specific.
 */
import { spawnSync } from "child_process";
import { connect } from "net";

/** Subprocess calls can't be allowed to block forever on a wedged daemon. */
const DOCKER_CMD_TIMEOUT_MS = 30_000;

export interface DockerResult {
  status: number;
  stdout: string;
  stderr: string;
}

function docker(args: string[], timeoutMs = DOCKER_CMD_TIMEOUT_MS): DockerResult {
  const res = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs });
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error(
      "Docker is not installed, or `docker` is not on PATH.\n" +
        "These tests need a local Docker daemon — install Docker Desktop and retry.",
    );
  }
  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new Error(
      `\`docker ${args.join(" ")}\` did not return within ${timeoutMs / 1000}s.\n` +
        "The Docker daemon looks wedged — restart Docker Desktop and retry.",
    );
  }
  if (res.error) throw res.error;
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

/** Run a docker command and throw with its stderr if it fails. */
export function dockerOrThrow(args: string[], timeoutMs = DOCKER_CMD_TIMEOUT_MS): string {
  const res = docker(args, timeoutMs);
  if (res.status !== 0) {
    throw new Error(`\`docker ${args.join(" ")}\` failed:\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

let dockerChecked = false;

/**
 * Verify the daemon is actually reachable before a suite does any work.
 *
 * Call this first in every Docker-dependent script. Without it, a stopped
 * Docker Desktop surfaces as a confusing failure deep inside a build or a
 * connection timeout, instead of one line telling you to start Docker.
 */
export function ensureDockerAvailable(): void {
  if (dockerChecked) return;
  // `docker info` talks to the daemon; `docker --version` only reads the CLI
  // binary and succeeds even when the daemon is down, so it's useless here.
  const res = docker(["info", "--format", "{{.ServerVersion}}"], 20_000);
  if (res.status !== 0) {
    throw new Error(
      "Docker is installed but the daemon is not responding.\n" +
        "Start Docker Desktop (or `colima start`) and retry.\n" +
        `docker info said: ${res.stderr || res.stdout || "(no output)"}`,
    );
  }
  dockerChecked = true;
}

/** Block the thread briefly without spawning a process. Node and Bun both support this. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Container ids matching an exact name, running or not. */
function containerIds(name: string): string[] {
  const out = docker(["ps", "-aq", "--filter", `name=^${name}$`]);
  return out.stdout.split("\n").filter(Boolean);
}

/**
 * Force-remove a container and wait until it is genuinely gone.
 *
 * `docker rm -f` returns before the container has finished dying, and its
 * published port stays bound for a moment afterwards. Starting a replacement
 * in that window either fails on a port conflict or — worse — connects to the
 * corpse's proxy and waits forever for a banner that never comes. This is the
 * "tests hang until I stop the container by hand" failure.
 */
export function removeContainer(name: string, timeoutMs = 30_000): void {
  if (containerIds(name).length === 0) return;
  docker(["rm", "-f", name]);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (containerIds(name).length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Container "${name}" was still present ${timeoutMs / 1000}s after \`docker rm -f\`.\n` +
          "Remove it manually (`docker rm -f " +
          name +
          "`) or restart Docker, then retry.",
      );
    }
    // Deliberately blocking: callers are setup paths, and a synchronous wait
    // is simpler than threading async through every harness entry point.
    sleepSync(100);
  }
}

/** Whoever is holding this published port, so the error can name them. */
function portHolders(port: number): string {
  const res = docker(["ps", "--format", "{{.Names}}\t{{.Ports}}"]);
  if (res.status !== 0) return "";
  return res.stdout
    .split("\n")
    .filter((line) => line.includes(`:${port}->`))
    .map((line) => line.split("\t")[0])
    .join(", ");
}

/**
 * Wait for a real SSH banner on host:port.
 *
 * Docker's userland proxy accepts TCP connections before sshd inside the
 * container is listening, so "the port is open" proves nothing — we wait for
 * the server to actually say `SSH-`.
 *
 * Every terminal socket event reschedules or rejects. The previous version
 * handled `error` and `timeout` but not `close`, and a proxy that accepts then
 * immediately closes (a container mid-start or mid-teardown) emits `close`
 * alone — with the timeout timer already cleared by the destroy. That stranded
 * the promise permanently: no rejection, no retry, no timeout. Hence the
 * `settled` latch and the listeners for `close` and `end`.
 */
export function waitForSshBanner(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      if (Date.now() > deadline) {
        const holders = portHolders(port);
        reject(
          new Error(
            `No SSH banner on ${host}:${port} within ${timeoutMs / 1000}s.` +
              (holders ? `\nPort ${port} is published by container(s): ${holders}` : "") +
              "\nIf a stale container is holding the port, remove it and retry.",
          ),
        );
        return;
      }

      const socket = connect({ host, port });
      let settled = false;
      const finish = (gotBanner: boolean): void => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        if (gotBanner) resolve();
        else setTimeout(attempt, 250);
      };

      socket.setTimeout(2000, () => finish(false));
      socket.on("data", (chunk: Buffer) => finish(chunk.toString("latin1").startsWith("SSH-")));
      socket.on("error", () => finish(false));
      // Accept-then-close, and clean half-close: both must retry, not strand.
      socket.on("close", () => finish(false));
      socket.on("end", () => finish(false));
    };
    attempt();
  });
}

/**
 * Fail a suite loudly rather than letting it hang forever.
 *
 * Wrap a whole run in this so a pathological case that slips past the
 * individual deadlines still terminates with a diagnosis.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} exceeded its ${Math.round(ms / 1000)}s deadline and was aborted.`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
