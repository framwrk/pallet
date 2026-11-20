/** Favorites CRUD + connect-by-favorite (M4). */
import type { Favorite, FavoriteInput, FavoriteSecret } from "@shared/favorite/favorite.types";
import {
  type PaneId,
  beginConnection,
  closeQuickConnect,
  connectionTargetPane,
  dismissConnectionToast,
  endConnection,
  getState,
  isCurrentConnection,
  navigate,
  openQuickConnect,
  pushToast,
  setActive,
  setBackend,
  setFavorites,
} from "./pane.store";
import { closeIfCancelled, dropIfCancelled, rememberLeftLocalPane } from "./sftp.store";
import { expandHome } from "@shared/path/path.utils";

export async function loadFavorites(): Promise<void> {
  try {
    setFavorites(await window.pallet.favorites.list());
  } catch (err) {
    pushToast((err as Error).message);
  }
}

export async function saveFavorite(input: FavoriteInput, secret?: FavoriteSecret | null): Promise<Favorite | null> {
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
  if (!favorite) return;
  const attemptId = beginConnection({ paneId, label: favorite.name, host: favorite.host, favoriteId });
  if (!attemptId) {
    const pending = getState().connecting;
    pushToast(`Connecting to ${pending?.label ?? "another server"} — wait for it to finish`, "info");
    return;
  }
  const previousBackend = getState().panes[paneId].backend;
  if (paneId === "left" && previousBackend.kind === "local") rememberLeftLocalPane();
  let needsSecret = false;
  try {
    const result = await window.pallet.favorites.connect(favoriteId, attemptId);
    await dropIfCancelled(attemptId, result.sessionId);
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
      ...(result.favorite.protocol === "s3"
        ? {
            s3: {
              bucket: result.favorite.s3Bucket ?? result.favorite.host,
              ...(result.favorite.s3Endpoint ? { endpoint: result.favorite.s3Endpoint } : {}),
              region: result.favorite.s3Region ?? "",
              ...(result.favorite.remotePath ? { prefix: result.favorite.remotePath } : {}),
            },
          }
        : {}),
    });
    setActive(paneId);
    // The session is live, so the progress toast can go before the listing loads.
    dismissConnectionToast();
    await navigate(paneId, result.initialPath, "replace");
    await closeIfCancelled(attemptId, paneId);
    closeQuickConnect();
    if (paneId === "right" && result.favorite.localPath && getState().panes.left.backend.kind === "local") {
      await navigate("left", expandHome(result.favorite.localPath, await window.pallet.fs.homeDir()));
    }
    await loadFavorites(); // last-used ordering may have changed
  } catch (err) {
    const e = err as Error & { code?: string };
    if (!isCurrentConnection(attemptId)) {
      // The user asked for this; nothing to report.
    } else if (e.code === "ENOSECRET") {
      // No stored secret: show Quick Connect prefilled so the user can type it.
      needsSecret = true;
    } else {
      pushToast(e.message);
    }
  } finally {
    endConnection(attemptId);
  }
  if (needsSecret) {
    openQuickConnect(favorite, paneId);
    pushToast(favorite.protocol === "s3" ? "Enter S3 credentials to connect" : "Enter the password to connect", "info");
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
