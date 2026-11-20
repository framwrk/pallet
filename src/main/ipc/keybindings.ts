import type { CommandId, KeybindingsState } from "@shared/keybindings/keybinding.types";
import {
  getKeybindingsState,
  onKeybindingsChange,
  openKeybindingsFile,
  resetAll,
  resetCommand,
  setCommandKey,
  setKeybindingRecording,
} from "../services/keybindings-store";
import type { IpcResult } from "@shared/ipc/ipc.types";
import { KeybindingChannels } from "@shared/ipc/ipc.constants";
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

export function registerKeybindingHandlers(): void {
  onKeybindingsChange((state: KeybindingsState) => broadcast(KeybindingChannels.changed, state));

  handle(KeybindingChannels.get, () => getKeybindingsState());
  handle(KeybindingChannels.set, (id: CommandId, key: string | null) => setCommandKey(id, key));
  handle(KeybindingChannels.reset, (id: CommandId) => resetCommand(id));
  handle(KeybindingChannels.resetAll, () => resetAll());
  handle(KeybindingChannels.open, () => openKeybindingsFile());
  handle(KeybindingChannels.recording, (active: boolean) => setKeybindingRecording(active));
}
