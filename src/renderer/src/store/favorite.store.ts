/** Favorites CRUD + connect-by-favorite (M4). */
import type { Favorite, FavoriteInput } from "@shared/favorite/favorite.types";
import {
  type PaneId,
  closeQuickConnect,
  connectionTargetPane,
  getState,
  navigate,
  openQuickConnect,
  pushToast,
  setActive,
  setBackend,
  setFavorites,
} from "./pane.store";
import { rememberLeftLocalPane } from "./sftp.store";

export async function loadFavorites(): Promise<void> {
  try {
    setFavorites(await window.pallet.favorites.list());
  } catch (err) {
    pushToast((err as Error).message);
  }
}

export async function saveFavorite(input: FavoriteInput, secret?: string | null): Promise<Favorite | null> {
  try {
    const saved = await window.pallet.favorites.save(input, secret);
    await loadFavorites();
    return saved;
  } catch (err) {
    pushToast((err as Error).message);
    return null;
  }
}

export async function removeFavorite(id: string): Promise<void> {
  try {
    await window.pallet.favorites.remove(id);
  } catch (err) {
    pushToast((err as Error).message);
  }
  await loadFavorites();
}

export async function reorderFavorites(ids: string[]): Promise<void> {
  try {
    await window.pallet.favorites.reorder(ids);
  } catch (err) {
    pushToast((err as Error).message);
  }
  await loadFavorites();
}

/** Connect a pane using the favorite's stored secret (main-side). */
export async function connectFavorite(favoriteId: string, paneId: PaneId = "right"): Promise<void> {
  const favorite = getState().favorites.find((f) => f.id === favoriteId);
  const previousBackend = getState().panes[paneId].backend;
  if (paneId === "left" && previousBackend.kind === "local") rememberLeftLocalPane();
  try {
    const result = await window.pallet.favorites.connect(favoriteId);
    if (previousBackend.kind === "sftp" && previousBackend.sessionId !== result.sessionId) {
      try {
        await window.pallet.sftp.disconnect(previousBackend.sessionId);
      } catch {
        // The favorite connected successfully, so stale cleanup must not block it.
      }
    }
    setBackend(paneId, {
      kind: "sftp",
      protocol: result.favorite.protocol,
      sessionId: result.sessionId,
      host: result.favorite.host,
      username: result.favorite.username,
      status: "connected",
    });
    setActive(paneId);
    await navigate(paneId, result.initialPath, "replace");
    closeQuickConnect();
    if (paneId === "right" && result.favorite.localPath && getState().panes.left.backend.kind === "local") {
      await navigate("left", result.favorite.localPath);
    }
    await loadFavorites(); // last-used ordering may have changed
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === "ENOSECRET" && favorite) {
      // No stored secret: show Quick Connect prefilled so the user can type it.
      openQuickConnect(favorite, paneId);
      pushToast("Enter the password to connect", "info");
    } else {
      pushToast(e.message);
    }
  }
}

/**
 * Connect a favorite from the sidebar. A live server in the right pane means
 * the favorite replaces the selected pane; otherwise it takes the right pane.
 */
export async function requestFavoriteConnection(favoriteId: string): Promise<void> {
  if (!getState().favorites.some((f) => f.id === favoriteId)) return;
  await connectFavorite(favoriteId, connectionTargetPane());
}

export async function favoriteContextMenu(favorite: Favorite): Promise<"edit" | null> {
  const choice = await window.pallet.ui.contextMenu([
    { id: "connect", label: "Connect" },
    { type: "separator" },
    { id: "edit", label: "Edit…" },
    { id: "remove", label: "Delete" },
  ]);
  switch (choice) {
    case "connect":
      void requestFavoriteConnection(favorite.id);
      return null;
    case "edit":
      return "edit";
    case "remove":
      void removeFavorite(favorite.id);
      return null;
  }
  return null;
}
