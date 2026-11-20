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
  setSettingsOpen,
  setShowHidden,
  switchPane,
  useAppState,
} from "@/store/pane.store";
import { disconnectPane, initSftpEvents } from "@/store/sftp.store";
import { getKeybindingLookup, initKeybindings } from "@/store/keybinding.store";
import { useEffect, useState } from "react";
import { COMMAND_BY_ID } from "@shared/keybindings/keybinding.constants";
import { ConfirmDeleteDialog } from "@/components/browser/ConfirmDeleteDialog";
import { ConflictDialog } from "@/components/transfer/ConflictDialog";
import { ConnectDialog } from "@/components/connection/QuickConnect";
import { GoToDialog } from "@/components/browser/GoToDialog";
import { HostKeyDialog } from "@/components/connection/HostKeyDialog";
import { Inspector } from "@/components/browser/Inspector";
import { Pane } from "@/components/browser/Pane";
import { PendingPane } from "@/components/browser/PendingPane";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { Sidebar } from "@/components/connection/Sidebar";
import { Toasts } from "@/components/feedback/Toasts";
import { Toolbar } from "@/components/browser/Toolbar";
import { TransferPanel } from "@/components/transfer/TransferPanel";
import { UpdateToast } from "@/components/feedback/UpdateToast";
import { eventToKey } from "@shared/keybindings/keybinding.utils";
import { initTerminalEvents } from "@/store/terminal.store";
import { initTransferEvents } from "@/store/transfer.store";
import { loadFavorites } from "@/store/favorite.store";
import { visibleEntries } from "@/lib/entry.utils";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

function isFileContext(e: KeyboardEvent, key: string): boolean {
  const t = e.target;
  if (!(t instanceof Element)) return false;
  if (isEditableTarget(t)) return false;
  const hasCommandModifier = key
    .split("+")
    .slice(0, -1)
    .some((modifier) => modifier === "cmd" || modifier === "ctrl" || modifier === "alt");
  if (
    !hasCommandModifier &&
    t.closest("button, a, select, [role='menu'], [role='dialog'], [role='menuitem'], [role='checkbox']")
  ) {
    return false;
  }
  return true;
}

function handleKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const key = eventToKey(e);
  if (key === null) return;

  const command = getKeybindingLookup().get(key);
  const spec = command ? COMMAND_BY_ID.get(command) : undefined;

  if (isEditableTarget(e.target)) return;
  if (isModalOpen()) return;

  if (command && spec?.scope === "pane-switch") {
    const focused = e.target instanceof Element && !e.target.closest("[role='dialog'], input, textarea, [contenteditable]");
    if (focused && getState().panes.right.backend.kind !== "none" && getState().connecting?.paneId !== "right") {
      e.preventDefault();
      switchPane();
    }
    return;
  }

  if (!isFileContext(e, key)) return;

  const state = getState();
  const id = state.active;
  const pane = state.panes[id];
  if (pane.view === "terminal") return;
  const visible = visibleEntries(pane.entries, pane.sortKey, pane.sortDir, state.showHidden, state.foldersFirst);

  if (key === "up" || key === "down" || key === "shift+up" || key === "shift+down") {
    const extend = key.startsWith("shift+");
    e.preventDefault();
    if (key === "up" || key === "shift+up") moveFocus(id, -1, extend, visible);
    else moveFocus(id, 1, extend, visible);
    return;
  }

  if (!command || spec?.scope !== "files") return;

  switch (command) {
    case "navigation.open":
      e.preventDefault();
      openSelection(id);
      return;
    case "navigation.goUp":
      e.preventDefault();
      goUp(id);
      return;
    case "navigation.goToFolder":
      e.preventDefault();
      setGoToOpen(true);
      return;
    case "navigation.refresh":
      e.preventDefault();
      refresh(id);
      return;
    case "navigation.selectAll":
      e.preventDefault();
      selectAll(id, visible);
      return;
    case "navigation.clearSelection":
      clearSelection(id);
      return;
    case "navigation.toggleHidden":
      e.preventDefault();
      setShowHidden(!state.showHidden);
      return;
    case "files.rename":
      if (!key.split("+").includes("cmd") && pane.selected.size === 1) {
        e.preventDefault();
        beginRename(id);
      }
      return;
    case "files.newFolder":
      e.preventDefault();
      void newFolder(id);
      return;
    case "files.trash":
      e.preventDefault();
      void trashSelection(id);
      return;
    case "files.undo":
      e.preventDefault();
      void undo();
      return;
    case "transfers.copyToOther":
      e.preventDefault();
      void copyToOther(id);
      return;
    case "transfers.moveToOther":
      e.preventDefault();
      void moveToOther(id);
      return;
    case "transfers.copy":
      e.preventDefault();
      copySelection(id);
      return;
    case "transfers.paste":
      e.preventDefault();
      void paste(id);
      return;
    case "panels.toggleInspector":
      e.preventDefault();
      setInspectorOpen(!state.inspectorOpen);
      return;
    case "panels.connect":
      e.preventDefault();
      openQuickConnect();
      return;
  }
}

function useHeldValue<T>(value: T | null, holdMs: number): T | null {
  const [held, setHeld] = useState<T | null>(value);
  const [previous, setPrevious] = useState<T | null>(value);

  if (value !== previous) {
    setPrevious(value);
    if (value !== null) setHeld(value);
  }

  useEffect(() => {
    if (value !== null || held === null) return;
    const timer = window.setTimeout(() => setHeld(null), holdMs);
    return () => window.clearTimeout(timer);
  }, [value, held, holdMs]);

  return value ?? held;
}

function App(): React.JSX.Element {
  const app = useAppState();
  const right = app.panes.right;
  const pendingRight = app.connecting?.paneId === "right" ? app.connecting : null;
  const skeletonLive = pendingRight !== null && right.cwd === "";
  const heldAttempt = useHeldValue(skeletonLive ? pendingRight : null, 190);
  const skeletonLeaving = heldAttempt !== null && !skeletonLive;
  const hasRightPane = right.backend.kind !== "none" || heldAttempt !== null;

  useEffect(() => {
    initSftpEvents();
    initTransferEvents();
    initTerminalEvents();
    initKeybindings();
    void initApp();
    void loadFavorites();
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    return window.pallet.window.onCloseRequest(() => {
      const state = getState();
      if (state.panes[state.active].backend.kind === "sftp") {
        void disconnectPane(state.active);
      }
    });
  }, []);

  useEffect(() => {
    return window.pallet.window.onSettingsOpen(() => setSettingsOpen(true));
  }, []);

  return (
    <div className="flex h-full select-none">
      <Sidebar />
      <div className="relative flex w-full flex-col overflow-hidden">
        <Toolbar />
        <div className="flex min-h-0 flex-1">
          <Pane paneId="left" />
          {hasRightPane && (
            <>
              <div className="bg-border w-px shrink-0" />
              <div className="bg-background relative flex min-w-0 flex-1 overflow-hidden">
                {right.backend.kind !== "none" && <Pane paneId="right" />}
                {heldAttempt && (
                  <PendingPane
                    attempt={heldAttempt}
                    isActive={app.active === "right"}
                    leaving={skeletonLeaving}
                  />
                )}
              </div>
            </>
          )}
          <Inspector />
        </div>
        <TransferPanel />
        <ConnectDialog />
        <GoToDialog />
        <HostKeyDialog />
        <ConflictDialog />
        <ConfirmDeleteDialog />
        {/* Rendered last so it stacks on top of the other dialogs; Base UI's
            topmost dialog owns the focus trap. Settings nests the Favorites
            add/edit form, which then never closes the tab behind it. */}
        <SettingsDialog />
        <Toasts />
        <UpdateToast />
      </div>
    </div>
  );
}

export default App;
