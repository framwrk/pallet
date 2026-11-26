import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { parseListing, parseProbe, parseStat, shQuote } from "../src/main/services/scp/scp-shell";
import type { AddressInfo } from "node:net";
import type { ConnectProfile } from "../src/shared/sftp/sftp.types";
import { ScpEndpoint } from "../src/main/services/scp/scp-endpoint";
import { ScpService } from "../src/main/services/scp/scp.service";
import { SessionManager } from "../src/main/services/sftp/session-manager";
import { Server as SshServer } from "ssh2";
import type { TransferJobSnapshot } from "../src/shared/transfer/transfer.types";
import { TransferQueue } from "../src/main/services/transfer/transfer-queue";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { makeEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import { promisify } from "node:util";
import { test } from "node:test";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

const HOST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
}).privateKey;

const ODD_NAMES = ["a b", "new\nline", "é ünïcode", "it's", "$(touch pwned)", "`touch pwned`", "-dash", "!bang", ".hidden"];

/** An SSH server without an SFTP subsystem whose exec runs the local /bin/sh, like a real host. */
async function startServer(home: string): Promise<{ port: number; maxOpen: () => number; close: () => Promise<void> }> {
  let open = 0;
  let maxOpen = 0;
  const server = new SshServer({ hostKeys: [HOST_KEY] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "pallet" && ctx.password === "secret") ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("error", () => {});
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (_accept, reject) => reject());
        session.on("exec", (accept, _reject, info) => {
          const channel = accept();
          open++;
          maxOpen = Math.max(maxOpen, open);
          const child = spawn("/bin/sh", ["-c", info.command], { cwd: home });
          child.stdin.on("error", () => {});
          channel.on("data", (chunk: Buffer) => child.stdin.write(chunk));
          channel.on("end", () => child.stdin.end());
          child.stdout.on("data", (chunk: Buffer) => channel.write(chunk));
          child.stderr.on("data", (chunk: Buffer) => channel.stderr.write(chunk));
          child.on("close", (code) => {
            open--;
            channel.exit(code ?? 1);
            channel.end();
          });
          channel.on("close", () => child.kill());
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    maxOpen: () => maxOpen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function withScp(
  fn: (ctx: { manager: SessionManager; sessionId: string; root: string; maxOpen: () => number }) => Promise<void>,
  concurrency = 3,
): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pallet-scp-")));
  const server = await startServer(root);
  const manager = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
  try {
    const profile: ConnectProfile = {
      protocol: "scp",
      host: "127.0.0.1",
      port: server.port,
      username: "pallet",
      auth: { method: "password", password: "secret" },
      concurrency,
    };
    const { sessionId, initialPath } = await manager.connect(profile);
    assert.equal(initialPath, root);
    await fn({ manager, sessionId, root, maxOpen: server.maxOpen });
  } finally {
    manager.disconnectAll();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function runQueue(
  manager: SessionManager,
  request: Parameters<TransferQueue["enqueue"]>[0],
  verification: "metadata" | "sha256" = "metadata",
): Promise<TransferJobSnapshot> {
  return new Promise((resolve) => {
    const queue = new TransferQueue(
      manager,
      {
        onUpdate: () => {},
        onConflict: (p) => queue.resolveConflict(p.jobId, "replace", true),
        record: resolve,
      },
      3,
      makeEndpoint,
      () => ({ verification }),
    );
    queue.enqueue(request);
  });
}

test("shQuote survives a real POSIX shell for hostile values", async () => {
  for (const value of [...ODD_NAMES, "", "'", "''", "a'b'c", "tab\there", "\\back", "😀"]) {
    const { stdout } = await execFileAsync("/bin/sh", ["-c", `printf '%s' ${shQuote(value)}`]);
    assert.equal(stdout, value);
  }
  assert.throws(() => shQuote("nul\0byte"), /NUL/);
});

test("parses GNU/BusyBox listings with newline names and a vanished entry", () => {
  const stdout = Buffer.concat([
    Buffer.from("fa b\0fnew\nline\0dsub\0fgone\0uloop\0\0"),
    Buffer.from("81a4 3 1700000000 a b\n81a4 5 1700000001 new\nline\n41ed 4096 1700000002 sub\na1ff 4 1700000003 loop\n"),
  ]);
  const entries = parseListing(stdout, "gnu");
  assert.deepEqual(
    entries.map((e) => [e.name, e.stat.mode.toString(8), e.stat.size, e.stat.mtimeMs, e.stat.target]),
    [
      ["a b", "100644", 3, 1700000000000, "f"],
      ["new\nline", "100644", 5, 1700000001000, "f"],
      ["sub", "40755", 4096, 1700000002000, "d"],
      ["loop", "120777", 4, 1700000003000, "u"],
    ],
  );
  assert.deepEqual(parseListing(Buffer.from("\0"), "gnu"), []);
  assert.throws(() => parseListing(Buffer.from("fa\0\0zz 1 2 a\n"), "gnu"), /Unexpected stat output/);
  assert.deepEqual(parseStat(Buffer.from("f\x00100644 7 1700000000 /x/y z\n"), "/x/y z", "bsd"), {
    mode: 0o100644,
    size: 7,
    mtimeMs: 1700000000000,
    target: "f",
  });
});

test("probe picks the stat dialect from real output", () => {
  assert.deepEqual(parseProbe(Buffer.from("/home/u\n\x0041ed 4096 1 /\n\0\0/usr/bin/scp\n\0")), {
    home: "/home/u",
    dialect: "gnu",
    hasScp: true,
  });
  assert.equal(parseProbe(Buffer.from("/\n\0\x0040755 64 1 /\n\0/usr/bin/scp\n\0")).dialect, "bsd");
  assert.equal(parseProbe(Buffer.from("/\n\0\0\0\0")).dialect, null);
});

test("SFTP against a server without the subsystem points at SCP", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pallet-scp-"));
  const server = await startServer(root);
  const manager = new SessionManager({ verifyHostKey: async () => true, onStatus: () => {} });
  try {
    await assert.rejects(
      manager.connect({
        host: "127.0.0.1",
        port: server.port,
        username: "pallet",
        auth: { method: "password", password: "secret" },
      }),
      (err: NodeJS.ErrnoException) => err.code === "ENOSFTP" && /Connect with SCP/.test(err.message),
    );
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("lists odd names without running them, and reports symlink targets", async () => {
  await withScp(async ({ manager, sessionId, root }) => {
    for (const name of ODD_NAMES) await fs.writeFile(join(root, name), name);
    await fs.mkdir(join(root, "sub dir"));
    await fs.symlink("sub dir", join(root, "to-dir"));
    await fs.symlink("missing", join(root, "dangling"));
    const service = new ScpService(manager);
    const listing = await service.list(sessionId, root);
    const byName = new Map(listing.entries.map((e) => [e.name, e]));
    assert.deepEqual([...byName.keys()].sort(), [...ODD_NAMES, "sub dir", "to-dir", "dangling"].sort());
    assert.equal(byName.get("new\nline")?.size, "new\nline".length);
    assert.equal(byName.get(".hidden")?.hidden, true);
    assert.equal(byName.get("sub dir")?.kind, "dir");
    assert.equal(byName.get("to-dir")?.targetKind, "dir");
    assert.equal(byName.get("dangling")?.targetKind, "unknown");
    await assert.rejects(fs.access(join(root, "pwned")));
    assert.deepEqual((await service.list(sessionId, join(root, "sub dir"))).entries, []);
    await assert.rejects(service.list(sessionId, join(root, "nope")), { code: "ENOENT" });
    await assert.rejects(service.list(sessionId, join(root, "a b")), { code: "ENOTDIR" });
  });
});

test("browse operations: stat, mkdir, rename refuses overwrite, chmod, delete, preview, folder size", async () => {
  await withScp(async ({ manager, sessionId, root }) => {
    const service = new ScpService(manager);
    await fs.writeFile(join(root, "it's.txt"), "hello world");
    const entry = await service.stat(sessionId, join(root, "it's.txt"));
    assert.equal(entry.kind, "file");
    assert.equal(entry.size, 11);
    await assert.rejects(service.stat(sessionId, join(root, "missing")), { code: "ENOENT" });
    assert.equal(await service.realpath(sessionId, root), root);

    await service.mkdir(sessionId, join(root, "new dir"));
    await assert.rejects(service.mkdir(sessionId, join(root, "new dir")), { code: "EEXIST" });
    await fs.writeFile(join(root, "other"), "x");
    await assert.rejects(service.rename(sessionId, join(root, "it's.txt"), join(root, "other")), { code: "EEXIST" });
    await service.rename(sessionId, join(root, "it's.txt"), join(root, "new dir/moved $x"));
    assert.equal(await fs.readFile(join(root, "new dir/moved $x"), "utf8"), "hello world");

    await service.chmod(sessionId, join(root, "other"), 0o640);
    assert.equal((await fs.stat(join(root, "other"))).mode & 0o777, 0o640);
    assert.equal((await service.readBytes(sessionId, join(root, "new dir/moved $x"), 5)).toString(), "hello");

    const outside = await fs.mkdtemp(join(tmpdir(), "pallet-scp-outside-"));
    await fs.writeFile(join(outside, "keep"), "keep");
    await fs.symlink(outside, join(root, "new dir/link-out"));
    assert.equal(await service.folderSize(sessionId, join(root, "new dir")), 11 + 0);
    await service.removeRecursive(sessionId, join(root, "new dir"));
    await assert.rejects(fs.access(join(root, "new dir")));
    assert.equal(await fs.readFile(join(outside, "keep"), "utf8"), "keep");
    await fs.rm(outside, { recursive: true, force: true });
  });
});

test("queue uploads stage, then mv into place with mode and mtime", async () => {
  await withScp(async ({ manager, sessionId, root }) => {
    const local = await fs.mkdtemp(join(tmpdir(), "pallet-scp-local-"));
    try {
      const body = randomBytes(3 * 1024 * 1024 + 17);
      await fs.writeFile(join(local, "big file"), body);
      await fs.writeFile(join(local, "new\nline"), "nl");
      await fs.writeFile(join(local, "empty"), "");
      await fs.chmod(join(local, "big file"), 0o751);
      const mtime = new Date("2024-03-04T05:06:07Z");
      await fs.utimes(join(local, "big file"), mtime, mtime);
      for (const verification of ["metadata", "sha256"] as const) {
        const dest = join(root, verification);
        await fs.mkdir(dest);
        const snapshot = await runQueue(
          manager,
          {
            from: { kind: "local" },
            to: { kind: "sftp", sessionId },
            sourceBase: local,
            destDir: dest,
            names: ["big file", "new\nline", "empty"],
          },
          verification,
        );
        assert.equal(snapshot.state, "completed", JSON.stringify(snapshot.errors));
        assert.ok((await fs.readFile(join(dest, "big file"))).equals(body));
        assert.equal(await fs.readFile(join(dest, "new\nline"), "utf8"), "nl");
        assert.equal((await fs.stat(join(dest, "empty"))).size, 0);
        const stat = await fs.stat(join(dest, "big file"));
        assert.equal(stat.mode & 0o777, 0o751);
        assert.equal(stat.mtimeMs, mtime.getTime());
        assert.deepEqual(
          (await fs.readdir(dest)).filter((n) => n.includes(".pallet-")),
          [],
        );
      }
    } finally {
      await fs.rm(local, { recursive: true, force: true });
    }
  });
});

test("queue downloads a file with an awkward name", async () => {
  await withScp(async ({ manager, sessionId, root }) => {
    const local = await fs.mkdtemp(join(tmpdir(), "pallet-scp-local-"));
    try {
      const body = randomBytes(1024 * 1024 + 3);
      await fs.writeFile(join(root, "new\nline $(x)"), body);
      const snapshot = await runQueue(
        manager,
        {
          from: { kind: "sftp", sessionId },
          to: { kind: "local" },
          sourceBase: root,
          destDir: local,
          names: ["new\nline $(x)"],
        },
        "sha256",
      );
      assert.equal(snapshot.state, "completed", JSON.stringify(snapshot.errors));
      assert.ok((await fs.readFile(join(local, "new\nline $(x)"))).equals(body));
    } finally {
      await fs.rm(local, { recursive: true, force: true });
    }
  });
});

test("endpoint: cancelled or short uploads never reach the final path; folders block replacement", async () => {
  await withScp(async ({ manager, sessionId, root }) => {
    const endpoint = new ScpEndpoint(manager, sessionId);
    await fs.writeFile(join(root, "final"), "original");
    const part = join(root, ".pallet-x.part");

    const controller = new AbortController();
    const cancelled = await endpoint.createWriteStream(part, 0o644, { size: 1000, signal: controller.signal });
    cancelled.on("error", () => {});
    cancelled.write(Buffer.alloc(100));
    controller.abort();
    await new Promise((resolve) => cancelled.once("close", resolve));
    assert.equal(await fs.readFile(join(root, "final"), "utf8"), "original");
    await endpoint.removeFile(part);
    await assert.rejects(fs.access(part));

    const short = await endpoint.createWriteStream(part, 0o644, { size: 10 });
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        short.once("error", reject);
        short.end(Buffer.from("abc"), resolve);
      }),
      /Less data/,
    );
    await assert.rejects(endpoint.createWriteStream(part, 0o644, {}), /file size up front/);

    await fs.writeFile(part, "staged");
    await fs.mkdir(join(root, "dir-target"));
    await fs.symlink("dir-target", join(root, "link-target"));
    await assert.rejects(endpoint.renameReplacing(part, join(root, "dir-target")), { code: "EISDIR" });
    await assert.rejects(endpoint.renameReplacing(part, join(root, "link-target")), { code: "EISDIR" });
    assert.deepEqual(await fs.readdir(join(root, "dir-target")), []);
    await endpoint.renameReplacing(part, join(root, "final"));
    assert.equal(await fs.readFile(join(root, "final"), "utf8"), "staged");
    await assert.rejects(endpoint.createReadStream(join(root, "final"), { start: 2 }), { code: "ENOTSUP" });
  });
});

test("exec channels stay within the session limit, and waiting can be cancelled", async () => {
  await withScp(async ({ manager, sessionId, root, maxOpen }) => {
    const service = new ScpService(manager);
    await fs.writeFile(join(root, "f"), "x");
    await Promise.all(Array.from({ length: 8 }, () => service.list(sessionId, root)));
    assert.ok(maxOpen() <= 2, `opened ${maxOpen()} channels`);

    const endpoint = new ScpEndpoint(manager, sessionId);
    const held = await Promise.all([0, 1].map((i) => endpoint.createWriteStream(join(root, `held${i}`), 0o644, { size: 1 })));
    const controller = new AbortController();
    const waiting = endpoint.createWriteStream(join(root, "waiting"), 0o644, { size: 1, signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, /interrupted/);
    for (const stream of held) stream.end(Buffer.from("y"));
    await Promise.all(held.map((stream) => new Promise((resolve) => stream.once("finish", resolve))));
    assert.equal(await fs.readFile(join(root, "held0"), "utf8"), "y");
  }, 1);
});
