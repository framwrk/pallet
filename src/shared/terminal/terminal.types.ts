/**
 * Interactive terminal shapes shared across main, preload, and renderer.
 *
 * This file must stay dependency-free: no Node imports, no Electron imports.
 */

export interface TerminalDataEvent {
  terminalId: string;
  data: Uint8Array;
}

/** A shell that ended by itself (exit) or because its SSH connection failed. */
export type TerminalExitEvent =
  { terminalId: string; reason: "exit"; exitCode?: number } | { terminalId: string; reason: "error"; message: string };
