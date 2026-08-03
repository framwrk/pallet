import { app, ipcMain, shell } from "electron";
import type { ContextMenuItem, IpcResult } from "../../shared/types";
import { AppChannels, FsChannels, UiChannels } from "../../shared/ipc";
import { checkForUpdate } from "../services/update-checker";
import { logFilePath } from "../services/logger";
import * as localFs from "../services/local-fs";
import * as localOps from "../services/local-ops";
import { popupContextMenu } from "../services/context-menu";
import { registerSftpHandlers } from "./sftp";
import { registerFavoriteHandlers } from "./favorites";
import { registerTransferHandlers } from "./transfers";

/**
 * Every handler returns an IpcResult envelope instead of throwing, so the
 * renderer gets a clean { code, message } rather than Electron's
 * "Error invoking remote method" wrapper. The preload unwraps it.
 */
function handle<Args extends unknown[], T>(channel: string, fn: (...args: Args) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      const value = await fn(...(args as Args));
      return { ok: true, value };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return {
        ok: false,
        error: { code: e.code ?? "EUNKNOWN", message: e.message ?? String(err) },
      };
    }
  });
}

export function registerIpcHandlers(): void {
  handle(FsChannels.list, localFs.listDir);
  handle(FsChannels.stat, localFs.statEntry);
  handle(FsChannels.homeDir, localFs.homeDir);
  handle(FsChannels.knownFolders, localFs.knownFolders);
  handle(FsChannels.volumes, localFs.volumes);
  handle(FsChannels.mkdir, localOps.mkdir);
  handle(FsChannels.mkdirUnique, localOps.mkdirUnique);
  handle(FsChannels.rename, localOps.rename);
  handle(FsChannels.trash, localOps.trash);
  handle(FsChannels.copy, localOps.copyMany);
  handle(FsChannels.move, localOps.moveMany);
  handle(FsChannels.reveal, localOps.revealInFinder);
  handle(FsChannels.open, localOps.openWithDefault);
  handle(FsChannels.readPreview, async (p: string, maxBytes: number) => {
    const entry = await localFs.statEntry(p);
    const buf = await localFs.readBytes(p, maxBytes);
    return {
      base64: buf.toString("base64"),
      totalSize: entry.size,
      truncated: buf.length < entry.size,
    };
  });

  registerSftpHandlers();
  registerFavoriteHandlers();
  registerTransferHandlers();

  handle(AppChannels.version, () => app.getVersion());
  handle(AppChannels.checkForUpdate, () => checkForUpdate());
  handle(AppChannels.openExternal, (url: string) => {
    if (!/^https?:\/\//.test(url)) throw new Error("Only http(s) URLs can be opened");
    return shell.openExternal(url);
  });
  handle(AppChannels.revealLog, () => shell.showItemInFolder(logFilePath()));

  // Context menu needs the sender to anchor the popup, so it bypasses handle().
  ipcMain.handle(UiChannels.contextMenu, async (event, items: ContextMenuItem[]) => {
    try {
      const value = await popupContextMenu(event, items);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: { code: "EMENU", message: (err as Error).message } };
    }
  });
}
