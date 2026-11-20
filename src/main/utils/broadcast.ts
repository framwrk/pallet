import { BrowserWindow } from "electron";

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    } catch {
      // A window can close after the checks. Delivery failures must not
      // interrupt transfers or prevent delivery to the remaining windows.
    }
  }
}
