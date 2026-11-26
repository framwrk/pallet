import { type PaneId, getState, isModalOpen, pushToast, setPaneTerminal } from "./pane.store";
import { isSsh } from "@shared/sftp/sftp.utils";

type Sink = (data: Uint8Array) => void;

const sinks = new Map<string, Sink>();

let bound = false;

export function registerTerminalSink(terminalId: string, sink: Sink): void {
  sinks.set(terminalId, sink);
}

export function unregisterTerminalSink(terminalId: string): void {
  sinks.delete(terminalId);
}

/** A shell exists only for live SSH (SFTP or SCP) connections, never FTP/FTPS/S3. */
export function canUseTerminal(paneId: PaneId): boolean {
  const backend = getState().panes[paneId].backend;
  return backend.kind === "sftp" && isSsh(backend.protocol) && !backend.s3;
}

function hostLabel(paneId: PaneId): string {
  const backend = getState().panes[paneId].backend;
  return backend.kind === "sftp" ? backend.host : "the server";
}

/**
 * Swap a pane between its file browser and its shell. Hiding the terminal
 * leaves the shell running; only a pane without a shell dials a new one.
 */
export function toggleTerminal(paneId: PaneId): void {
  if (isModalOpen() || !canUseTerminal(paneId)) return;
  const pane = getState().panes[paneId];
  if (pane.backend.kind !== "sftp") return;

  if (pane.view === "terminal") {
    setPaneTerminal(paneId, { view: "files" });
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-pane="${paneId}"] [role="grid"]`)?.focus({ preventScroll: true });
    });
    return;
  }
  if (pane.terminalId) {
    setPaneTerminal(paneId, { view: "terminal" });
    return;
  }
  if (pane.backend.status !== "connected") return;
  setPaneTerminal(paneId, { view: "terminal", terminalId: crypto.randomUUID() });
}

/** Dial the pane's shell; TerminalView owns the xterm that consumes it. */
export async function openTerminal(paneId: PaneId, terminalId: string, cols: number, rows: number): Promise<void> {
  const backend = getState().panes[paneId].backend;
  if (backend.kind !== "sftp") return;
  try {
    await window.pallet.terminal.open(terminalId, backend.sessionId, cols, rows);
  } catch (err) {
    if (getState().panes[paneId].terminalId === terminalId) {
      setPaneTerminal(paneId, { view: "files", terminalId: null });
    }
    pushToast(`Couldn’t open a terminal on ${backend.host}: ${(err as Error).message}`);
  }
}

function paneWithTerminal(terminalId: string): PaneId | null {
  for (const id of ["left", "right"] as const) {
    if (getState().panes[id].terminalId === terminalId) return id;
  }
  return null;
}

/** Bind main-process terminal events once, at app startup. */
export function initTerminalEvents(): void {
  if (bound) return;
  bound = true;

  window.pallet.terminal.onData((event) => {
    sinks.get(event.terminalId)?.(event.data);
  });

  window.pallet.terminal.onExit((event) => {
    const paneId = paneWithTerminal(event.terminalId);
    if (!paneId) return;
    const host = hostLabel(paneId);
    setPaneTerminal(paneId, { view: "files", terminalId: null });
    if (event.reason === "exit") pushToast(`Terminal session on ${host} ended`, "info");
    else pushToast(`Terminal on ${host} disconnected: ${event.message}`);
  });

  window.pallet.terminal.onToggleRequest(() => {
    if (!isModalOpen()) toggleTerminal(getState().active);
  });
}
