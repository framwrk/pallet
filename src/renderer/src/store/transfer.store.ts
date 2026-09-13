/** Renderer transfer state: job snapshots, conflict prompts, drawer UI (M5). */
import type { ConflictAction, ConflictPrompt, EndpointRef, TransferJobSnapshot } from "@shared/transfer/transfer.types";
import { type PaneId, getState, pushToast, refresh, setConflictPromptCount } from "./pane.store";
import { TERMINAL_TRANSFER_STATES } from "@shared/transfer/transfer.constants";
import { useSyncExternalStore } from "react";

interface TransferUiState {
  jobs: TransferJobSnapshot[];
  prompts: ConflictPrompt[];
  drawerOpen: boolean;
}

let state: TransferUiState = { jobs: [], prompts: [], drawerOpen: false };
const listeners = new Set<() => void>();

function set(patch: Partial<TransferUiState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useTransfers(): TransferUiState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

let bound = false;
export function initTransferEvents(): void {
  if (bound) return;
  bound = true;
  window.pallet.transfer.onUpdate((snapshot) => {
    const existing = state.jobs.find((j) => j.id === snapshot.id);
    const wasTerminal = existing && TERMINAL_TRANSFER_STATES.includes(existing.state);
    const jobs = existing ? state.jobs.map((j) => (j.id === snapshot.id ? snapshot : j)) : [...state.jobs, snapshot];
    set({ jobs, drawerOpen: state.drawerOpen || !existing });
    // A job just finished: freshen both panes so results appear.
    if (!wasTerminal && TERMINAL_TRANSFER_STATES.includes(snapshot.state)) {
      refresh("left");
      refresh("right");
      if (snapshot.state === "completed" && snapshot.errors.length === 0) {
        // Quietly done; the drawer row shows it.
      } else if (snapshot.state === "failed") {
        pushToast(`Transfer failed: ${snapshot.errors[0]?.message ?? "unknown error"}`);
      }
    }
  });
  window.pallet.transfer.onConflict((prompt) => {
    set({ prompts: [...state.prompts, prompt] });
    // The pane store's modal guard also covers conflict decisions, so file
    // shortcuts cannot fire while a transfer waits on the user.
    setConflictPromptCount(state.prompts.length);
  });
}

/**
 * Keep the pane store's modal guard in step as conflicts are answered; called
 * from every prompts mutation below.
 */
function setPrompts(prompts: ConflictPrompt[]): void {
  set({ prompts });
  setConflictPromptCount(prompts.length);
}

export function setDrawerOpen(open: boolean): void {
  set({ drawerOpen: open });
}

export function answerConflict(action: ConflictAction, applyToAll: boolean): void {
  const prompt = state.prompts[0];
  if (!prompt) return;
  void window.pallet.transfer.resolveConflict(prompt.jobId, action, applyToAll);
  // Apply-to-all settles every queued prompt for that job.
  setPrompts(applyToAll ? state.prompts.filter((p) => p.jobId !== prompt.jobId) : state.prompts.slice(1));
}

export function jobAction(id: string, action: "pause" | "resume" | "cancel" | "retry"): void {
  void window.pallet.transfer[action](id).catch((err) => pushToast((err as Error).message));
}

export function removeJob(id: string): void {
  void window.pallet.transfer.remove(id);
  set({ jobs: state.jobs.filter((j) => j.id !== id) });
}

export function clearFinishedJobs(): void {
  for (const job of state.jobs.filter((j) => TERMINAL_TRANSFER_STATES.includes(j.state))) {
    void window.pallet.transfer.remove(job.id);
  }
  set({ jobs: state.jobs.filter((j) => !TERMINAL_TRANSFER_STATES.includes(j.state)) });
}

function endpointFor(id: PaneId): EndpointRef {
  const backend = getState().panes[id].backend;
  return backend.kind === "sftp" ? { kind: "sftp", sessionId: backend.sessionId } : { kind: "local" };
}

/** Queue a copy of the given names from one pane's cwd into a destination dir. */
export async function enqueuePaneCopy(
  fromPane: PaneId,
  toPane: PaneId,
  names: string[],
  destDirOverride?: string,
): Promise<void> {
  const panes = getState().panes;
  if (names.length === 0) return;
  if (panes[fromPane].backend.kind === "none" || panes[toPane].backend.kind === "none") {
    pushToast("Connect to a server first", "info");
    return;
  }
  try {
    await window.pallet.transfer.enqueue({
      from: endpointFor(fromPane),
      to: endpointFor(toPane),
      sourceBase: panes[fromPane].cwd,
      names,
      destDir: destDirOverride ?? panes[toPane].cwd,
    });
    set({ drawerOpen: true });
  } catch (err) {
    pushToast((err as Error).message);
  }
}
