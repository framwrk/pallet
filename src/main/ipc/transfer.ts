import type { ConflictAction, TransferRequest } from "@shared/transfer/transfer.types";
import { onSessionStatus, sessionManager } from "./sftp";
import type { IpcResult } from "@shared/ipc/ipc.types";
import { TransferChannels } from "@shared/ipc/ipc.constants";
import { TransferQueue } from "../services/transfer/transfer-queue";
import { broadcast } from "../utils/broadcast";
import { getPreferences } from "../services/prefs-store";
import { ipcMain } from "electron";
import { recordTransferHistory } from "../services/transfer/transfer-history";

export const transferQueue = new TransferQueue(
  sessionManager,
  {
    onUpdate: (snapshot) => broadcast(TransferChannels.update, snapshot),
    onConflict: (prompt) => broadcast(TransferChannels.conflict, prompt),
    record: (job, request) => recordTransferHistory(job, request),
  },
  7,
  undefined,
  () => {
    const prefs = getPreferences();
    return {
      stallTimeoutMs: prefs.transferTimeoutSeconds * 1000,
      maxChannelRetries: prefs.transferMaxRetries,
      speedStatsWindowMs: prefs.speedStatsWindowSeconds * 1000,
    };
  },
);

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
  handle(TransferChannels.pauseItem, (id: string, name: string) => transferQueue.pauseItem(id, name));
  handle(TransferChannels.resumeItem, (id: string, name: string) => transferQueue.resumeItem(id, name));
  handle(TransferChannels.cancelItem, (id: string, name: string) => transferQueue.cancelItem(id, name));
  handle(TransferChannels.retry, (id: string) => transferQueue.retry(id));
  handle(TransferChannels.remove, (id: string) => transferQueue.remove(id));
  handle(TransferChannels.resolveConflict, (id: string, action: ConflictAction, applyToAll: boolean) =>
    transferQueue.resolveConflict(id, action, applyToAll),
  );
  handle(TransferChannels.snapshots, () => transferQueue.snapshots());
}
