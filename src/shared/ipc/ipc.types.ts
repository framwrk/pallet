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
