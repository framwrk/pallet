import { BrowserWindow, ipcMain } from "electron";
import { getPreferences, setPreferences } from "../services/prefs-store";
import type { IpcResult } from "@shared/ipc/ipc.types";
import { PrefChannels } from "@shared/ipc/ipc.constants";
import type { Preferences } from "@shared/prefs/prefs.types";

function handle<Args extends unknown[], T>(channel: string, fn: (...args: Args) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await fn(...(args as Args)) };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { ok: false, error: { code: e.code ?? "EUNKNOWN", message: e.message ?? String(err) } };
    }
  });
}

export function registerPrefHandlers(): void {
  handle(PrefChannels.get, () => getPreferences());
  handle(PrefChannels.set, (patch: Partial<Preferences>) => {
    const next = setPreferences(patch);
    // Broadcast to every window (sender included) so the main window and the
    // settings window stay in sync through one path.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(PrefChannels.changed, next);
    }
    return next;
  });
}
