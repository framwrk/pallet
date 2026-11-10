import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

// Opt in to the real macOS window; ordinary offline tests need no display.
test.skipIf(process.platform !== "darwin" || process.env.PALLET_TEST_UI !== "1")(
  "folder creation retains rename focus and filenames stay visible beside the inspector",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pallet-focus-test-"));
    const fixture = await mkdtemp(join(tmpdir(), "pallet-focus-files-"));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = spawn(
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      [".", `--user-data-dir=${root}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let output = "";
    app.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    let socket: WebSocket | undefined;
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (check: () => Promise<boolean>, description: string): Promise<void> => {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        if (await check()) return;
        await delay(50);
      }
      throw new Error(description);
    };
    try {
      await until(async () => /DevTools listening/.test(output), "Electron did not start its debugger");
      const port = output.match(/ws:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const target = targets.find((item) => item.type === "page");
      if (!target) throw new Error("Electron did not open a page");
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket!.addEventListener("open", () => resolve(), { once: true });
        socket!.addEventListener("error", () => reject(new Error("Cannot attach to Electron")), { once: true });
      });
      let nextId = 0;
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id: number; result: unknown; error?: { message: string } };
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      });
      const call = (method: string, params: object = {}): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
          }, 5000);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          socket!.send(JSON.stringify({ id, method, params }));
        });
      const read = async <T>(expression: string): Promise<T> => {
        const value = (await call("Runtime.evaluate", { expression, returnByValue: true })) as {
          result: { value: T };
          exceptionDetails?: object;
        };
        if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
        return value.result.value;
      };
      const key = async (key: string, code: string, modifiers = 0, commands?: string[]): Promise<void> => {
        for (const type of ["keyDown", "keyUp"]) {
          await call("Input.dispatchKeyEvent", { type, key, code, modifiers, ...(commands ? { commands } : {}) });
        }
      };
      const click = async (expression: string, clickCount = 1): Promise<void> => {
        const point = await read<{ x: number; y: number }>(`(() => {
          const r = (${expression}).getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await call("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount });
        }
      };
      await until(() => read("!!document.querySelector('[aria-label=\"New Folder\"]')"), "Pallet did not render");
      await key("g", "KeyG", 12);
      await until(() => read("!!document.querySelector('[role=\"dialog\"] input')"), "Go to Folder did not open");
      await delay(250);
      await click("document.querySelector('[role=\"dialog\"] input')", 3);
      await key("a", "KeyA", 4, ["selectAll"]);
      await call("Input.insertText", { text: fixture });
      await click("[...document.querySelectorAll('button')].find(e => e.innerText === 'Go')");
      await until(() => read("!document.querySelector('[role=\"dialog\"]')"), "Fixture navigation did not finish");
      await click("document.querySelector('[aria-label=\"New Folder\"]')");
      await until(
        () => read("!!document.querySelector('[data-pane=\"left\"] input')"),
        "New folder rename field did not stay open",
      );
      await delay(500);
      expect(await read("document.activeElement === document.querySelector('[data-pane=\"left\"] input')")).toBe(true);
      await call("Input.insertText", { text: "named folder" });
      await key("Enter", "Enter");
      await until(async () => (await readdir(fixture)).includes("named folder"), "Typing did not rename the new folder");
      expect(await readdir(fixture)).toEqual(["named folder"]);
      await call("Emulation.setDeviceMetricsOverride", { width: 820, height: 760, deviceScaleFactor: 1, mobile: false });
      await key("i", "KeyI", 4);
      await until(() => read("!!document.querySelector('[aria-label=\"Close inspector\"]')"), "Inspector did not open");
      await delay(300);
      expect(
        await read<number>('document.querySelector(\'[data-pane="left"] [role="gridcell"]\').getBoundingClientRect().width'),
      ).toBeGreaterThan(80);
    } finally {
      socket?.close();
      if (app.exitCode === null) {
        app.kill("SIGTERM");
        for (let i = 0; i < 30 && app.exitCode === null; i++) await delay(100);
        if (app.exitCode === null) app.kill("SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  },
  30000,
);
