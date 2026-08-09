/** Favorites CRUD + connect-by-favorite (M4). */
import type { Favorite, FavoriteInput } from "@shared/favorite/favorite.types";
import { closeQuickConnect, getState, navigate, openQuickConnect, pushToast, setBackend, setFavorites } from "./pane.store";

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

/** Connect the right pane using the favorite's stored secret (main-side). */
export async function connectFavorite(favoriteId: string): Promise<void> {
  const favorite = getState().favorites.find((f) => f.id === favoriteId);
  try {
    const result = await window.pallet.favorites.connect(favoriteId);
    setBackend("right", {
      kind: "sftp",
      sessionId: result.sessionId,
      host: result.favorite.host,
      username: result.favorite.username,
      status: "connected",
    });
    await navigate("right", result.initialPath, "replace");
    closeQuickConnect();
    if (result.favorite.localPath) {
      await navigate("left", result.favorite.localPath);
    }
    await loadFavorites(); // last-used ordering may have changed
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === "ENOSECRET" && favorite) {
      // No stored secret: show Quick Connect prefilled so the user can type it.
      openQuickConnect(favorite);
      pushToast("Enter the password to connect", "info");
    } else {
      pushToast(e.message);
    }
  }
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
      void connectFavorite(favorite.id);
      return null;
    case "edit":
      return "edit";
    case "remove":
      void removeFavorite(favorite.id);
      return null;
  }
  return null;
}
