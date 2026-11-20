/** Renderer transfer state: job snapshots, conflict prompts, transfer panel UI (M5). */
import type { ConflictAction, ConflictPrompt, EndpointRef, TransferJobSnapshot } from "@shared/transfer/transfer.types";
import { type PaneId, getState, pushToast, refresh, setConflictPromptCount } from "./pane.store";
import { TERMINAL_TRANSFER_STATES } from "@shared/transfer/transfer.constants";
import { useSyncExternalStore } from "react";

interface TransferUiState {
  jobs: TransferJobSnapshot[];
  prompts: ConflictPrompt[];
  /** The floating panel shows its full job list; collapsed, it is a summary card. */
  panelExpanded: boolean;
  /** Last job that finished, for the panel's screen-reader live region. */
  announcement: string;
}

let state: TransferUiState = { jobs: [], prompts: [], panelExpanded: false, announcement: "" };
/** Ids the user removed; a snapshot already in flight must not re-add the row. */
const removedIds = new Set<string>();
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

function nextAnnouncement(text: string): string {
  return state.announcement === text ? `${text}\u200b` : text;
}

let bound = false;
export function initTransferEvents(): void {
  if (bound) return;
  bound = true;
  window.pallet.transfer.onUpdate((snapshot) => {
    if (removedIds.has(snapshot.id)) return;
    const existing = state.jobs.find((j) => j.id === snapshot.id);
    const wasTerminal = existing && TERMINAL_TRANSFER_STATES.includes(existing.state);
    const jobs = existing ? state.jobs.map((j) => (j.id === snapshot.id ? snapshot : j)) : [...state.jobs, snapshot];
    const finished = !wasTerminal && TERMINAL_TRANSFER_STATES.includes(snapshot.state);
    set({
      jobs,
      panelExpanded: state.panelExpanded || !existing,
      // Failures are announced by their toast. A trailing zero-width space alternates so a
      // repeat of the same text still changes the live region and is read again.
      ...(finished && snapshot.state !== "failed" && { announcement: nextAnnouncement(`${snapshot.label} ${snapshot.state}`) }),
    });
    // A job just finished: freshen both panes so results appear.
    if (finished) {
      refresh("left");
      refresh("right");
      if (snapshot.state === "completed" && snapshot.errors.length === 0) {
        // Quietly done; the panel row shows it.
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
  // A reopened window starts empty; paused, waiting, and finished jobs don't re-emit on their own.
  void window.pallet.transfer.snapshots().then((snapshots) => {
    const known = new Set(state.jobs.map((j) => j.id));
    const missing = snapshots.filter((s) => !known.has(s.id) && !removedIds.has(s.id));
    if (missing.length > 0) set({ jobs: [...missing, ...state.jobs] });
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

export function setPanelExpanded(expanded: boolean): void {
  set({ panelExpanded: expanded });
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

export function itemAction(id: string, name: string, action: "pause" | "resume" | "cancel"): void {
  void window.pallet.transfer[`${action}Item`](id, name).catch((err) => pushToast((err as Error).message));
}

export function removeJob(id: string): void {
  removedIds.add(id);
  void window.pallet.transfer.remove(id);
  set({ jobs: state.jobs.filter((j) => j.id !== id), announcement: "" });
}

export function clearFinishedJobs(): void {
  for (const job of state.jobs.filter((j) => TERMINAL_TRANSFER_STATES.includes(j.state))) {
    removedIds.add(job.id);
    void window.pallet.transfer.remove(job.id);
  }
  set({ jobs: state.jobs.filter((j) => !TERMINAL_TRANSFER_STATES.includes(j.state)), announcement: "" });
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
  // A terminal-view pane isn't a transfer destination. Silent, like other
  // unusable targets.
  if (panes[toPane].view === "terminal") return;
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
    set({ panelExpanded: true });
  } catch (err) {
    pushToast((err as Error).message);
  }
}
