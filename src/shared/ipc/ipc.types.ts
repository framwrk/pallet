/**
 * Envelopes and payloads that only exist because a process boundary does.
 *
 * This file must stay dependency-free: no Node imports, no Electron imports.
 */

/** Serializable error envelope crossing the IPC boundary. */
export interface IpcError {
  code: string;
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

export interface ContextMenuItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  type?: "separator";
}
