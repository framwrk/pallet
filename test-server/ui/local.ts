import { type ElectronUI, button, dialogInput, grid, pane, row, until } from "./electron";
import { cp, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";

export type Case = [string, (ui: ElectronUI) => Promise<void>];
const names = `[...document.querySelectorAll('[data-pane="left"] [role="row"]')].map(e=>e.querySelector('[role="gridcell"]').textContent.trim())`;
const selected = `document.querySelectorAll('[data-pane="left"] [aria-selected="true"]').length`;
export function localCases(root: string): Case[] {
  const files = join(root, "files");
  return [
    [
      "navigation, correction, history, breadcrumbs, refresh",
      async (ui) => {
        await mkdir(join(files, "child"), { recursive: true });
        await writeFile(join(files, "file1.txt"), "one");
        await ui.go(files);
        await ui.key("g", 12);
        await ui.fill(dialogInput, join(files, "missing"));
        await ui.button("Go");
        await ui.wait("!!document.querySelector('[role=dialog] [role=alert]')");
        assert.equal(await ui.read<string>(`${dialogInput}.value`), join(files, "missing"));
        await ui.fill(dialogInput, join(files, "child"));
        await ui.button("Go");
        await ui.wait("!document.querySelector('[role=dialog]')");
        await ui.button("Back");
        await ui.wait(`!!(${row("file1.txt")})`);
        await ui.button("Forward");
        await ui.wait(`${grid()}.getAttribute('aria-rowcount')==='0'`);
        await ui.button("files", pane());
        await ui.wait(`!!(${row("file1.txt")})`);
        await writeFile(join(files, "refreshed.txt"), "new");
        await ui.button("Refresh");
        await ui.wait(`!!(${row("refreshed.txt")})`);
      },
    ],
    [
      "natural sorting, folders first, all columns both directions, selection",
      async (ui) => {
        const dir = join(root, "sort");
        await mkdir(dir);
        for (const [name, size, time] of [
          ["file1.txt", 1, 2000],
          ["file2.txt", 2, 1000],
          ["file10.txt", 10, 3000],
        ] as const) {
          await writeFile(join(dir, name), Buffer.alloc(size));
          await utimes(join(dir, name), time, time);
        }
        for (const [name, time] of [
          ["folderA", 1000],
          ["folderZ", 3000],
        ] as const) {
          await mkdir(join(dir, name));
          await utimes(join(dir, name), time, time);
        }
        await ui.go(dir);
        for (const [column, asc, desc] of [
          ["Name", ["file1.txt", "file2.txt", "file10.txt"], ["file10.txt", "file2.txt", "file1.txt"]],
          ["Size", ["file1.txt", "file2.txt", "file10.txt"], ["file10.txt", "file2.txt", "file1.txt"]],
          ["Date Modified", ["file2.txt", "file1.txt", "file10.txt"], ["file10.txt", "file1.txt", "file2.txt"]],
        ] as const) {
          for (const [direction, expected] of [
            ["ascending", ["folderA", "folderZ", ...asc]],
            ["descending", ["folderZ", "folderA", ...desc]],
          ] as const) {
            const header = `${pane()}.querySelector('[aria-label^="Sort by ${column}"]')`;
            for (
              let i = 0;
              i < 2 && !(await ui.read(`${header}.getAttribute('aria-label').includes('currently ${direction}')`));
              i++
            )
              await ui.click(header);
            await ui.wait(
              `JSON.stringify(${names})===${JSON.stringify(JSON.stringify(expected))}`,
              `${column} ${direction} ordering`,
            );
          }
        }
        await ui.click(`${pane()}.querySelector('[aria-label^="Sort by Name"]')`);
        await ui.select("file1.txt");
        assert.equal(await ui.read<number>(selected), 1);
        await ui.select("file10.txt", "left", 4);
        assert.equal(await ui.read<number>(selected), 2);
        await ui.select("file1.txt");
        await ui.select("file10.txt", "left", 8);
        assert.equal(await ui.read<number>(selected), 3);
        await ui.key("a", 4);
        await ui.wait(`${selected}===5`);
        await ui.key("Escape");
        await ui.wait(`${selected}===0`);
      },
    ],
    [
      "hidden files, new-folder focus, rename and collision safety, dialog isolation",
      async (ui) => {
        await ui.go(files);
        await writeFile(join(files, ".hidden"), "hidden");
        await ui.button("Refresh");
        assert.equal(await ui.read(`!!(${row(".hidden")})`), false);
        await ui.key(".", 12);
        await ui.wait(`!!(${row(".hidden")})`);
        await ui.key(".", 12);
        await ui.wait(`!(${row(".hidden")})`);
        await ui.button("New Folder");
        const input = `${pane()}.querySelector('input')`;
        await ui.wait(`!!(${input}) && document.activeElement===(${input})`, "new folder retains rename focus");
        const focusDeadline = Date.now() + 300;
        await until(
          async () => {
            assert.equal(await ui.read(`document.activeElement===(${input})`), true, "rename field lost focus");
            return Date.now() >= focusDeadline;
          },
          "rename focus remains stable",
          1500,
        );
        await ui.call("Input.insertText", { text: "named folder" });
        await ui.key("Enter");
        await until(async () => (await readdir(files)).includes("named folder"), "folder renamed on disk");
        await ui.select("file1.txt");
        await ui.key("Enter");
        await ui.fill(input, "renamed.txt");
        await ui.key("Enter");
        await ui.wait(`!!(${row("renamed.txt")})`);
        await ui.select("renamed.txt");
        await ui.key("Enter");
        await ui.fill(input, "refreshed.txt");
        await ui.key("Enter");
        await ui.wait("document.body.innerText.includes('already exists')");
        assert.equal(await readFile(join(files, "renamed.txt"), "utf8"), "one");
        assert.equal(await readFile(join(files, "refreshed.txt"), "utf8"), "new");
        const before = (await readdir(files)).sort();
        const jobs = await ui.read<number>("document.querySelectorAll('#transfer-drawer-jobs > [role=listitem]').length");
        await ui.select("renamed.txt");
        await ui.key("g", 12);
        await ui.fill(dialogInput, "isolated input");
        await ui.key("a", 4, ["selectAll"]);
        await ui.key("Backspace", 4);
        await ui.key("F5");
        await ui.key("n", 12);
        assert.equal(await ui.read("!!document.querySelector('[role=dialog]')"), true);
        await ui.key("Escape");
        assert.deepEqual((await readdir(files)).sort(), before);
        assert.equal(
          await ui.read<number>("document.querySelectorAll('#transfer-drawer-jobs > [role=listitem]').length"),
          jobs,
        );
      },
    ],
    [
      "inspector empty, text, image and filenames in narrow panes",
      async (ui) => {
        await cp("src/renderer/src/assets/pallet-icon.png", join(files, "preview.png"));
        await ui.go(files);
        await ui.key("Escape");
        await ui.key("i", 4);
        const info = "document.querySelector('[aria-label=" + '"Close inspector"' + "]').closest('aside')";
        await ui.wait(`(${info}).innerText.includes('No selection')`);
        await ui.select("renamed.txt");
        await ui.wait("document.querySelector('pre')?.innerText==='one'");
        await ui.select("preview.png");
        await ui.wait("document.querySelector('img[alt=\"preview.png\"]')?.naturalWidth>0");
        await ui.call("Emulation.setDeviceMetricsOverride", { width: 820, height: 760, deviceScaleFactor: 1, mobile: false });
        await ui.wait(`${pane()}.querySelector('[role=gridcell]').getBoundingClientRect().width>80`, "visible narrow filename");
        await ui.button("Close inspector");
        await ui.call("Emulation.clearDeviceMetricsOverride");
      },
    ],
    [
      "10,000 files: bounded rows, real wheel scrolling and keyboard selection",
      async (ui) => {
        const large = join(root, "large");
        await mkdir(large);
        for (let start = 0; start < 10000; start += 100)
          await Promise.all(
            Array.from({ length: 100 }, (_, i) =>
              writeFile(join(large, `entry-${String(start + i).padStart(5, "0")}.txt`), ""),
            ),
          );
        await ui.go(large);
        await ui.wait(`${grid()}.getAttribute('aria-rowcount')==='10000'`);
        assert.ok((await ui.read<number>(`${pane()}.querySelectorAll('[role=row]').length`)) < 100);
        const rect = await ui.read<{ x: number; y: number }>(
          `(()=>{const r=${grid()}.getBoundingClientRect();return {x:r.x+30,y:r.y+30}})()`,
        );
        await ui.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...rect, deltaX: 0, deltaY: 1000000 });
        await ui.wait(`!!(${row("entry-09999.txt")})`);
        await ui.select("entry-09999.txt");
        await ui.key("ArrowUp");
        await ui.wait(`(${row("entry-09998.txt")})?.getAttribute('aria-selected')==='true'`);
        assert.ok((await ui.read<number>(`${pane()}.querySelectorAll('[role=row]').length`)) < 100);
      },
    ],
  ];
}

export function settingsCases(root: string): Case[] {
  return [
    [
      "native Settings: persistence through full restart and recursive folder bytes",
      async (ui) => {
        const dir = join(root, "sizes");
        await mkdir(join(dir, "nested", "empty"), { recursive: true });
        await writeFile(join(dir, "nested", "a.txt"), "123456");
        await writeFile(join(dir, "nested", "empty", "b.txt"), "12345678");
        await writeFile(join(dir, ".hidden"), "hidden");
        await ui.go(dir);
        await ui.settings();
        for (const id of ["pref-show-hidden", "pref-folder-sizes", "pref-remote-folder-sizes"]) {
          await ui.click(`document.querySelector('label[for="${id}"]')`);
          await ui.wait(
            `(document.getElementById('${id}').checked===true || document.getElementById('${id}').getAttribute('aria-checked')==='true')`,
          );
        }
        await ui.button("Transfers");
        await ui.click(`document.querySelector('label[for="pref-verify-copied-files"]')`);
        await ui.wait(
          "document.getElementById('pref-verify-copied-files').checked===true || document.getElementById('pref-verify-copied-files').getAttribute('aria-checked')==='true'",
        );
        await ui.button("Appearance");
        await ui.click("document.getElementById('pref-appearance')");
        await ui.click("[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()==='Dark')");
        await ui.click("document.getElementById('pref-row-density')");
        await ui.click("[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()==='Comfortable')");
        await ui.key("Escape");
        await ui.wait("!document.querySelector('[role=dialog]')");
        await ui.close();
        await ui.start();
        await ui.settings();
        for (const id of ["pref-show-hidden", "pref-folder-sizes", "pref-remote-folder-sizes"])
          assert.equal(
            await ui.read(
              `document.getElementById('${id}').checked===true || document.getElementById('${id}').getAttribute('aria-checked')==='true'`,
            ),
            true,
          );
        await ui.button("Transfers");
        assert.equal(
          await ui.read(
            "document.getElementById('pref-verify-copied-files').checked===true || document.getElementById('pref-verify-copied-files').getAttribute('aria-checked')==='true'",
          ),
          true,
        );
        await ui.button("Appearance");
        assert.match(await ui.read<string>("document.getElementById('pref-appearance').innerText"), /Dark/);
        assert.match(await ui.read<string>("document.getElementById('pref-row-density').innerText"), /Comfortable/);
        await ui.key("Escape");
        await ui.go(dir);
        await ui.wait(`!!(${row(".hidden")})`);
        await ui.select("nested");
        await ui.key("i", 4);
        await ui.wait(
          "document.querySelector('[aria-label=\"Close inspector\"]').closest('aside').innerText.includes('14 bytes')",
          "14 recursive content bytes",
        );
        await ui.button("Close inspector");
        assert.ok(await ui.read(`!!(${button("Get Info (⌘I)")})`));
      },
    ],
  ];
}
