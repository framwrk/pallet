/**
 * Push a main → renderer event to every open window, with best-effort delivery.
 *
 * Even with a single main window, the broadcast keeps the send path uniform
 * with the other main → renderer events.
 */
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
