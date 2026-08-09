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
  moveFocus,
  refresh,
  selectAll,
  setConnectOpen,
  setGoToOpen,
  setInspectorOpen,
  setShowHidden,
  switchPane,
} from "@/store/pane.store";
import { ConfirmDeleteDialog } from "@/components/browser/ConfirmDeleteDialog";
import { ConflictDialog } from "@/components/transfer/ConflictDialog";
import { ConnectDialog } from "@/components/connection/ConnectDialog";
import { GoToDialog } from "@/components/browser/GoToDialog";
import { HostKeyDialog } from "@/components/connection/HostKeyDialog";
import { Inspector } from "@/components/browser/Inspector";
import { Pane } from "@/components/browser/Pane";
import { QueueDrawer } from "@/components/transfer/QueueDrawer";
import { Sidebar } from "@/components/connection/Sidebar";
import { Toasts } from "@/components/feedback/Toasts";
import { Toolbar } from "@/components/browser/Toolbar";
import { UpdateToast } from "@/components/feedback/UpdateToast";
import { initSftpEvents } from "@/store/sftp.store";
import { initTransferEvents } from "@/store/transfer.store";
import { loadFavorites } from "@/store/favorite.store";
import { useEffect } from "react";
import { visibleEntries } from "@/lib/entry.utils";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function handleKeyDown(e: KeyboardEvent): void {
  const state = getState();
  if (
    state.goToOpen ||
    state.connectOpen ||
    state.hostKeyPrompts.length > 0 ||
    state.confirmDelete !== null ||
    isEditableTarget(e.target)
  ) {
    return;
  }

  const id = state.active;
  const pane = state.panes[id];
  const visible = visibleEntries(pane.entries, pane.sortKey, pane.sortDir, state.showHidden);
  const meta = e.metaKey;
  const shift = e.shiftKey;

  switch (e.key) {
    case "Tab":
      e.preventDefault();
      switchPane();
      return;
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
      setConnectOpen(true);
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

  return (
    <div className="flex h-full select-none">
      <Sidebar />
      <div className="flex w-full flex-col overflow-hidden">
        <Toolbar />
        <div className="flex min-h-0 flex-1">
          <Pane paneId="left" />
          <div className="bg-border w-px shrink-0" />
          <Pane paneId="right" />
          <Inspector />
        </div>
        <QueueDrawer />
        <GoToDialog />
        <ConnectDialog />
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
