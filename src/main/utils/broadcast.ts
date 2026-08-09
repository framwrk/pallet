/**
 * Push a main → renderer event to every open window.
 *
 * Events are broadcast rather than addressed because both the main window and
 * the settings window render from the same state, and either may be closed.
 */
import { BrowserWindow } from "electron";

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}
