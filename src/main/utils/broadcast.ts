/**
 * Push a main → renderer event to every open window.
 *
 * Even with a single main window, the broadcast keeps the send path uniform
 * with the other main → renderer events.
 */
import { BrowserWindow } from "electron";

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}
