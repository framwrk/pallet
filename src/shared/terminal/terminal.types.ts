export interface TerminalDataEvent {
  terminalId: string;
  data: Uint8Array;
}

/** A shell that ended by itself (exit) or because its SSH connection failed. */
export type TerminalExitEvent =
  { terminalId: string; reason: "exit"; exitCode?: number } | { terminalId: string; reason: "error"; message: string };
