import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

let interruption: Error | undefined;
export function interrupt(signal: string): void {
  interruption = new Error(`Interrupted by ${signal}`);
}
export function checkInterrupted(): void {
  if (interruption) throw interruption;
}
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export async function until(
  check: () => Promise<unknown>,
  description: string,
  timeout = 10000,
  interruptible = true,
): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (interruptible) checkInterrupted();
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Deadline exceeded: ${description}`);
}
export async function stop(child?: ChildProcess): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await until(async () => child.exitCode !== null || child.signalCode !== null, "process exit", 5000, false);
  } catch {
    child.kill("SIGKILL");
    await until(async () => child.exitCode !== null || child.signalCode !== null, "forced process exit", 5000, false);
  }
}
export const pane = (id = "left"): string => `document.querySelector('[data-pane="${id}"]')`;
export const grid = (id = "left"): string => `${pane(id)}?.querySelector('[role="grid"]')`;
export const row = (name: string, id = "left"): string =>
  `[...document.querySelectorAll('[data-pane="${id}"] [role="row"]')].find(e=>e.querySelector('[role="gridcell"]')?.textContent.trim()===${JSON.stringify(name)})`;
export const button = (label: string, scope = "document"): string =>
  `[...(${scope}).querySelectorAll('button')].find(e=>e.getBoundingClientRect().width && getComputedStyle(e).visibility==='visible' && (e.getAttribute('aria-label')===${JSON.stringify(label)} || e.innerText.trim()===${JSON.stringify(label)}))`;
export const field = (label: string): string =>
  `[...document.querySelectorAll('label')].find(e=>e.getBoundingClientRect().width && e.querySelector('span')?.textContent.trim()===${JSON.stringify(label)})?.querySelector('input')`;
export const dialogInput = "document.querySelector('[role=dialog] input')";

interface Reply {
  result?: { value?: unknown; objectId?: string };
  exceptionDetails?: unknown;
  data?: string;
}

/** CDP is transport only: actions use Input/DOM, Runtime evaluates read-only DOM assertions. */
export class ElectronUI {
  child?: ChildProcess;
  socket?: WebSocket;
  log = "";
  lastAction = "startup";
  private nextId = 0;
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  constructor(
    readonly root: string,
    readonly env: NodeJS.ProcessEnv = { ...process.env, SSH_AUTH_SOCK: join(root, "no-user-agent") },
  ) {}
  get profile(): string {
    return join(this.root, "profile");
  }
  async start(): Promise<void> {
    assert.equal(process.platform, "darwin", "UI suite requires macOS and a logged-in desktop");
    await readFile("out/main/index.js").catch(() => {
      throw new Error("Missing build: run bun run build first");
    });
    const env = { ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    this.log = "";
    this.child = spawn(
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      [".", `--user-data-dir=${this.profile}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let error: Error | undefined;
    this.child.on("error", (e) => {
      error = e;
    });
    for (const stream of [this.child.stdout, this.child.stderr])
      stream?.on("data", (b) => {
        this.log = (this.log + b).slice(-32000);
      });
    await until(async () => {
      if (error) throw error;
      if (this.child!.exitCode !== null) throw new Error("Electron exited before startup");
      return /DevTools listening on ws:\/\/127.0.0.1:(\d+)/.test(this.log);
    }, "Electron debugger");
    const port = this.log.match(/DevTools listening on ws:\/\/127.0.0.1:(\d+)/)![1];
    let target: { webSocketDebuggerUrl: string } | undefined;
    await until(async () => {
      const targets = (await (
        await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      ).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      target = targets.find((t) => t.type === "page" && t.url.startsWith("file:"));
      return target;
    }, "built renderer target");
    this.socket = new WebSocket(target!.webSocketDebuggerUrl);
    await until(async () => this.socket?.readyState === WebSocket.OPEN, "CDP socket");
    this.socket.addEventListener("message", (event) => {
      const m = JSON.parse(String(event.data)) as { id: number; result: Reply; error?: { message: string } };
      const request = this.pending.get(m.id);
      if (!request) return;
      this.pending.delete(m.id);
      if (m.error) request.reject(new Error(m.error.message));
      else request.resolve(m.result);
    });
    this.socket.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("Electron debugger closed"));
      this.pending.clear();
    });
    await this.wait(`!!${grid()} && !!${button("New Folder")}`, "Pallet ready");
  }
  call(method: string, params: object = {}): Promise<Reply> {
    checkInterrupted();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 5000);
      const finish = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      this.pending.set(id, { resolve: (r) => finish(() => resolve(r)), reject: (e) => finish(() => reject(e)) });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
  async read<T = boolean>(expression: string): Promise<T> {
    const result = await this.call("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`DOM observation failed: ${expression}`);
    return result.result?.value as T;
  }
  wait(expression: string, description = expression, timeout = 10000): Promise<void> {
    return until(() => this.read(expression), description, timeout);
  }
  async click(expression: string, count = 1, modifiers = 0, mouseButton = "left"): Promise<void> {
    this.lastAction = `click: ${expression}`;
    await this.wait(`!!(${expression})`, `control exists: ${expression}`);
    await this.wait(
      `(()=>{const e=(${expression});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0})()`,
      "control has layout",
    );
    const object = await this.call("Runtime.evaluate", { expression });
    assert.ok(object.result?.objectId, `Missing control: ${expression}`);
    await this.call("DOM.scrollIntoViewIfNeeded", { objectId: object.result.objectId });
    await this.call("Runtime.releaseObject", { objectId: object.result.objectId });
    // Wait for dialogs/rails to finish their CSS transition before taking the hit point.
    let previous = "";
    await until(async () => {
      const rect = await this.read<string>(
        `(()=>{const e=(${expression}); if(!e || e.disabled || getComputedStyle(e).visibility!=='visible')return '';const r=e.getBoundingClientRect();return r.width&&r.height&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))?JSON.stringify([r.x,r.y,r.width,r.height]):''})()`,
      );
      const stable = !!rect && rect === previous;
      previous = rect;
      return stable;
    }, `visible stable control: ${expression}`);
    const [x, y, w, h] = JSON.parse(previous) as number[];
    for (const type of ["mousePressed", "mouseReleased"])
      await this.call("Input.dispatchMouseEvent", {
        type,
        x: x + w / 2,
        y: y + h / 2,
        button: mouseButton,
        clickCount: count,
        modifiers,
      });
  }
  button(label: string, scope = "document"): Promise<void> {
    return this.click(button(label, scope));
  }
  async key(key: string, modifiers = 0, commands?: string[]): Promise<void> {
    this.lastAction = `key: ${key}`;
    const special: Record<string, [string, number]> = {
      Enter: ["Enter", 13],
      Escape: ["Escape", 27],
      Backspace: ["Backspace", 8],
      ArrowDown: ["ArrowDown", 40],
      ArrowUp: ["ArrowUp", 38],
      ".": ["Period", 190],
      ",": ["Comma", 188],
    };
    const [code, windowsVirtualKeyCode] =
      special[key] ??
      (/^F\d+$/.test(key) ? [key, 111 + Number(key.slice(1))] : [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)]);
    for (const type of ["keyDown", "keyUp"])
      await this.call("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        windowsVirtualKeyCode,
        modifiers,
        ...(commands && type === "keyDown" ? { commands } : {}),
      });
  }
  async fill(expression: string, text: string): Promise<void> {
    await this.click(expression, 3);
    await this.key("a", 4, ["selectAll"]);
    await this.call("Input.insertText", { text });
    await this.wait(`(${expression})?.value===${JSON.stringify(text)}`, "input accepted text");
  }
  async go(path: string, id = "left"): Promise<void> {
    await this.click(grid(id));
    await this.key("g", 12);
    await this.fill(dialogInput, path);
    await this.button("Go");
    await this.wait("!document.querySelector('[role=dialog]')", "Go to Folder closed");
    await this.wait(`!!${grid(id)} && !${pane(id)}.querySelector('.animate-spin')`, "directory loaded");
  }
  async select(name: string, id = "left", modifiers = 0): Promise<void> {
    if (!(await this.read(`!!(${row(name, id)})`))) {
      const point = await this.read<{ x: number; y: number }>(
        `(()=>{const r=${grid(id)}.getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()`,
      );
      const wheel = (deltaY: number): Promise<Reply> =>
        this.call("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
      await wheel(-1000000);
      await this.wait(`${grid(id)}.scrollTop===0`, "scroll to first rows");
      await until(async () => {
        if (await this.read(`!!(${row(name, id)})`)) return true;
        await wheel(300);
        return false;
      }, `scroll to ${name}`);
    }
    await this.click(row(name, id), 1, modifiers);
    await this.wait(`(${row(name, id)})?.getAttribute('aria-selected')==='true'`, `selected ${name}`);
  }
  native(script: string): string {
    return execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events"\ntell (first process whose unix id is ${this.child!.pid})\nset frontmost to true\n${script}\nend tell\nend tell`,
      ],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
    );
  }
  async settings(): Promise<void> {
    this.native('keystroke "," using command down');
    await this.wait("!!document.getElementById('pref-show-hidden')", "native Settings menu (requires Accessibility)");
  }
  async close(): Promise<void> {
    this.socket?.close();
    await stop(this.child);
  }
  async diagnostics(name: string, secrets: string[] = []): Promise<void> {
    const dest = resolve(".agents/artifacts/ui", `${Date.now()}-${name.replace(/[^a-z0-9-]/gi, "-")}`);
    await mkdir(dest, { recursive: true });
    const redact = (s: string): string => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), s);
    await writeFile(join(dest, "electron.txt"), redact(this.log));
    if (this.socket?.readyState === WebSocket.OPEN) {
      await writeFile(
        join(dest, "controls.json"),
        JSON.stringify(
          await this.read(
            "[...document.querySelectorAll('[id], [role=option]')].filter(e=>e.id?.startsWith('pref-') || e.getAttribute('role')==='option').map(e=>({tag:e.tagName,id:e.id,role:e.getAttribute('role'),checked:e.checked,rect:e.getBoundingClientRect().toJSON()}))",
          ),
          null,
          2,
        ),
      );
      await writeFile(join(dest, "ui.txt"), redact(await this.read<string>("document.body.innerText")));
      const shot = await this.call("Page.captureScreenshot");
      await writeFile(join(dest, "window.png"), Buffer.from(shot.data!, "base64"));
    }
    console.error(`Failure diagnostics: ${dest}`);
  }
}

export async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
