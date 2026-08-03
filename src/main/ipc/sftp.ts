import { BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "crypto";
import type { ConnectProfile, HostKeyPrompt, IpcResult, PreviewData } from "../../shared/types";
import { EditChannels, HostKeyChannels, SftpChannels, UiChannels } from "../../shared/ipc";
import { SessionManager, type HostKeyDecisionInput } from "../services/session-manager";
import { SftpService } from "../services/sftp-service";
import { EditSessions } from "../services/edit-sessions";
import * as hostKeys from "../services/host-key-store";

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

const pendingPrompts = new Map<string, (trust: boolean) => void>();

/**
 * TOFU: silently accept a fingerprint matching the store; otherwise prompt
 * the renderer and block the handshake on the user's decision.
 */
async function verifyHostKey(input: HostKeyDecisionInput): Promise<boolean> {
  const known = hostKeys.getKnownKey(input.host, input.port);
  if (known && known.fingerprint === input.fingerprint) {
    hostKeys.touchKey(input.host, input.port);
    return true;
  }
  const prompt: HostKeyPrompt = {
    requestId: randomUUID(),
    host: input.host,
    port: input.port,
    keyType: input.keyType,
    fingerprint: input.fingerprint,
    status: known ? "mismatch" : "new",
    ...(known ? { knownFingerprint: known.fingerprint } : {}),
  };
  const trusted = await new Promise<boolean>((resolve) => {
    pendingPrompts.set(prompt.requestId, resolve);
    broadcast(HostKeyChannels.verify, prompt);
  });
  pendingPrompts.delete(prompt.requestId);
  if (trusted) {
    hostKeys.trustKey(input.host, input.port, input.keyType, input.fingerprint);
  }
  return trusted;
}

import type { SessionStatusEvent } from "../../shared/types";

const statusListeners: ((event: SessionStatusEvent) => void)[] = [];

/** Main-process subscribers (e.g. the transfer queue's auto-pause). */
export function onSessionStatus(listener: (event: SessionStatusEvent) => void): void {
  statusListeners.push(listener);
}

export const sessionManager = new SessionManager({
  verifyHostKey,
  onStatus: (event) => {
    broadcast(SftpChannels.status, event);
    for (const listener of statusListeners) listener(event);
  },
});

export const sftpService = new SftpService(sessionManager);

export const editSessions = new EditSessions(sessionManager, (event) => broadcast(EditChannels.event, event));

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

export function registerSftpHandlers(): void {
  handle(SftpChannels.connect, (profile: ConnectProfile) => sessionManager.connect(profile));
  handle(SftpChannels.disconnect, (sessionId: string) => sessionManager.disconnect(sessionId));
  handle(SftpChannels.reconnect, (sessionId: string) => sessionManager.reconnectNow(sessionId));
  handle(SftpChannels.list, (sessionId: string, dirPath: string) => sftpService.list(sessionId, dirPath));
  handle(SftpChannels.stat, (sessionId: string, p: string) => sftpService.stat(sessionId, p));
  handle(SftpChannels.realpath, (sessionId: string, p: string) => sftpService.realpath(sessionId, p));
  handle(SftpChannels.mkdir, (sessionId: string, p: string) => sftpService.mkdir(sessionId, p));
  handle(SftpChannels.mkdirUnique, (sessionId: string, dirPath: string) => sftpService.mkdirUnique(sessionId, dirPath));
  handle(SftpChannels.rename, (sessionId: string, from: string, to: string) => sftpService.rename(sessionId, from, to));
  handle(SftpChannels.remove, async (sessionId: string, paths: string[]) => {
    for (const p of paths) {
      await sftpService.removeRecursive(sessionId, p);
    }
  });
  handle(SftpChannels.chmod, (sessionId: string, p: string, mode: number) => sftpService.chmod(sessionId, p, mode));
  handle(SftpChannels.readPreview, async (sessionId: string, p: string, maxBytes: number): Promise<PreviewData> => {
    const entry = await sftpService.stat(sessionId, p);
    const buf = await sftpService.readBytes(sessionId, p, maxBytes);
    return {
      base64: buf.toString("base64"),
      totalSize: entry.size,
      truncated: buf.length < entry.size,
    };
  });
  handle(EditChannels.open, (sessionId: string, remotePath: string) => editSessions.open(sessionId, remotePath));
  handle(HostKeyChannels.respond, (requestId: string, trust: boolean) => {
    pendingPrompts.get(requestId)?.(trust);
  });
  handle(UiChannels.pickFile, async (title: string): Promise<string | null> => {
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title,
      properties: ["openFile", "showHiddenFiles"],
      defaultPath: `${process.env.HOME}/.ssh`,
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
}
