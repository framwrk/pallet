/**
 * Local file operations driven from the UI (M2). Each op reports failures as
 * toasts and refreshes affected panes. Undo covers rename and move, per plan.
 */
import { localPath } from "@shared/paths";
import type { Entry } from "@shared/types";
import type { EndpointRef } from "@shared/transfers";
import { enqueuePaneCopy } from "./transfers";
import { isDirLike } from "@/lib/entries";
import {
  getState,
  navigate,
  otherPane,
  pushToast,
  refresh,
  selectNames,
  setConfirmDelete,
  setRenaming,
  type PaneId,
} from "./panes";

interface Clipboard {
  endpoint: EndpointRef;
  base: string;
  names: string[];
}

let clipboard: Clipboard | null = null;

type UndoEntry =
  { type: "rename"; from: string; to: string; pane: PaneId } | { type: "move"; paths: string[]; backTo: string; pane: PaneId };

const undoStack: UndoEntry[] = [];
const UNDO_LIMIT = 50;

function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

function refreshBoth(): void {
  refresh("left");
  refresh("right");
}

function selectedEntries(id: PaneId): Entry[] {
  const pane = getState().panes[id];
  return pane.entries.filter((e) => pane.selected.has(e.name));
}

function fail(err: unknown): void {
  pushToast((err as Error).message);
}

/** M3: remote panes are read-only; mutations arrive in M5 (transfers) / M6 (ops). */
function requireLocal(...ids: PaneId[]): boolean {
  for (const id of ids) {
    if (getState().panes[id].backend.kind !== "local") {
      pushToast("Not available for remote folders yet", "info");
      return false;
    }
  }
  return true;
}

// --- rename ----------------------------------------------------------------

export function beginRename(id: PaneId): void {
  const pane = getState().panes[id];
  if (pane.selected.size !== 1) return;
  const name = [...pane.selected][0];
  setRenaming(id, name);
}

export async function commitRename(id: PaneId, oldName: string, newName: string): Promise<void> {
  setRenaming(id, null);
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) return;
  if (trimmed.includes("/")) {
    pushToast("Names can’t contain “/”");
    return;
  }
  const pane = getState().panes[id];
  const cwd = pane.cwd;
  const from = localPath.join(cwd, oldName);
  const to = localPath.join(cwd, trimmed);
  try {
    if (pane.backend.kind === "sftp") {
      await window.pallet.sftp.rename(pane.backend.sessionId, from, to);
    } else {
      await window.pallet.fs.rename(from, to);
      pushUndo({ type: "rename", from: to, to: from, pane: id });
    }
    await navigate(id, cwd, "none");
    selectNames(id, [trimmed]);
  } catch (err) {
    fail(err);
  }
}

export function cancelRename(id: PaneId): void {
  setRenaming(id, null);
}

// --- new folder ------------------------------------------------------------

export async function newFolder(id: PaneId): Promise<void> {
  const pane = getState().panes[id];
  const cwd = pane.cwd;
  if (!cwd) return;
  try {
    const name =
      pane.backend.kind === "sftp"
        ? await window.pallet.sftp.mkdirUnique(pane.backend.sessionId, cwd)
        : localPath.basename(await window.pallet.fs.mkdirUnique(cwd));
    await navigate(id, cwd, "none");
    selectNames(id, [name]);
    setRenaming(id, name);
  } catch (err) {
    fail(err);
  }
}

// --- trash -----------------------------------------------------------------

export async function trashSelection(id: PaneId): Promise<void> {
  const entries = selectedEntries(id);
  if (entries.length === 0) return;
  const pane = getState().panes[id];
  if (pane.backend.kind === "sftp") {
    // Remote delete is permanent: always confirm (§4 keyboard model).
    setConfirmDelete({ paneId: id, names: entries.map((e) => e.name) });
    return;
  }
  try {
    await window.pallet.fs.trash(entries.map((e) => e.path));
    refreshBoth();
  } catch (err) {
    fail(err);
    refreshBoth();
  }
}

/** Runs after the user confirms a permanent remote delete. */
export async function confirmedRemoteDelete(id: PaneId, names: string[]): Promise<void> {
  const pane = getState().panes[id];
  if (pane.backend.kind !== "sftp") return;
  const paths = names.map((n) => localPath.join(pane.cwd, n));
  try {
    await window.pallet.sftp.remove(pane.backend.sessionId, paths);
  } catch (err) {
    fail(err);
  }
  refreshBoth();
}

// --- copy / move -----------------------------------------------------------

export function copySelection(id: PaneId): void {
  const entries = selectedEntries(id);
  if (entries.length === 0) return;
  const pane = getState().panes[id];
  clipboard = {
    endpoint: pane.backend.kind === "sftp" ? { kind: "sftp", sessionId: pane.backend.sessionId } : { kind: "local" },
    base: pane.cwd,
    names: entries.map((e) => e.name),
  };
}

export async function paste(id: PaneId): Promise<void> {
  if (!clipboard || clipboard.names.length === 0) return;
  const pane = getState().panes[id];
  const to: EndpointRef =
    pane.backend.kind === "sftp" ? { kind: "sftp", sessionId: pane.backend.sessionId } : { kind: "local" };
  try {
    await window.pallet.transfer.enqueue({
      from: clipboard.endpoint,
      to,
      sourceBase: clipboard.base,
      names: clipboard.names,
      destDir: pane.cwd,
    });
  } catch (err) {
    fail(err);
  }
}

/** F5/⌘D: copy the selection to the other pane via the transfer queue. */
export async function copyToOther(id: PaneId): Promise<void> {
  const entries = selectedEntries(id);
  if (entries.length === 0) return;
  await enqueuePaneCopy(
    id,
    otherPane(id),
    entries.map((e) => e.name),
  );
}

export async function moveToOther(id: PaneId): Promise<void> {
  if (getState().panes[id].backend.kind !== "local" || getState().panes[otherPane(id)].backend.kind !== "local") {
    pushToast("Remote moves are copy-only in the beta — use F5, then delete", "info");
    return;
  }
  const entries = selectedEntries(id);
  if (entries.length === 0) return;
  const srcDir = getState().panes[id].cwd;
  const destDir = getState().panes[otherPane(id)].cwd;
  if (srcDir === destDir) return;
  try {
    const moved = await window.pallet.fs.move(
      entries.map((e) => e.path),
      destDir,
    );
    if (moved.length > 0) pushUndo({ type: "move", paths: moved, backTo: srcDir, pane: id });
    refreshBoth();
    selectNames(
      otherPane(id),
      moved.map((p) => localPath.basename(p)),
    );
  } catch (err) {
    fail(err);
    refreshBoth();
  }
}

// --- undo ------------------------------------------------------------------

export async function undo(): Promise<void> {
  const entry = undoStack.pop();
  if (!entry) return;
  try {
    if (entry.type === "rename") {
      await window.pallet.fs.rename(entry.from, entry.to);
      refreshBoth();
      const pane = getState().panes[entry.pane];
      if (pane.cwd === localPath.dirname(entry.to)) {
        selectNames(entry.pane, [localPath.basename(entry.to)]);
      }
    } else {
      await window.pallet.fs.move(entry.paths, entry.backTo);
      refreshBoth();
    }
  } catch (err) {
    fail(err);
    refreshBoth();
  }
}

// --- open / reveal ---------------------------------------------------------

export function openEntry(id: PaneId, entry: Entry): void {
  if (isDirLike(entry)) {
    void navigate(id, entry.path);
  } else if (getState().panes[id].backend.kind === "local") {
    window.pallet.fs.open(entry.path).catch(fail);
  } else {
    pushToast("Opening remote files arrives with edit-in-editor (M6)", "info");
  }
}

export function openSelection(id: PaneId): void {
  for (const entry of selectedEntries(id)) {
    openEntry(id, entry);
  }
}

export function revealSelection(id: PaneId): void {
  if (!requireLocal(id)) return;
  for (const entry of selectedEntries(id)) {
    window.pallet.fs.reveal(entry.path).catch(fail);
  }
}

export function hasClipboard(): boolean {
  return clipboard !== null && clipboard.names.length > 0;
}

// --- context menu ----------------------------------------------------------

export async function showRowContextMenu(id: PaneId, entry: Entry): Promise<void> {
  const pane = getState().panes[id];
  if (!pane.selected.has(entry.name)) selectNames(id, [entry.name]);
  if (pane.backend.kind === "sftp") {
    const singleRemote = getState().panes[id].selected.size === 1;
    const sessionId = pane.backend.sessionId;
    const remoteChoice = await window.pallet.ui.contextMenu([
      { id: "open", label: "Open", enabled: isDirLike(entry) },
      {
        id: "edit",
        label: "Edit in External Editor",
        enabled: singleRemote && entry.kind === "file",
      },
      { id: "copy", label: "Copy" },
      { type: "separator" },
      { id: "rename", label: "Rename", enabled: singleRemote },
      { id: "delete", label: "Delete…" },
      { type: "separator" },
      { id: "refresh", label: "Refresh" },
    ]);
    switch (remoteChoice) {
      case "open":
        openSelection(id);
        break;
      case "edit":
        window.pallet.edit.open(sessionId, entry.path).catch(fail);
        break;
      case "copy":
        copySelection(id);
        break;
      case "rename":
        beginRename(id);
        break;
      case "delete":
        void trashSelection(id);
        break;
      case "refresh":
        refresh(id);
        break;
    }
    return;
  }
  const single = getState().panes[id].selected.size === 1;
  const choice = await window.pallet.ui.contextMenu([
    { id: "open", label: "Open" },
    { id: "reveal", label: "Reveal in Finder" },
    { type: "separator" },
    { id: "rename", label: "Rename", enabled: single },
    { id: "copy", label: "Copy" },
    { type: "separator" },
    { id: "trash", label: "Move to Trash" },
  ]);
  switch (choice) {
    case "open":
      openSelection(id);
      break;
    case "reveal":
      revealSelection(id);
      break;
    case "rename":
      beginRename(id);
      break;
    case "copy":
      copySelection(id);
      break;
    case "trash":
      void trashSelection(id);
      break;
  }
}

export async function showBackgroundContextMenu(id: PaneId): Promise<void> {
  if (getState().panes[id].backend.kind === "sftp") {
    const remoteChoice = await window.pallet.ui.contextMenu([
      { id: "newFolder", label: "New Folder" },
      { id: "paste", label: "Paste", enabled: hasClipboard() },
      { type: "separator" },
      { id: "refresh", label: "Refresh" },
    ]);
    if (remoteChoice === "newFolder") void newFolder(id);
    else if (remoteChoice === "paste") void paste(id);
    else if (remoteChoice === "refresh") refresh(id);
    return;
  }
  const choice = await window.pallet.ui.contextMenu([
    { id: "newFolder", label: "New Folder" },
    { id: "paste", label: "Paste", enabled: hasClipboard() },
    { type: "separator" },
    { id: "refresh", label: "Refresh" },
  ]);
  switch (choice) {
    case "newFolder":
      void newFolder(id);
      break;
    case "paste":
      void paste(id);
      break;
    case "refresh":
      refresh(id);
      break;
  }
}
