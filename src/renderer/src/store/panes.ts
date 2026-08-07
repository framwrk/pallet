import { useSyncExternalStore } from "react";
import type { Entry, Favorite, HostKeyPrompt, KnownFolders, SessionStatus, SortDir, SortKey, VolumeInfo } from "@shared/types";
import { localPath, remotePath } from "@shared/paths";
import { DEFAULT_PREFERENCES } from "@shared/preferences";

export type PaneId = "left" | "right";

export type PaneBackend =
  | { kind: "local" }
  | {
      kind: "sftp";
      sessionId: string;
      host: string;
      username: string;
      status: SessionStatus;
      statusDetail?: string;
    };

/** Path semantics for a pane: POSIX either way, but kept distinct (§3.1). */
export function pathLib(backend: PaneBackend): typeof localPath {
  return backend.kind === "sftp" ? remotePath : localPath;
}

export interface PaneState {
  backend: PaneBackend;
  cwd: string;
  entries: Entry[];
  availBytes: number | null;
  loading: boolean;
  /** Listing failure for the current cwd (permission denied, vanished dir…). */
  error: string | null;
  sortKey: SortKey;
  sortDir: SortDir;
  /** Selection tracked by entry name; survives refreshes of the same dir. */
  selected: ReadonlySet<string>;
  /** Keyboard cursor (also the last-clicked row). */
  focused: string | null;
  /** Anchor for shift-range selection. */
  anchor: string | null;
  /** Entry name currently being renamed inline, if any. */
  renaming: string | null;
  history: string[];
  historyIndex: number;
}

export interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

export interface AppState {
  active: PaneId;
  panes: Record<PaneId, PaneState>;
  showHidden: boolean;
  /** Preference seeding the connect dialog's concurrency field. */
  defaultConcurrency: number;
  volumes: VolumeInfo[];
  knownFolders: KnownFolders | null;
  goToOpen: boolean;
  connectOpen: boolean;
  /** Prefill for the connect dialog (retry without stored secret). */
  connectPrefill: Favorite | null;
  /** Favorite being edited; the dialog switches to edit mode. */
  editingFavorite: Favorite | null;
  favorites: Favorite[];
  hostKeyPrompts: HostKeyPrompt[];
  toasts: Toast[];
  inspectorOpen: boolean;
  /** Pending permanent-delete confirmation for a remote pane. */
  confirmDelete: { paneId: PaneId; names: string[] } | null;
}

function initialPane(): PaneState {
  return {
    backend: { kind: "local" },
    cwd: "",
    entries: [],
    availBytes: null,
    loading: false,
    error: null,
    sortKey: "name",
    sortDir: "asc",
    selected: new Set(),
    focused: null,
    anchor: null,
    renaming: null,
    history: [],
    historyIndex: -1,
  };
}

let state: AppState = {
  active: "left",
  panes: { left: initialPane(), right: initialPane() },
  showHidden: DEFAULT_PREFERENCES.showHidden,
  defaultConcurrency: DEFAULT_PREFERENCES.defaultConcurrency,
  volumes: [],
  knownFolders: null,
  goToOpen: false,
  connectOpen: false,
  connectPrefill: null,
  editingFavorite: null,
  favorites: [],
  hostKeyPrompts: [],
  toasts: [],
  inspectorOpen: false,
  confirmDelete: null,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Latest state for imperative reads (keyboard handlers etc.). */
export function getState(): AppState {
  return state;
}

function setPane(id: PaneId, patch: Partial<PaneState>): void {
  state = {
    ...state,
    panes: { ...state.panes, [id]: { ...state.panes[id], ...patch } },
  };
  emit();
}

function setApp(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  emit();
}

// Guards against a slow listing overwriting a newer navigation.
const generation: Record<PaneId, number> = { left: 0, right: 0 };

export type NavigateMode = "push" | "replace" | "none";

export async function navigate(id: PaneId, path: string, mode: NavigateMode = "push"): Promise<void> {
  const gen = ++generation[id];
  const pane = state.panes[id];
  const samePath = pane.cwd === path;
  setPane(id, { loading: true, ...(samePath ? {} : { error: null }) });
  try {
    const backend = pane.backend;
    const listing =
      backend.kind === "sftp" ? await window.pallet.sftp.list(backend.sessionId, path) : await window.pallet.fs.list(path);
    if (gen !== generation[id]) return;
    const prev = state.panes[id];
    let history = prev.history;
    let historyIndex = prev.historyIndex;
    if (mode === "push" && prev.cwd !== path) {
      history = [...history.slice(0, historyIndex + 1), path];
      historyIndex = history.length - 1;
    } else if (mode === "replace" || history.length === 0) {
      history = [...history.slice(0, historyIndex), path];
      historyIndex = history.length - 1;
    }
    const keepSelection = samePath;
    setPane(id, {
      cwd: listing.path,
      entries: listing.entries,
      availBytes: listing.availBytes,
      loading: false,
      error: null,
      history,
      historyIndex,
      ...(keepSelection
        ? {
            selected: new Set([...prev.selected].filter((n) => listing.entries.some((e) => e.name === n))),
          }
        : { selected: new Set<string>(), focused: null, anchor: null, renaming: null }),
    });
  } catch (err) {
    if (gen !== generation[id]) return;
    setPane(id, { loading: false, error: (err as Error).message });
  }
}

export function refresh(id: PaneId): void {
  const pane = state.panes[id];
  if (pane.cwd) void navigate(id, pane.cwd, "none");
}

export function goBack(id: PaneId): void {
  const pane = state.panes[id];
  if (pane.historyIndex <= 0) return;
  const idx = pane.historyIndex - 1;
  setPane(id, { historyIndex: idx });
  void navigate(id, pane.history[idx], "none");
}

export function goForward(id: PaneId): void {
  const pane = state.panes[id];
  if (pane.historyIndex >= pane.history.length - 1) return;
  const idx = pane.historyIndex + 1;
  setPane(id, { historyIndex: idx });
  void navigate(id, pane.history[idx], "none");
}

export function goUp(id: PaneId): void {
  const pane = state.panes[id];
  if (!pane.cwd || pane.cwd === "/") return;
  const lib = pathLib(pane.backend);
  const parent = lib.dirname(pane.cwd);
  const from = lib.basename(pane.cwd);
  void navigate(id, parent).then(() => {
    // Land with the folder we came from focused, Finder-style.
    const p = state.panes[id];
    if (p.cwd === parent && p.entries.some((e) => e.name === from)) {
      setPane(id, { focused: from, anchor: from, selected: new Set([from]) });
    }
  });
}

export function setActive(id: PaneId): void {
  if (state.active !== id) setApp({ active: id });
}

export function otherPane(id: PaneId): PaneId {
  return id === "left" ? "right" : "left";
}

export function switchPane(): void {
  setApp({ active: otherPane(state.active) });
}

export function setSort(id: PaneId, key: SortKey): void {
  const pane = state.panes[id];
  if (pane.sortKey === key) {
    setPane(id, { sortDir: pane.sortDir === "asc" ? "desc" : "asc" });
  } else {
    setPane(id, { sortKey: key, sortDir: key === "mtime" ? "desc" : "asc" });
  }
}

export function setShowHidden(show: boolean): void {
  setApp({ showHidden: show });
  // Persisted so the settings window and the next launch agree.
  void window.pallet.prefs.set({ showHidden: show });
}

export function setGoToOpen(open: boolean): void {
  setApp({ goToOpen: open });
}

export function setConnectOpen(open: boolean, prefill: Favorite | null = null): void {
  setApp({ connectOpen: open, connectPrefill: open ? prefill : null, editingFavorite: null });
}

export function setEditingFavorite(favorite: Favorite | null): void {
  setApp({ editingFavorite: favorite, connectOpen: favorite !== null, connectPrefill: null });
}

export function setFavorites(favorites: Favorite[]): void {
  setApp({ favorites });
}

export function setInspectorOpen(open: boolean): void {
  setApp({ inspectorOpen: open });
}

export function setConfirmDelete(pending: { paneId: PaneId; names: string[] } | null): void {
  setApp({ confirmDelete: pending });
}

/** Swap a pane's backend; history is per-backend, so it resets. */
export function setBackend(id: PaneId, backend: PaneBackend): void {
  setPane(id, {
    backend,
    history: [],
    historyIndex: -1,
    selected: new Set(),
    focused: null,
    anchor: null,
    renaming: null,
    error: null,
  });
}

export function updateSessionStatus(sessionId: string, status: SessionStatus, detail?: string): void {
  for (const id of ["left", "right"] as const) {
    const backend = state.panes[id].backend;
    if (backend.kind === "sftp" && backend.sessionId === sessionId) {
      setPane(id, { backend: { ...backend, status, statusDetail: detail } });
      if (status === "connected") refresh(id);
    }
  }
}

export function pushHostKeyPrompt(prompt: HostKeyPrompt): void {
  setApp({ hostKeyPrompts: [...state.hostKeyPrompts, prompt] });
}

export function shiftHostKeyPrompt(): void {
  setApp({ hostKeyPrompts: state.hostKeyPrompts.slice(1) });
}

export function setRenaming(id: PaneId, name: string | null): void {
  setPane(id, { renaming: name });
}

/** Select the given names (used after ops to highlight results). */
export function selectNames(id: PaneId, names: string[]): void {
  setPane(id, {
    selected: new Set(names),
    focused: names[0] ?? null,
    anchor: names[0] ?? null,
  });
}

let toastSeq = 0;

export function pushToast(message: string, kind: Toast["kind"] = "error"): void {
  const toast = { id: ++toastSeq, message, kind };
  setApp({ toasts: [...state.toasts, toast] });
  setTimeout(() => dismissToast(toast.id), 6000);
}

export function dismissToast(id: number): void {
  if (state.toasts.some((t) => t.id === id)) {
    setApp({ toasts: state.toasts.filter((t) => t.id !== id) });
  }
}

// --- selection -------------------------------------------------------------

export function selectOnly(id: PaneId, name: string): void {
  setPane(id, { selected: new Set([name]), focused: name, anchor: name });
}

export function toggleSelect(id: PaneId, name: string): void {
  const next = new Set(state.panes[id].selected);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  setPane(id, { selected: next, focused: name, anchor: name });
}

/** Range-select from the anchor to `name` over the given visible order. */
export function extendTo(id: PaneId, name: string, visible: readonly Entry[]): void {
  const pane = state.panes[id];
  const anchor = pane.anchor ?? pane.focused ?? name;
  const ai = visible.findIndex((e) => e.name === anchor);
  const bi = visible.findIndex((e) => e.name === name);
  if (ai === -1 || bi === -1) {
    selectOnly(id, name);
    return;
  }
  const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
  const next = new Set(visible.slice(lo, hi + 1).map((e) => e.name));
  setPane(id, { selected: next, focused: name, anchor });
}

export function selectAll(id: PaneId, visible: readonly Entry[]): void {
  setPane(id, { selected: new Set(visible.map((e) => e.name)) });
}

export function clearSelection(id: PaneId): void {
  setPane(id, { selected: new Set(), focused: null, anchor: null });
}

export function moveFocus(id: PaneId, delta: number, extend: boolean, visible: readonly Entry[]): void {
  if (visible.length === 0) return;
  const pane = state.panes[id];
  const cur = visible.findIndex((e) => e.name === pane.focused);
  let next: number;
  if (cur === -1) {
    next = delta > 0 ? 0 : visible.length - 1;
  } else {
    next = Math.min(visible.length - 1, Math.max(0, cur + delta));
  }
  const name = visible[next].name;
  if (extend) {
    extendTo(id, name, visible);
  } else {
    selectOnly(id, name);
  }
}

// --- boot ------------------------------------------------------------------

export async function initApp(): Promise<void> {
  const [home, folders, vols, prefs] = await Promise.all([
    window.pallet.fs.homeDir(),
    window.pallet.fs.knownFolders(),
    window.pallet.fs.volumes(),
    window.pallet.prefs.get(),
  ]);
  setApp({
    knownFolders: folders,
    volumes: vols,
    showHidden: prefs.showHidden,
    defaultConcurrency: prefs.defaultConcurrency,
  });
  // Keep in step with edits made in the settings window.
  window.pallet.prefs.onChange((next) => setApp({ showHidden: next.showHidden, defaultConcurrency: next.defaultConcurrency }));
  await Promise.all([navigate("left", home, "replace"), navigate("right", home, "replace")]);
}

export function loadVolumes(): void {
  void window.pallet.fs.volumes().then((vols) => setApp({ volumes: vols }));
}
