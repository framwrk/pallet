import {
  beginRename,
  copySelection,
  copyToOther,
  moveToOther,
  newFolder,
  openSelection,
  paste,
  trashSelection,
  undo,
} from "@/store/ops.store";
import {
  clearSelection,
  getState,
  goUp,
  initApp,
  isModalOpen,
  moveFocus,
  openQuickConnect,
  refresh,
  selectAll,
  setGoToOpen,
  setInspectorOpen,
  setShowHidden,
  switchPane,
  useAppState,
} from "@/store/pane.store";
import { disconnectRemote, initSftpEvents } from "@/store/sftp.store";
import { ConfirmDeleteDialog } from "@/components/browser/ConfirmDeleteDialog";
import { ConflictDialog } from "@/components/transfer/ConflictDialog";
import { ConnectDialog } from "@/components/connection/QuickConnect";
import { FavoriteDialog } from "@/components/connection/FavoriteDialog";
import { GoToDialog } from "@/components/browser/GoToDialog";
import { HostKeyDialog } from "@/components/connection/HostKeyDialog";
import { Inspector } from "@/components/browser/Inspector";
import { Pane } from "@/components/browser/Pane";
import { QueueDrawer } from "@/components/transfer/QueueDrawer";
import { Sidebar } from "@/components/connection/Sidebar";
import { Toasts } from "@/components/feedback/Toasts";
import { Toolbar } from "@/components/browser/Toolbar";
import { UpdateToast } from "@/components/feedback/UpdateToast";
import { initTransferEvents } from "@/store/transfer.store";
import { loadFavorites } from "@/store/favorite.store";
import { useEffect } from "react";
import { visibleEntries } from "@/lib/entry.utils";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/**
 * True when the key event belongs to the file lists (the window handler's
 * jurisdiction). Plain keys yield to whatever widget is focused — buttons,
 * menus, checkboxes keep their own Enter/Space/arrows — while ⌘-combos stay
 * available: they never collide with widget activation (Finder keeps ⌘C
 * working with a toolbar button focused). Dialogs and text fields were
 * already excluded by the caller.
 */
function isFileContext(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey) return false;
  const t = e.target;
  if (!(t instanceof Element)) return false;
  if (isEditableTarget(t)) return false;
  if (!e.metaKey && t.closest("button, a, select, [role='menu'], [role='dialog'], [role='menuitem'], [role='checkbox']")) {
    return false;
  }
  return true;
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (isEditableTarget(e.target)) return;
  if (isModalOpen()) return;

  // Tab is the pane switch wherever focus is (Total Commander), except inside
  // dialogs and text fields. With a single pane (disconnected) it falls
  // through so native traversal can move focus — previously it was swallowed
  // here and switchPane() also no-op'd, leaving focus stuck on the document.
  const focused = e.target instanceof Element && !e.target.closest("[role='dialog'], input, textarea, [contenteditable]");
  if (e.key === "Tab" && focused && getState().panes.right.backend.kind !== "none") {
    e.preventDefault();
    switchPane();
    return;
  }

  if (!isFileContext(e)) return;

  const state = getState();
  const id = state.active;
  const pane = state.panes[id];
  const visible = visibleEntries(pane.entries, pane.sortKey, pane.sortDir, state.showHidden);
  const meta = e.metaKey;
  const shift = e.shiftKey;

  switch (e.key) {
    case "Enter":
      // Finder convention: Enter renames (plan §9.3); ⌘↓/⌘O opens.
      if (!meta && pane.selected.size === 1) {
        e.preventDefault();
        beginRename(id);
      }
      return;
    case "F5":
      e.preventDefault();
      void copyToOther(id);
      return;
    case "F6":
      e.preventDefault();
      void moveToOther(id);
      return;
    case "Backspace":
      if (meta) {
        e.preventDefault();
        void trashSelection(id);
      }
      return;
    case "ArrowUp":
      if (meta) {
        e.preventDefault();
        goUp(id);
      } else {
        e.preventDefault();
        moveFocus(id, -1, shift, visible);
      }
      return;
    case "ArrowDown":
      e.preventDefault();
      if (meta) {
        openSelection(id);
      } else {
        moveFocus(id, 1, shift, visible);
      }
      return;
    case "Escape":
      clearSelection(id);
      return;
    case " ":
      // Space = preview (§4): the inspector hosts the preview.
      e.preventDefault();
      setInspectorOpen(!state.inspectorOpen);
      return;
  }

  if (!meta) return;

  // Matched on e.code, not e.key: with Shift held this key reports ">".
  if (shift && e.code === "Period") {
    e.preventDefault();
    setShowHidden(!state.showHidden);
    return;
  }

  switch (e.key.toLowerCase()) {
    case "r":
      e.preventDefault();
      refresh(id);
      return;
    case "a":
      e.preventDefault();
      selectAll(id, visible);
      return;
    case "g":
      if (shift) {
        e.preventDefault();
        setGoToOpen(true);
      }
      return;
    case "k":
      e.preventDefault();
      openQuickConnect();
      return;
    case "i":
      e.preventDefault();
      setInspectorOpen(!state.inspectorOpen);
      return;
    case "o":
      e.preventDefault();
      openSelection(id);
      return;
    case "c":
      e.preventDefault();
      copySelection(id);
      return;
    case "v":
      e.preventDefault();
      void paste(id);
      return;
    case "d":
      e.preventDefault();
      void copyToOther(id);
      return;
    case "n":
      if (shift) {
        e.preventDefault();
        void newFolder(id);
      }
      return;
    case "z":
      if (!shift) {
        e.preventDefault();
        void undo();
      }
      return;
  }
}

function App(): React.JSX.Element {
  const app = useAppState();
  const hasRemotePane = app.panes.right.backend.kind === "sftp";

  useEffect(() => {
    initSftpEvents();
    initTransferEvents();
    void initApp();
    void loadFavorites();
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ⌘W arrives from the app menu (accelerators outrun renderer keydowns):
  // with the remote pane selected it disconnects it, otherwise it closes the
  // window as the stock Close would.
  useEffect(() => {
    return window.pallet.window.onCloseRequest(() => {
      const state = getState();
      if (state.active === "right" && state.panes.right.backend.kind === "sftp") {
        void disconnectRemote();
      } else {
        window.close();
      }
    });
  }, []);

  return (
    <div className="flex h-full select-none">
      <Sidebar />
      <div className="flex w-full flex-col overflow-hidden">
        <Toolbar />
        <div className="flex min-h-0 flex-1">
          <Pane paneId="left" />
          {hasRemotePane && (
            <>
              <div className="bg-border w-px shrink-0" />
              <Pane paneId="right" />
            </>
          )}
          <Inspector />
        </div>
        <QueueDrawer />
        <ConnectDialog />
        <GoToDialog />
        <FavoriteDialog />
        <HostKeyDialog />
        <ConflictDialog />
        <ConfirmDeleteDialog />
        <Toasts />
        <UpdateToast />
      </div>
    </div>
  );
}

export default App;
