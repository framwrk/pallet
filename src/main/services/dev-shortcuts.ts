import type { BrowserWindow } from "electron";
import { is } from "@electron-toolkit/utils";

/**
 * Development-only window keys. Production has no reload or zoom accelerators
 * to guard, so nothing is filtered there; the F12 DevTools toggle lives here
 * instead of `optimizer.watchWindowShortcuts`, which also swallowed ⌘R.
 */
export function watchDevShortcuts(window: BrowserWindow): void {
  if (!is.dev) return;
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "F12") return;
    event.preventDefault();
    if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
    else window.webContents.openDevTools({ mode: "undocked" });
  });
}
