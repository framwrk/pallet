import {
  AppChannels,
  EditChannels,
  FavoriteChannels,
  FolderSizeChannels,
  FsChannels,
  HostKeyChannels,
  PrefChannels,
  SettingsChannels,
  SftpChannels,
  TransferChannels,
  UiChannels,
} from "@shared/ipc/ipc.constants";
import type { ConflictAction, ConflictPrompt, TransferJobSnapshot, TransferRequest } from "@shared/transfer/transfer.types";
import type { ConnectProfile, ConnectResult, HostKeyPrompt, SessionStatusEvent } from "@shared/sftp/sftp.types";
import type { ContextMenuItem, IpcResult } from "@shared/ipc/ipc.types";
import type { DirListing, Entry, KnownFolders, PreviewData, SizeTarget, VolumeInfo } from "@shared/fs/fs.types";
import type { Favorite, FavoriteInput } from "@shared/favorite/favorite.types";
import { contextBridge, ipcRenderer } from "electron";
import type { EditEventPayload } from "@shared/edit/edit.types";
import type { PalletApi } from "@shared/ipc/ipc-api.types";
import type { Preferences } from "@shared/prefs/prefs.types";

/** Error surfaced to the renderer with a stable machine-readable code. */
export class PalletError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PalletError";
    this.code = code;
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) {
    throw new PalletError(result.error.code, result.error.message);
  }
  return result.value;
}

const pallet: PalletApi = {
  fs: {
    list: (dirPath: string): Promise<DirListing> => invoke(FsChannels.list, dirPath),
    stat: (p: string): Promise<Entry> => invoke(FsChannels.stat, p),
    homeDir: (): Promise<string> => invoke(FsChannels.homeDir),
    knownFolders: (): Promise<KnownFolders> => invoke(FsChannels.knownFolders),
    volumes: (): Promise<VolumeInfo[]> => invoke(FsChannels.volumes),
    mkdirUnique: (parentDir: string): Promise<string> => invoke(FsChannels.mkdirUnique, parentDir),
    mkdir: (p: string): Promise<void> => invoke(FsChannels.mkdir, p),
    rename: (from: string, to: string): Promise<void> => invoke(FsChannels.rename, from, to),
    trash: (paths: string[]): Promise<void> => invoke(FsChannels.trash, paths),
    copy: (sources: string[], destDir: string): Promise<string[]> => invoke(FsChannels.copy, sources, destDir),
    move: (sources: string[], destDir: string): Promise<string[]> => invoke(FsChannels.move, sources, destDir),
    reveal: (p: string): Promise<void> => invoke(FsChannels.reveal, p),
    open: (p: string): Promise<void> => invoke(FsChannels.open, p),
    readPreview: (p: string, maxBytes: number): Promise<PreviewData> => invoke(FsChannels.readPreview, p, maxBytes),
  },
  sftp: {
    connect: (profile: ConnectProfile): Promise<ConnectResult> => invoke(SftpChannels.connect, profile),
    disconnect: (sessionId: string): Promise<void> => invoke(SftpChannels.disconnect, sessionId),
    reconnect: (sessionId: string): Promise<void> => invoke(SftpChannels.reconnect, sessionId),
    list: (sessionId: string, dirPath: string): Promise<DirListing> => invoke(SftpChannels.list, sessionId, dirPath),
    stat: (sessionId: string, p: string): Promise<Entry> => invoke(SftpChannels.stat, sessionId, p),
    realpath: (sessionId: string, p: string): Promise<string> => invoke(SftpChannels.realpath, sessionId, p),
    mkdir: (sessionId: string, p: string): Promise<void> => invoke(SftpChannels.mkdir, sessionId, p),
    mkdirUnique: (sessionId: string, dirPath: string): Promise<string> => invoke(SftpChannels.mkdirUnique, sessionId, dirPath),
    rename: (sessionId: string, from: string, to: string): Promise<void> => invoke(SftpChannels.rename, sessionId, from, to),
    remove: (sessionId: string, paths: string[]): Promise<void> => invoke(SftpChannels.remove, sessionId, paths),
    chmod: (sessionId: string, p: string, mode: number): Promise<void> => invoke(SftpChannels.chmod, sessionId, p, mode),
    readPreview: (sessionId: string, p: string, maxBytes: number): Promise<PreviewData> =>
      invoke(SftpChannels.readPreview, sessionId, p, maxBytes),
    onStatus: (cb: (event: SessionStatusEvent) => void): (() => void) => subscribe(SftpChannels.status, cb),
  },
  edit: {
    open: (sessionId: string, remotePath: string): Promise<string> => invoke(EditChannels.open, sessionId, remotePath),
    onEvent: (cb: (event: EditEventPayload) => void): (() => void) => subscribe(EditChannels.event, cb),
  },
  transfer: {
    enqueue: (request: TransferRequest): Promise<string> => invoke(TransferChannels.enqueue, request),
    pause: (id: string): Promise<void> => invoke(TransferChannels.pause, id),
    resume: (id: string): Promise<void> => invoke(TransferChannels.resume, id),
    cancel: (id: string): Promise<void> => invoke(TransferChannels.cancel, id),
    retry: (id: string): Promise<void> => invoke(TransferChannels.retry, id),
    remove: (id: string): Promise<void> => invoke(TransferChannels.remove, id),
    resolveConflict: (id: string, action: ConflictAction, applyToAll: boolean): Promise<void> =>
      invoke(TransferChannels.resolveConflict, id, action, applyToAll),
    snapshots: (): Promise<TransferJobSnapshot[]> => invoke(TransferChannels.snapshots),
    onUpdate: (cb: (snapshot: TransferJobSnapshot) => void): (() => void) => subscribe(TransferChannels.update, cb),
    onConflict: (cb: (prompt: ConflictPrompt) => void): (() => void) => subscribe(TransferChannels.conflict, cb),
  },
  favorites: {
    list: (): Promise<Favorite[]> => invoke(FavoriteChannels.list),
    save: (input: FavoriteInput, secret?: string | null): Promise<Favorite> => invoke(FavoriteChannels.save, input, secret),
    remove: (id: string): Promise<void> => invoke(FavoriteChannels.remove, id),
    reorder: (ids: string[]): Promise<void> => invoke(FavoriteChannels.reorder, ids),
    connect: (id: string): Promise<ConnectResult & { favorite: Favorite }> => invoke(FavoriteChannels.connect, id),
  },
  hostKeys: {
    onVerify: (cb: (prompt: HostKeyPrompt) => void): (() => void) => subscribe(HostKeyChannels.verify, cb),
    respond: (requestId: string, trust: boolean): Promise<void> => invoke(HostKeyChannels.respond, requestId, trust),
  },
  app: {
    version: (): Promise<string> => invoke(AppChannels.version),
    checkForUpdate: (): Promise<{ version: string; url: string; prerelease: boolean } | null> =>
      invoke(AppChannels.checkForUpdate),
    openExternal: (url: string): Promise<void> => invoke(AppChannels.openExternal, url),
    revealLog: (): Promise<void> => invoke(AppChannels.revealLog),
    databasePath: (): Promise<string> => invoke(AppChannels.databasePath),
    onUpdateAvailable: (cb: (info: { version: string; url: string; prerelease: boolean }) => void): (() => void) =>
      subscribe(AppChannels.updateAvailable, cb),
  },
  folderSize: {
    get: (target: SizeTarget, path: string): Promise<number | null> => invoke(FolderSizeChannels.get, target, path),
    cancel: (target: SizeTarget, path: string): Promise<void> => invoke(FolderSizeChannels.cancel, target, path),
    invalidate: (target: SizeTarget, path: string): Promise<void> => invoke(FolderSizeChannels.invalidate, target, path),
  },
  prefs: {
    get: (): Promise<Preferences> => invoke(PrefChannels.get),
    set: (patch: Partial<Preferences>): Promise<Preferences> => invoke(PrefChannels.set, patch),
    onChange: (cb: (prefs: Preferences) => void): (() => void) => subscribe(PrefChannels.changed, cb),
  },
  settings: {
    resize: (contentHeight: number, title: string): Promise<void> => invoke(SettingsChannels.resize, contentHeight, title),
  },
  ui: {
    contextMenu: (items: ContextMenuItem[]): Promise<string | null> => invoke(UiChannels.contextMenu, items),
    pickFile: (title: string): Promise<string | null> => invoke(UiChannels.pickFile, title),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("pallet", pallet);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (define in dts)
  window.pallet = pallet;
}
