import { type ElectronUI, button, field, grid, pane, until } from "./electron";
import { type Protocol, type Servers, protocols } from "./servers";
import { appendFile, chmod, mkdir, open, readFile, readdir, stat, truncate, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import type { Case } from "./local";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const connected = (id = "right"): string => `!!${pane(id)}?.querySelector('[aria-label=Disconnect]')`;
const job = "[...document.querySelectorAll('#transfer-drawer-jobs > [role=listitem]')].at(-1)";
const favorite = (name: string): string =>
  `[...document.querySelectorAll('aside[aria-label="Locations and connections"] button[draggable=true]')].find(e=>e.innerText.trim()===${JSON.stringify(name)})`;
export async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function tree(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const name = `${prefix}${e.name}`;
      result[name] = e.isDirectory() ? "directory" : await hash(join(dir, e.name));
      if (e.isDirectory()) await walk(join(dir, e.name), `${name}/`);
    }
  }
  await walk(path, "");
  return result;
}
async function disconnect(ui: ElectronUI, id = "right"): Promise<void> {
  if (await ui.read(connected(id))) await ui.button("Disconnect", pane(id));
  await ui.wait(`!(${connected(id)})`, "pane disconnected");
}
async function form(ui: ElectronUI, s: Servers, p: Protocol, auth = "password"): Promise<void> {
  await ui.wait("!!document.querySelector('[role=dialog] input[aria-label=Server]')");
  await ui.button("Connection protocol");
  await ui.click(`[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()==='${p.toUpperCase()}')`);
  await ui.fill("document.querySelector('[role=dialog] input[aria-label=Server]')", "127.0.0.1");
  await ui.fill("document.querySelector('[role=dialog] input[aria-label=Port]')", String(s.ports.get(p)));
  await ui.fill(field("Username"), "pallet");
  if (auth === "password") await ui.fill(field("Password"), s.password);
  else if (auth === "key") {
    await ui.button("Private Key");
    await ui.fill(field("Private key"), s.key);
  } else await ui.button("SSH Agent");
  await ui.button("Connection options");
  await ui.fill(field("Remote Path"), s.remote(p));
  // Two channels keep item-control cases deterministic without exhausting the server.
  await ui.fill(field("Concurrency"), "2");
}
async function finishConnect(ui: ElectronUI, id = "right"): Promise<void> {
  await ui.wait(`${connected(id)} && !document.querySelector('[role=dialog]')`, "connection complete", 25000);
  await ui.wait(`!!${grid(id)} && !${pane(id)}.querySelector('.animate-spin')`, "initial remote listing", 20000);
}
async function connect(ui: ElectronUI, s: Servers, p: Protocol, id = "right", auth = "password"): Promise<void> {
  await disconnect(ui, id);
  if (id === "left") await ui.button("Replace Local Pane with Remote…");
  else await ui.key("k", 4);
  await form(ui, s, p, auth);
  if (p === "ftps") await ui.click("document.querySelector('[role=checkbox][aria-label=\"Verify TLS certificate\"]')");
  await ui.button("Connect");
  if (p === "sftp") {
    await ui.wait(`document.body.innerText.includes('Unknown Host') || ${connected(id)}`, "trust or connection", 20000);
    if (await ui.read("document.body.innerText.includes('Unknown Host')")) await ui.button("Trust");
  }
  await finishConnect(ui, id);
}
async function clear(ui: ElectronUI): Promise<void> {
  if (await ui.read(`!!(${button("Clear")})`)) await ui.button("Clear");
  await ui.wait("document.querySelectorAll('#transfer-drawer-jobs > [role=listitem]').length===0", "empty queue");
}
async function copy(ui: ElectronUI, name: string, id = "left"): Promise<void> {
  await clear(ui);
  await ui.select(name, id);
  await ui.key("F5");
  await ui.wait(`!!(${job})`, "transfer enqueued");
}
async function conflict(ui: ElectronUI, action: string): Promise<void> {
  await ui.wait("document.querySelector('[role=dialog]')?.innerText.includes('already exists')", "conflict prompt", 20000);
  await ui.button(action);
}
async function terminal(ui: ElectronUI, state = "Completed", timeout = 90000): Promise<void> {
  await ui.wait(`!!(${job})?.querySelector('[aria-label="Remove transfer from list"]')`, "terminal transfer", timeout);
  const text = await ui.read<string>(`(${job}).firstElementChild.innerText`);
  if (state === "Failed") {
    assert.equal(await ui.read(`!!(${job}).querySelector('[aria-label="Retry transfer"]')`), true);
    assert.doesNotMatch(text, /Completed|Canceled/);
    assert.match(text, /Permission denied|Access.*denied|Source changed|550/i);
  } else assert.match(text, new RegExp(state));
}
async function retry(ui: ElectronUI): Promise<void> {
  await ui.button("Retry transfer");
  await ui.wait(
    `!!document.querySelector('[role=dialog]') || !(${job}).querySelector('[aria-label="Retry transfer"]')`,
    "retry starts",
  );
  // Existing destination is deliberately retained by failed/canceled replacement tests.
  await conflict(ui, "Replace");
  await terminal(ui);
}
async function noStages(dir: string): Promise<void> {
  async function hasStage(path: string): Promise<boolean> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name.endsWith(".pallet-part")) return true;
      if (entry.isDirectory() && (await hasStage(join(path, entry.name)))) return true;
    }
    return false;
  }
  await until(async () => !(await hasStage(dir)), "eventual staging cleanup", 15000);
}
async function large(path: string): Promise<void> {
  await writeFile(path, "");
  await truncate(path, 128 * 1024 * 1024);
  const file = await open(path, "r+");
  try {
    for (const mib of [0, 32, 64, 127]) await file.write(randomBytes(1024 * 1024), 0, 1024 * 1024, mib * 1024 * 1024);
  } finally {
    await file.close();
  }
}
async function inFlight(ui: ElectronUI, dir: string): Promise<void> {
  await ui.wait(`!!(${job})?.querySelector('[aria-label="Pause transfer"]')`, "running transfer");
  await until(
    async () => {
      const names = (await readdir(dir)).filter((n) => n.endsWith(".pallet-part"));
      return (await Promise.all(names.map((n) => stat(join(dir, n))))).some((s) => s.size > 0);
    },
    "real bytes in destination staging",
    20000,
  );
}
async function nativeFavorite(ui: ElectronUI, name: string, action: string): Promise<void> {
  ui.native("get name");
  await ui.click(favorite(name), 1, 0, "right");
  // Native menu accessibility, scoped to the owned Electron PID. No IPC or fabricated menu results.
  execFileSync("swift", ["test-server/ui/native-menu.swift", String(ui.child!.pid), action], { stdio: "pipe", timeout: 30000 });
}
export function integrationCases(root: string, s: Servers): Case[] {
  const source = join(root, "source");
  const download = join(root, "download");
  const cases: Case[] = [
    [
      "SFTP trust reject/accept, wrong password correction, persistence, changed keys",
      async (ui) => {
        await mkdir(source);
        await mkdir(download);
        await ui.go(source);
        await ui.key("k", 4);
        await form(ui, s, "sftp");
        await ui.button("Connect");
        await ui.wait("document.body.innerText.includes('Unknown Host')");
        await ui.button("Cancel", "[...document.querySelectorAll('[role=dialog]')].at(-1)");
        await ui.wait("!!document.querySelector('[role=dialog] [role=alert]')");
        assert.equal(await ui.read(connected()), false);
        await ui.button("Connect");
        await ui.wait("document.body.innerText.includes('Unknown Host')");
        await ui.button("Trust");
        await finishConnect(ui);
        await disconnect(ui);
        await ui.key("k", 4);
        await form(ui, s, "sftp");
        await ui.fill(field("Password"), "incorrect synthetic password");
        await ui.button("Connect");
        await ui.wait("!!document.querySelector('[role=dialog] [role=alert]')", "authentication rejected", 20000);
        assert.equal(await ui.read(connected()), false);
        await ui.fill(field("Password"), s.password);
        await ui.button("Connect");
        await finishConnect(ui);
        await ui.close();
        await ui.start();
        // connect() would accept Unknown Host; this check intentionally must not.
        await ui.key("k", 4);
        await form(ui, s, "sftp");
        await ui.button("Connect");
        await finishConnect(ui);
        await disconnect(ui);
        await s.rotateHostKey();
        await ui.key("k", 4);
        await form(ui, s, "sftp");
        await ui.button("Connect");
        await ui.wait("document.body.innerText.includes('Host Key Changed')");
        await ui.button("Cancel", "[...document.querySelectorAll('[role=dialog]')].at(-1)");
        await ui.wait("!!document.querySelector('[role=dialog] [role=alert]')");
        assert.equal(await ui.read(connected()), false);
        await ui.button("Connect");
        await ui.wait("document.body.innerText.includes('Host Key Changed')");
        await ui.button("Trust New Key");
        await finishConnect(ui);
      },
    ],
    [
      "private-key and isolated-agent authentication; FTPS reject and explicit override",
      async (ui) => {
        await connect(ui, s, "sftp", "right", "key");
        await connect(ui, s, "sftp", "right", "agent");
        await disconnect(ui);
        await ui.key("k", 4);
        await form(ui, s, "ftps");
        assert.equal(
          await ui.read<string>(
            "document.querySelector('[role=checkbox][aria-label=\"Verify TLS certificate\"]').getAttribute('aria-checked')",
          ),
          "true",
        );
        await ui.button("Connect");
        await ui.wait("!!document.querySelector('[role=dialog] [role=alert]')", "untrusted certificate rejected", 20000);
        assert.equal(await ui.read(connected()), false);
        await ui.click("document.querySelector('[role=checkbox][aria-label=\"Verify TLS certificate\"]')");
        await ui.button("Connect");
        await finishConnect(ui);
      },
    ],
    [
      "favorite create, native edit, encrypted storage, restart reconnect and delete",
      async (ui) => {
        await disconnect(ui);
        await ui.key("k", 4);
        await form(ui, s, "sftp");
        await ui.button("Add to Favorites");
        const initial = "pallet@127.0.0.1";
        await ui.wait(`!!(${favorite(initial)})`);
        await ui.key("Escape");
        await nativeFavorite(ui, initial, "Edit…");
        await ui.fill(field("Name"), "Owned UI favorite");
        await ui.button("Save");
        await ui.wait("!document.querySelector('[role=dialog]')");
        await ui.wait(`!!(${favorite("Owned UI favorite")})`);
        const secrets = await readdir(join(ui.profile, "secrets"));
        assert.equal(secrets.length, 1);
        assert.equal((await stat(join(ui.profile, "secrets", secrets[0]))).mode & 0o777, 0o600);
        // Independent raw-byte checks include database/WAL and encrypted blobs, while the app is open.
        for (const name of (await readdir(ui.profile)).filter((n) => n.startsWith("pallet.db")))
          assert.equal((await readFile(join(ui.profile, name))).includes(Buffer.from(s.password)), false);
        assert.equal((await readFile(join(ui.profile, "secrets", secrets[0]))).includes(Buffer.from(s.password)), false);
        await ui.close();
        await ui.start();
        await ui.click(favorite("Owned UI favorite"));
        await finishConnect(ui);
        await disconnect(ui);
        await nativeFavorite(ui, "Owned UI favorite", "Delete");
        await ui.wait(`!(${favorite("Owned UI favorite")})`);
        await until(async () => (await readdir(join(ui.profile, "secrets"))).length === 0, "favorite secret deleted");
        await ui.close();
        await ui.start();
        assert.equal(await ui.read(`!!(${favorite("Owned UI favorite")})`), false);
      },
    ],
    [
      "remote recursive sizes exclude directory metadata",
      async (ui) => {
        await connect(ui, s, "sftp");
        await ui.settings();
        for (const id of ["pref-folder-sizes", "pref-remote-folder-sizes"]) {
          await ui.click(`document.querySelector('label[for="${id}"]')`);
          await ui.wait(
            `(document.getElementById('${id}').checked===true || document.getElementById('${id}').getAttribute('aria-checked')==='true')`,
          );
        }
        await ui.button("Transfers");
        await ui.click("document.querySelector('label[for=\"pref-verify-copied-files\"]')");
        await ui.wait(
          "document.getElementById('pref-verify-copied-files').checked===true || document.getElementById('pref-verify-copied-files').getAttribute('aria-checked')==='true'",
        );
        await ui.key("Escape");
        await writeFile(join(source, "narrow.txt"), "narrow");
        await ui.go(source);
        await ui.select("sized", "right");
        await ui.key("i", 4);
        await ui.wait(
          "document.querySelector('[aria-label=\"Close inspector\"]').closest('aside').innerText.includes('14 bytes')",
          "remote 14 bytes",
        );
        await ui.call("Emulation.setDeviceMetricsOverride", { width: 820, height: 760, deviceScaleFactor: 1, mobile: false });
        for (const id of ["left", "right"])
          await ui.wait(
            `${pane(id)}.querySelector('[role=gridcell]').getBoundingClientRect().width>80`,
            "visible filename beside inspector",
          );
        await ui.button("Close inspector");
        await ui.call("Emulation.clearDeviceMetricsOverride");
      },
    ],
  ];
  for (const p of protocols) {
    const remote = s.path(p);
    cases.push([
      `${p}: upload/download hashes, conflicts, empty/nested/Unicode and batch`,
      async (ui) => {
        await connect(ui, s, p);
        await ui.go(source);
        const name = `roundtrip-${p}.txt`;
        await writeFile(join(source, name), `original ${p}`);
        await ui.button("Refresh");
        await copy(ui, name);
        await terminal(ui);
        assert.equal(await hash(join(remote, name)), await hash(join(source, name)));
        const target = join(download, p);
        await mkdir(target);
        await ui.go(target);
        await copy(ui, name, "right");
        await terminal(ui);
        assert.equal(await hash(join(target, name)), await hash(join(source, name)));
        await ui.go(source);
        await writeFile(join(source, name), `replacement ${p}`);
        await copy(ui, name);
        await conflict(ui, "Skip");
        await terminal(ui);
        assert.equal(await readFile(join(remote, name), "utf8"), `original ${p}`);
        await copy(ui, name);
        await conflict(ui, "Replace");
        await terminal(ui);
        assert.equal(await hash(join(remote, name)), await hash(join(source, name)));
        await writeFile(join(source, name), `both ${p}`);
        await copy(ui, name);
        await conflict(ui, "Keep Both");
        await terminal(ui);
        assert.equal(await readFile(join(remote, name), "utf8"), `replacement ${p}`);
        assert.equal(await hash(join(remote, `roundtrip-${p} (2).txt`)), await hash(join(source, name)));
        const batch = join(source, `batch-${p}`);
        await mkdir(join(batch, "nested", "empty"), { recursive: true });
        await writeFile(join(batch, "empty"), "");
        await writeFile(join(batch, "quote' space ü.txt"), "unicode\n");
        await writeFile(join(batch, "nested", "child"), "child\n");
        for (let i = 0; i < 40; i++) await writeFile(join(batch, `item${i}.txt`), `item ${i}`);
        // Select All exercises a multiple-item queue, not just one recursive source folder.
        await ui.go(batch);
        await clear(ui);
        await ui.key("a", 4);
        await ui.key("F5");
        await terminal(ui);
        const expected = await tree(batch);
        const actual = await tree(remote);
        for (const [path, value] of Object.entries(expected)) assert.equal(actual[path], value, `${p}: ${path}`);
        const batchDownload = join(download, `batch-${p}`);
        await mkdir(batchDownload);
        await ui.go(batchDownload);
        // Download the nested folder through the remote UI, independently checking empty directories.
        await copy(ui, "nested", "right");
        await terminal(ui);
        assert.deepEqual(await tree(join(batchDownload, "nested")), await tree(join(batch, "nested")));
        await noStages(remote);
      },
    ]);
    cases.push([
      `${p}: pause/resume, cancel/retry, safe replacement and cleanup`,
      async (ui) => {
        await connect(ui, s, p);
        await ui.go(source);
        const name = `controls-${p}.bin`;
        const local = join(source, name);
        const dest = join(remote, name);
        await large(local);
        await writeFile(dest, "original destination");
        await chmod(dest, 0o666);
        await ui.button("Refresh");
        await copy(ui, name);
        await conflict(ui, "Replace");
        await inFlight(ui, remote);
        await ui.button("Pause transfer");
        await ui.wait(`!!(${button("Resume transfer")})`, "paused");
        assert.equal(await readFile(dest, "utf8"), "original destination");
        const progress = await ui.read<number[]>(
          "[...document.querySelectorAll('[role=progressbar]')].map(e=>Number(e.getAttribute('aria-valuenow')))",
        );
        assert.ok(progress.length && progress.every((n) => n >= 0 && n <= 100));
        await ui.button("Resume transfer");
        await terminal(ui);
        assert.equal(await hash(dest), await hash(local));
        await writeFile(dest, "preserved on cancel");
        await chmod(dest, 0o666);
        await copy(ui, name);
        await conflict(ui, "Replace");
        await inFlight(ui, remote);
        await ui.button("Cancel transfer");
        await terminal(ui, "Canceled");
        await noStages(remote);
        assert.equal(await readFile(dest, "utf8"), "preserved on cancel");
        await retry(ui);
        assert.equal(await hash(dest), await hash(local));
        await noStages(remote);
      },
    ]);
    cases.push([
      `${p}: permission failure then successful retry; real server restart recovery`,
      async (ui) => {
        await connect(ui, s, p);
        const dir = join(remote, "denied");
        await mkdir(dir);
        await writeFile(join(dir, "permission.txt"), "old");
        await chmod(dir, 0o555);
        const input = join(source, "permission.txt");
        await writeFile(input, `permission ${p}`);
        try {
          await ui.go(`${s.remote(p)}/denied`.replace("//", "/"), "right");
          await ui.go(source);
          await copy(ui, "permission.txt");
          await conflict(ui, "Replace");
          await terminal(ui, "Failed");
          assert.equal(await readFile(join(dir, "permission.txt"), "utf8"), "old");
          await noStages(dir);
          await chmod(dir, 0o777);
          await retry(ui);
          assert.equal(await hash(join(dir, "permission.txt")), await hash(input));
        } finally {
          await chmod(dir, 0o777);
        }
        await ui.go(s.remote(p), "right");
        const name = `restart-${p}.bin`;
        await large(join(source, name));
        await ui.go(source);
        await copy(ui, name);
        await inFlight(ui, remote);
        s.docker(["stop", "-t", "0", s.containers.get(p)!]);
        // The container is genuinely stopped. Verify that before bringing back this same fixture.
        assert.equal(s.docker(["inspect", "--format", "{{.State.Running}}", s.containers.get(p)!]).trim(), "false");
        s.docker(["start", s.containers.get(p)!]);
        await s.ready(p);
        await terminal(ui, "Completed", 120000);
        assert.equal(await hash(join(remote, name)), await hash(join(source, name)));
        await noStages(remote);
      },
    ]);
  }
  for (const p of protocols) {
    cases.push([
      `${p}: source mutation while paused preserves original; retry rescans source`,
      async (ui) => {
        await connect(ui, s, p);
        await ui.go(source);
        const name = `changed-${p}.bin`;
        const local = join(source, name);
        const dest = join(s.path(p), name);
        await large(local);
        await writeFile(dest, "old consistent bytes");
        await chmod(dest, 0o666);
        await ui.button("Refresh");
        await copy(ui, name);
        await conflict(ui, "Replace");
        await inFlight(ui, s.path(p));
        await ui.button("Pause transfer");
        await ui.wait(`!!(${button("Resume transfer")})`);
        await appendFile(local, "changed source");
        await ui.button("Resume transfer");
        await terminal(ui, "Failed");
        assert.match(await ui.read<string>(`(${job}).innerText`), /Source changed/);
        assert.equal(await readFile(dest, "utf8"), "old consistent bytes");
        await noStages(s.path(p));
        await retry(ui);
        assert.equal(await hash(dest), await hash(local));
      },
    ]);
    cases.push([
      `${p}: per-item pause/resume/cancel leaves other items running`,
      async (ui) => {
        await connect(ui, s, p);
        const dir = join(root, `items-${p}`);
        await mkdir(dir);
        for (const name of ["item-a.bin", "item-b.bin"]) await large(join(dir, name));
        await ui.go(dir);
        await clear(ui);
        await ui.key("a", 4);
        await ui.key("F5");
        await ui.button("Pause item-a.bin");
        await ui.wait(`!!(${button("Resume item-a.bin")})`);
        await until(
          async () =>
            stat(join(s.path(p), "item-b.bin")).then(
              () => true,
              () => false,
            ),
          "second item completes while first paused",
          90000,
        );
        assert.equal(await hash(join(dir, "item-b.bin")), await hash(join(s.path(p), "item-b.bin")));
        await ui.button("Resume item-a.bin");
        await terminal(ui);
        assert.equal(await hash(join(dir, "item-a.bin")), await hash(join(s.path(p), "item-a.bin")));
        const more = join(root, `cancel-items-${p}`);
        await mkdir(more);
        for (const name of ["cancel-a.bin", "cancel-b.bin"]) await large(join(more, name));
        await ui.go(more);
        await clear(ui);
        await ui.key("a", 4);
        await ui.key("F5");
        await ui.button("Cancel cancel-a.bin");
        await terminal(ui);
        assert.equal(await hash(join(more, "cancel-b.bin")), await hash(join(s.path(p), "cancel-b.bin")));
        await noStages(s.path(p));
        assert.equal((await readdir(s.path(p))).includes("cancel-a.bin"), false);
      },
    ]);
  }
  cases.push([
    "SHA-256 read-back progress stays active before replacement",
    async (ui) => {
      await connect(ui, s, "sftp");
      const dir = join(root, "verification");
      await mkdir(dir);
      await large(join(dir, "verified.bin"));
      await writeFile(join(s.path("sftp"), "verified.bin"), "original");
      await ui.go(dir);
      s.exec("sftp", ["tc", "qdisc", "replace", "dev", "eth0", "root", "netem", "delay", "40ms"]);
      try {
        await copy(ui, "verified.bin");
        await conflict(ui, "Replace");
        await ui.wait(
          "document.querySelector('[aria-label=\"Transfer queue\"]').innerText.includes('Verifying…')",
          "visible SHA-256 phase",
          60000,
        );
        assert.equal(await readFile(join(s.path("sftp"), "verified.bin"), "utf8"), "original");
        await ui.wait(
          "document.querySelector('[aria-label=\"Transfer queue\"]').innerText.includes('checked')",
          "separate bytes checked",
        );
        await terminal(ui);
        assert.equal(await hash(join(dir, "verified.bin")), await hash(join(s.path("sftp"), "verified.bin")));
      } finally {
        s.exec("sftp", ["tc", "qdisc", "del", "dev", "eth0", "root"]);
      }
    },
  ]);
  cases.push([
    "SFTP-to-FTP copy, Keep Both, cancellation, retry and pane restoration",
    async (ui) => {
      await connect(ui, s, "ftp");
      await ui.go(source);
      await connect(ui, s, "sftp", "left");
      const name = "remote-copy.bin";
      await large(join(s.path("sftp"), name));
      await ui.go(s.remote("sftp"), "left");
      await copy(ui, name);
      await terminal(ui);
      assert.equal(await hash(join(s.path("sftp"), name)), await hash(join(s.path("ftp"), name)));
      const originalHash = await hash(join(s.path("ftp"), name));
      await appendFile(join(s.path("sftp"), name), "new remote source version");
      await ui.button("Refresh");
      await copy(ui, name);
      await conflict(ui, "Keep Both");
      await terminal(ui);
      assert.equal(await hash(join(s.path("sftp"), name)), await hash(join(s.path("ftp"), "remote-copy (2).bin")));
      assert.equal(await hash(join(s.path("ftp"), name)), originalHash);
      await writeFile(join(s.path("ftp"), name), "remote original");
      await chmod(join(s.path("ftp"), name), 0o666);
      await copy(ui, name);
      await conflict(ui, "Replace");
      await inFlight(ui, s.path("ftp"));
      await ui.button("Cancel transfer");
      await terminal(ui, "Canceled");
      await noStages(s.path("ftp"));
      assert.equal(await readFile(join(s.path("ftp"), name), "utf8"), "remote original");
      await retry(ui);
      assert.equal(await hash(join(s.path("sftp"), name)), await hash(join(s.path("ftp"), name)));
      await ui.button("Restore Local Pane");
      await ui.wait(`!(${connected("left")}) && ${connected()}`);
      await ui.wait(`${grid()}.getAttribute('aria-label')==='Local files'`);
    },
  ]);
  cases.push([
    "disconnect and local-pane restoration discard pending remote listings",
    async (ui) => {
      async function delayed(id: string): Promise<void> {
        s.exec("sftp", ["tc", "qdisc", "replace", "dev", "eth0", "root", "netem", "delay", "1500ms"]);
        try {
          await ui.click(grid(id));
          await ui.button("Refresh");
          await ui.wait(`!!${pane(id)}?.querySelector('.animate-spin')`, "listing is pending");
          if (id === "left") await ui.button("Restore Local Pane");
          else await ui.button("Disconnect", pane(id));
          await ui.wait(`!(${connected(id)})`, "remote backend removed");
          // Assert throughout the response window, rather than treating an immediate removal as success.
          const deadline = Date.now() + 4500;
          await until(
            async () => {
              assert.equal(await ui.read(connected(id)), false, "stale response recreated a remote pane");
              if (id === "left") assert.equal(await ui.read<string>(`${grid(id)}.getAttribute('aria-label')`), "Local files");
              return Date.now() >= deadline;
            },
            "late response observation window",
            7000,
          );
        } finally {
          s.exec("sftp", ["tc", "qdisc", "del", "dev", "eth0", "root"]);
        }
      }
      await connect(ui, s, "sftp");
      await delayed("right");
      await connect(ui, s, "ftp");
      await ui.go(source);
      await connect(ui, s, "sftp", "left");
      await delayed("left");
      assert.equal(await ui.read(connected()), true);
    },
  ]);
  return cases;
}
