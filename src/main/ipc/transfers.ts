import { BrowserWindow, ipcMain } from "electron";
import type { IpcResult } from "../../shared/types";
import type { ConflictAction, TransferRequest } from "../../shared/transfers";
import { TransferChannels } from "../../shared/ipc";
import { TransferQueue } from "../services/transfer/queue";
import { getDb } from "../db";
import { onSessionStatus, sessionManager } from "./sftp";

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export const transferQueue = new TransferQueue(sessionManager, {
  onUpdate: (snapshot) => broadcast(TransferChannels.update, snapshot),
  onConflict: (prompt) => broadcast(TransferChannels.conflict, prompt),
  record: (job) => {
    try {
      getDb()
        .prepare(
          `INSERT INTO transfer_history (direction, source, dest, bytes, status, error, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "transfer",
          job.label,
          job.destDir,
          job.doneBytes,
          job.state,
          job.errors[0]?.message ?? null,
          Date.now(),
          Date.now(),
        );
    } catch {
      // History is best-effort; never fail a transfer over it.
    }
  },
});

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

onSessionStatus((event) => transferQueue.handleSessionStatus(event));

export function registerTransferHandlers(): void {
  handle(TransferChannels.enqueue, (request: TransferRequest) => transferQueue.enqueue(request));
  handle(TransferChannels.pause, (id: string) => transferQueue.pause(id));
  handle(TransferChannels.resume, (id: string) => transferQueue.resume(id));
  handle(TransferChannels.cancel, (id: string) => transferQueue.cancel(id));
  handle(TransferChannels.retry, (id: string) => transferQueue.retry(id));
  handle(TransferChannels.remove, (id: string) => transferQueue.remove(id));
  handle(TransferChannels.resolveConflict, (id: string, action: ConflictAction, applyToAll: boolean) =>
    transferQueue.resolveConflict(id, action, applyToAll),
  );
  handle(TransferChannels.snapshots, () => transferQueue.snapshots());
}
