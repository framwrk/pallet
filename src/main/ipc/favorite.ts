import * as store from "../services/favorite-store.service";
import type { ConnectProfile, ConnectResult } from "@shared/sftp/sftp.types";
import type { Favorite, FavoriteInput, FavoriteSecret } from "@shared/favorite/favorite.types";
import { FavoriteChannels } from "@shared/ipc/ipc.constants";
import type { IpcResult } from "@shared/ipc/ipc.types";
import { ipcMain } from "electron";
import { parseS3Secret } from "../services/s3/s3-secret";
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
async function connectFavorite(id: string, attemptId?: string): Promise<ConnectResult & { favorite: Favorite }> {
  const favorite = store.getFavorite(id);
  if (!favorite) throw new Error("Favorite not found");

  let profile: ConnectProfile;
  if (favorite.authMethod === "s3") {
    if (favorite.protocol !== "s3") {
      const err: NodeJS.ErrnoException = new Error("S3 credentials are only available for S3 favorites");
      err.code = "EINVAL";
      throw err;
    }
    const region = favorite.s3Region;
    const bucket = favorite.s3Bucket;
    if (!region || !bucket) {
      const err: NodeJS.ErrnoException = new Error("S3 region and bucket are required");
      err.code = "EINVAL";
      throw err;
    }
    const secret = favorite.secretStored ? parseS3Secret(readSecret(id)) : null;
    if (!secret) {
      const err: NodeJS.ErrnoException = new Error("Enter S3 credentials for this favorite");
      err.code = "ENOSECRET";
      throw err;
    }
    profile = {
      protocol: "s3",
      host: favorite.host,
      port: favorite.port,
      username: favorite.username,
      auth: {
        method: "s3",
        secretAccessKey: secret.secretAccessKey,
        ...(secret.sessionToken ? { sessionToken: secret.sessionToken } : {}),
      },
      s3: {
        ...(favorite.s3Endpoint ? { endpoint: favorite.s3Endpoint } : {}),
        region,
        bucket,
        forcePathStyle: favorite.s3ForcePathStyle,
      },
      ...(favorite.remotePath ? { remotePath: favorite.remotePath } : {}),
    };
  } else if (favorite.authMethod === "agent") {
    if (favorite.protocol !== "sftp") throw new Error("SSH agent authentication is only available for SFTP");
    profile = {
      protocol: favorite.protocol,
      host: favorite.host,
      port: favorite.port,
      username: favorite.username,
      auth: { method: "agent" },
      ...(favorite.remotePath ? { remotePath: favorite.remotePath } : {}),
    };
  } else {
    const secret = favorite.secretStored ? readSecret(id) : null;
    if (favorite.authMethod === "password") {
      if (secret == null) {
        const err: NodeJS.ErrnoException = new Error("No stored password for this favorite");
        err.code = "ENOSECRET";
        throw err;
      }
      profile = {
        protocol: favorite.protocol,
        host: favorite.host,
        port: favorite.port,
        username: favorite.username,
        auth: { method: "password", password: secret },
        ...(favorite.protocol === "ftps" ? { tlsRejectUnauthorized: favorite.tlsRejectUnauthorized !== false } : {}),
        ...(favorite.remotePath ? { remotePath: favorite.remotePath } : {}),
      };
    } else {
      if (favorite.protocol !== "sftp") throw new Error("FTP and FTPS favorites require password authentication");
      if (!favorite.privateKeyPath) {
        const err: NodeJS.ErrnoException = new Error("Favorite has no private key path");
        err.code = "ENOSECRET";
        throw err;
      }
      profile = {
        protocol: favorite.protocol,
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
  }

  const result = await sessionManager.connect(profile, attemptId);
  store.touchLastUsed(id);
  return { ...result, favorite: store.getFavorite(id) ?? favorite };
}

/**
 * Validate connection details before a favorite is saved: dial once, then
 * close the session. Host-key verification still prompts through the normal
 * TOFU flow, so a first contact is the only extra interaction.
 */
async function testConnection(profile: ConnectProfile): Promise<void> {
  const { sessionId } = await sessionManager.connect(profile);
  sessionManager.disconnect(sessionId);
}

export function registerFavoriteHandlers(): void {
  handle(FavoriteChannels.list, () => store.listFavorites());
  handle(FavoriteChannels.save, (input: FavoriteInput, secret?: FavoriteSecret | null) => store.saveFavorite(input, secret));
  handle(FavoriteChannels.remove, (id: string) => store.removeFavorite(id));
  handle(FavoriteChannels.reorder, (ids: string[]) => store.reorderFavorites(ids));
  handle(FavoriteChannels.connect, connectFavorite);
  handle(FavoriteChannels.test, testConnection);
}
