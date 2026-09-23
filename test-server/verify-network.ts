import { Client, type SFTPWrapper } from "ssh2";
import { Readable, Writable } from "node:stream";
import assert from "node:assert/strict";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// A separate container keeps this deterministic and leaves interactive sessions alone.
// Require `bun run server` first so Compose has already built the test image.
function docker(...args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `docker exited ${result.status}`);
  return result.stdout.trim();
}

const container = docker(
  "compose",
  "run",
  "--detach",
  "--rm",
  "--no-deps",
  "--pull",
  "never",
  "--publish",
  "127.0.0.1::22",
  "-e",
  "PALLET_TEST_NETWORK=realistic",
  "-e",
  "PALLET_TEST_DOWNLOAD_KBIT=2000",
  "-e",
  "PALLET_TEST_UPLOAD_KBIT=1000",
  "-e",
  "PALLET_TEST_DELAY_MS=40",
  "-e",
  "PALLET_TEST_JITTER_MS=0",
  "-e",
  "PALLET_TEST_LOSS_PERCENT=0",
  "sftp",
);
const clients = new Set<Client>();

async function connect(port: number, timeout = 10_000): Promise<Client> {
  const client = new Client();
  clients.add(client);
  try {
    await new Promise<void>((resolve, reject) => {
      client
        .once("ready", resolve)
        .on("error", reject)
        .connect({
          host: "127.0.0.1",
          port,
          username: "pallet",
          password: process.env.PALLET_TEST_PASSWORD ?? "pallet",
          hostVerifier: () => true,
          readyTimeout: timeout,
        });
    });
    return client;
  } catch (error) {
    client.destroy();
    clients.delete(client);
    throw error;
  }
}

function sftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => client.sftp((error, channel) => (error ? reject(error) : resolve(channel))));
}

function read(channel: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => channel.readFile(path, (error, data) => (error ? reject(error) : resolve(data))));
}

function shaping(device: string): {
  options: { rate: { rate: number }; delay: { delay: number }; "loss-random": { loss: number } };
  bytes: number;
} {
  const rules = JSON.parse(docker("exec", container, "tc", "-j", "-s", "qdisc", "show", "dev", device));
  const rule = rules.find((item: { kind: string }) => item.kind === "netem");
  assert(rule, `No network shaper on ${device}`);
  return rule;
}

// Bound stalled streams as well as connection handshakes.
const deadline = setTimeout(() => {
  for (const client of clients) client.destroy();
}, 90_000);

try {
  const port = Number(docker("port", container, "22/tcp").split(":").at(-1));
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = JSON.parse(docker("inspect", "--format", "{{json .State}}", container));
    if (!state.Running) throw new Error(docker("logs", container) || "Test container stopped");
    if (state.Health?.Status === "healthy") {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(ready, "Test server did not become healthy");

  const client = await connect(port);
  const channel = await sftp(client);
  const payload = randomBytes(512 * 1024);
  const remote = "/home/pallet/upload/network-check.bin";
  const uploadStart = performance.now();
  await pipeline(Readable.from(payload), channel.createWriteStream(remote));
  const uploadMs = performance.now() - uploadStart;

  const chunks: Buffer[] = [];
  const downloadStart = performance.now();
  await pipeline(
    channel.createReadStream(remote),
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  const downloadMs = performance.now() - downloadStart;
  assert(Buffer.concat(chunks).equals(payload), "Throttled transfer corrupted the payload");
  // Allow bursts/timer granularity, but reject an unrestricted localhost transfer.
  assert(uploadMs >= ((payload.length * 8) / 1000) * 0.75, `Upload bypassed rate limit: ${uploadMs}ms`);
  assert(downloadMs >= ((payload.length * 8) / 2000) * 0.75, `Download bypassed rate limit: ${downloadMs}ms`);
  console.log(`✓ 512 KiB round-trip: upload ${(uploadMs / 1000).toFixed(2)}s, download ${(downloadMs / 1000).toFixed(2)}s`);

  const rules = docker("exec", container, "test-server-network", "status");
  assert.equal((rules.match(/qdisc netem/g) ?? []).length, 2, "Both directions must have shaping");
  assert(rules.includes("mirred"), "Upload traffic must be redirected through the upload shaper");
  assert.equal(shaping("eth0").options.rate.rate, 250_000); // tc reports bytes/second.
  assert.equal(shaping("pallet-up").options.rate.rate, 125_000);
  assert(shaping("eth0").bytes >= payload.length, "Download did not traverse the shaper");
  assert(shaping("pallet-up").bytes >= payload.length, "Upload did not traverse the shaper");
  for (const setting of [
    "PALLET_TEST_NETWORK=typo",
    "PALLET_TEST_UPLOAD_KBIT=0",
    "PALLET_TEST_LOSS_PERCENT=101",
    "PALLET_TEST_JITTER_MS=41",
  ]) {
    assert.throws(() => docker("exec", "-e", setting, container, "test-server-network"), /Test network:/);
  }
  assert.equal(shaping("pallet-up").options.rate.rate, 125_000, "Invalid settings changed the active shaper");
  console.log("✓ Both queues carry transfer data; invalid settings are rejected before changing the network");

  // Read-only requests on the same session distinguish link latency from SSH startup.
  const delayedStart = performance.now();
  for (let i = 0; i < 3; i++) await read(channel, "/home/pallet/README.txt");
  const delayedMs = performance.now() - delayedStart;
  docker("exec", "-e", "PALLET_TEST_NETWORK=off", container, "test-server-network");
  const fastStart = performance.now();
  for (let i = 0; i < 3; i++) await read(channel, "/home/pallet/README.txt");
  const fastMs = performance.now() - fastStart;
  assert(delayedMs > fastMs + 150, `Delay not observable: shaped ${delayedMs}ms, off ${fastMs}ms`);
  assert(!docker("exec", container, "test-server-network", "status").includes("netem"));
  console.log(`✓ Added latency is observable; off removes shaping (${delayedMs.toFixed(0)}ms vs ${fastMs.toFixed(0)}ms)`);

  docker("exec", "-e", "PALLET_TEST_NETWORK=offline", container, "test-server-network");
  await assert.rejects(connect(port, 1500), "Offline profile must prevent an SSH handshake");
  let completed = false;
  const pending = read(channel, "/home/pallet/README.txt").then((data) => {
    completed = true;
    return data;
  });
  // Observe rejection immediately even if a broken connection fails before restoration.
  void pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert(!completed, "Existing session bypassed the outage");
  docker("exec", container, "test-server-network");
  assert((await pending).includes("Pallet"), "Existing session did not recover after the outage");
  const recovered = await connect(port);
  recovered.end();
  console.log("✓ Outage blocks new and existing traffic; existing session and new connections recover");

  docker(
    "exec",
    "-e",
    "PALLET_TEST_NETWORK=weak",
    ...["DOWNLOAD_KBIT", "UPLOAD_KBIT", "DELAY_MS", "JITTER_MS", "LOSS_PERCENT"].flatMap((name) => [
      "-e",
      `PALLET_TEST_${name}=`,
    ]),
    container,
    "test-server-network",
  );
  assert.equal(shaping("eth0").options.rate.rate, 187_500);
  assert.equal(shaping("pallet-up").options.rate.rate, 62_500);
  assert.equal(shaping("eth0").options.delay.delay, 0.15);
  assert(Math.abs(shaping("pallet-up").options["loss-random"].loss - 0.02) < 0.0001);
  console.log("✓ weak profile applies slower rates, higher delay, and packet loss");

  // tc reports bytes/second; netem rounds delay to the kernel's psched tick, so assert a
  // ceiling instead of exact equality like the slower profiles above.
  docker("exec", "-e", "PALLET_TEST_NETWORK=optimal", container, "test-server-network");
  assert.equal(shaping("eth0").options.rate.rate, 12_500_000);
  assert.equal(shaping("pallet-up").options.rate.rate, 6_250_000);
  assert(shaping("eth0").options.delay.delay <= 0.01, "Optimal profile must not exceed its 10 ms delay");
  console.log("✓ Optimal profile applies fiber-class rates and latency");

  docker("exec", "-e", "PALLET_TEST_NETWORK=performant", container, "test-server-network");
  assert.equal(shaping("eth0").options.rate.rate, 125_000_000);
  assert.equal(shaping("pallet-up").options.rate.rate, 125_000_000);
  assert(shaping("eth0").options.delay.delay <= 0.001, "Performant profile must not exceed its 1 ms delay");
  console.log("✓ Performant profile applies gigabit-class shaping in both directions");
} finally {
  clearTimeout(deadline);
  for (const client of clients) client.destroy();
  docker("rm", "--force", container);
}
