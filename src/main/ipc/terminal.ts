import type { TerminalDataEvent, TerminalExitEvent } from "@shared/terminal/terminal.types";
import { onSessionStatus, sessionManager } from "./sftp";
import type { IpcResult } from "@shared/ipc/ipc.types";
import { TerminalChannels } from "@shared/ipc/ipc.constants";
import { TerminalSessions } from "../services/ssh/terminal-sessions";
import { broadcast } from "../utils/broadcast";
import { ipcMain } from "electron";

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

export const terminalSessions = new TerminalSessions(sessionManager, {
  onData: (event: TerminalDataEvent) => broadcast(TerminalChannels.data, event),
  onExit: (event: TerminalExitEvent) => broadcast(TerminalChannels.exit, event),
});

onSessionStatus((event) => {
  if (event.status === "disconnected") terminalSessions.closeForSession(event.sessionId);
});

export function registerTerminalHandlers(): void {
  handle(TerminalChannels.open, (terminalId: string, sessionId: string, cols: number, rows: number) =>
    terminalSessions.open(terminalId, sessionId, cols, rows),
  );
  handle(TerminalChannels.close, (terminalId: string) => terminalSessions.close(terminalId));

  ipcMain.on(TerminalChannels.write, (_event, terminalId: string, data: string) => {
    terminalSessions.write(terminalId, data);
  });
  ipcMain.on(TerminalChannels.resize, (_event, terminalId: string, cols: number, rows: number) => {
    terminalSessions.resize(terminalId, cols, rows);
  });
}
