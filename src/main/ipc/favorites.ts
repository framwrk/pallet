import * as store from "../services/favorites-store";
import type { ConnectProfile, ConnectResult, Favorite, FavoriteInput, IpcResult } from "../../shared/types";
import { FavoriteChannels } from "../../shared/ipc";
import { ipcMain } from "electron";
import { readSecret } from "../services/secrets";
import { sessionManager } from "./sftp";

function handle<Args extends unknown[], T>(channel: string, fn: (...args: Args) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<T>> => {
    try {
      return { ok: true, value: await fn(...(args as Args)) };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { ok: false, error: { code: e.code ?? "EUNKNOWN", message: e.message ?? String(err) } };
    }
  });
}

/**
 * Connect with the favorite's stored secret, entirely main-side: the secret
 * is decrypted here and goes straight into the ssh2 config.
 */
async function connectFavorite(id: string): Promise<ConnectResult & { favorite: Favorite }> {
  const favorite = store.getFavorite(id);
  if (!favorite) throw new Error("Favorite not found");
  const secret = favorite.secretStored ? readSecret(id) : null;

  let profile: ConnectProfile;
  if (favorite.authMethod === "password") {
    if (secret == null) {
      const err: NodeJS.ErrnoException = new Error("No stored password for this favorite");
      err.code = "ENOSECRET";
      throw err;
    }
    profile = {
      host: favorite.host,
      port: favorite.port,
      username: favorite.username,
      auth: { method: "password", password: secret },
      ...(favorite.remotePath ? { remotePath: favorite.remotePath } : {}),
    };
  } else {
    if (!favorite.privateKeyPath) {
      const err: NodeJS.ErrnoException = new Error("Favorite has no private key path");
      err.code = "ENOSECRET";
      throw err;
    }
    profile = {
      host: favorite.host,
      port: favorite.port,
      username: favorite.username,
      auth: {
        method: "key",
        keyPath: favorite.privateKeyPath,
        ...(secret ? { passphrase: secret } : {}),
      },
      ...(favorite.remotePath ? { remotePath: favorite.remotePath } : {}),
    };
  }

  const result = await sessionManager.connect(profile);
  store.touchLastUsed(id);
  return { ...result, favorite: store.getFavorite(id) ?? favorite };
}

export function registerFavoriteHandlers(): void {
  handle(FavoriteChannels.list, () => store.listFavorites());
  handle(FavoriteChannels.save, (input: FavoriteInput, secret?: string | null) => store.saveFavorite(input, secret));
  handle(FavoriteChannels.remove, (id: string) => store.removeFavorite(id));
  handle(FavoriteChannels.reorder, (ids: string[]) => store.reorderFavorites(ids));
  handle(FavoriteChannels.connect, connectFavorite);
}
