import type { CommandId, KeybindingsState } from "../keybindings/keybinding.types";
import type { ConflictAction, ConflictPrompt, TransferJobSnapshot, TransferRequest } from "../transfer/transfer.types";
import type { ConnectProfile, ConnectResult, HostKeyPrompt, SessionStatusEvent } from "../sftp/sftp.types";
import type { DirListing, Entry, KnownFolders, PreviewData, VolumeInfo } from "../fs/fs.types";
import type { Favorite, FavoriteInput, FavoriteSecret } from "../favorite/favorite.types";
import type { TerminalDataEvent, TerminalExitEvent } from "../terminal/terminal.types";
import type { UpdateDownloadState, UpdateInfo } from "../update/update.types";
import type { AppInfo } from "../app/app.types";
import type { ContextMenuItem } from "./ipc.types";
import type { EditEventPayload } from "../edit/edit.types";
import type { Preferences } from "../prefs/prefs.types";
import type { SizeTarget } from "../fs/fs.types";

/**
 * The contextBridge surface exposed as window.pallet.
 * Pure types only — implemented in src/preload, consumed by the renderer.
 */
export interface PalletApi {
  fs: {
    list(dirPath: string): Promise<DirListing>;
    stat(p: string): Promise<Entry>;
    homeDir(): Promise<string>;
    knownFolders(): Promise<KnownFolders>;
    volumes(): Promise<VolumeInfo[]>;
    /** Eject a mounted volume; rejects for the boot volume and unknown paths. */
    eject(path: string): Promise<void>;
    /** Create "untitled folder" (auto-numbered) in parentDir; returns its path. */
    mkdirUnique(parentDir: string): Promise<string>;
    mkdir(p: string): Promise<void>;
    /** Rename; rejects with EEXIST rather than overwriting. */
    rename(from: string, to: string): Promise<void>;
    trash(paths: string[]): Promise<void>;
    /** Copy sources into destDir; rejects with EEXIST rather than overwriting. */
    copy(sources: string[], destDir: string): Promise<string[]>;
    /** Move sources into destDir; rejects with EEXIST rather than overwriting. */
    move(sources: string[], destDir: string): Promise<string[]>;
    reveal(p: string): Promise<void>;
    open(p: string): Promise<void>;
    readPreview(p: string, maxBytes: number): Promise<PreviewData>;
  };
  sftp: {
    connect(profile: ConnectProfile): Promise<ConnectResult>;
    disconnect(sessionId: string): Promise<void>;
    reconnect(sessionId: string): Promise<void>;
    list(sessionId: string, dirPath: string): Promise<DirListing>;
    stat(sessionId: string, p: string): Promise<Entry>;
    realpath(sessionId: string, p: string): Promise<string>;
    mkdir(sessionId: string, p: string): Promise<void>;
    /** Create "untitled folder" (auto-numbered); returns the created name. */
    mkdirUnique(sessionId: string, dirPath: string): Promise<string>;
    /** Rename; rejects with EEXIST rather than overwriting. */
    rename(sessionId: string, from: string, to: string): Promise<void>;
    /** Recursive delete; symlinks unlinked, never followed. */
    remove(sessionId: string, paths: string[]): Promise<void>;
    chmod(sessionId: string, p: string, mode: number): Promise<void>;
    readPreview(sessionId: string, p: string, maxBytes: number): Promise<PreviewData>;
    /** Subscribe to session status changes; returns unsubscribe. */
    onStatus(cb: (event: SessionStatusEvent) => void): () => void;
  };
  edit: {
    /** Download to temp + open in default editor; re-uploads on save. */
    open(sessionId: string, remotePath: string): Promise<string>;
    onEvent(cb: (event: EditEventPayload) => void): () => void;
  };
  terminal: {
    /** Dial a shell for the pane's file session; output arrives via onData. */
    open(terminalId: string, sessionId: string, cols: number, rows: number): Promise<void>;
    write(terminalId: string, data: string): void;
    resize(terminalId: string, cols: number, rows: number): void;
    /** Ends the shell; no exit event follows. */
    close(terminalId: string): Promise<void>;
    onData(cb: (event: TerminalDataEvent) => void): () => void;
    onExit(cb: (event: TerminalExitEvent) => void): () => void;
    /** File → Toggle Terminal (⌃`) for the active pane. */
    onToggleRequest(cb: () => void): () => void;
  };
  transfer: {
    enqueue(request: TransferRequest): Promise<string>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    cancel(id: string): Promise<void>;
    pauseItem(id: string, name: string): Promise<void>;
    resumeItem(id: string, name: string): Promise<void>;
    cancelItem(id: string, name: string): Promise<void>;
    retry(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    resolveConflict(id: string, action: ConflictAction, applyToAll: boolean): Promise<void>;
    snapshots(): Promise<TransferJobSnapshot[]>;
    onUpdate(cb: (snapshot: TransferJobSnapshot) => void): () => void;
    onConflict(cb: (prompt: ConflictPrompt) => void): () => void;
  };
  favorites: {
    list(): Promise<Favorite[]>;
    /** secret: undefined = keep, null = clear, string/object = replace. */
    save(input: FavoriteInput, secret?: FavoriteSecret | null): Promise<Favorite>;
    remove(id: string): Promise<void>;
    reorder(ids: string[]): Promise<void>;
    /** Connects main-side with the stored secret; ENOSECRET if none. */
    connect(id: string): Promise<ConnectResult & { favorite: Favorite }>;
    /** Dial once and disconnect, so a new favorite can be validated before saving. */
    test(profile: ConnectProfile): Promise<void>;
  };
  hostKeys: {
    /** Subscribe to TOFU verification prompts; returns unsubscribe. */
    onVerify(cb: (prompt: HostKeyPrompt) => void): () => void;
    respond(requestId: string, trust: boolean): Promise<void>;
  };
  app: {
    version(): Promise<string>;
    /** Runtime versions and platform details for Settings → About. */
    info(): Promise<AppInfo>;
    /** Manual check; resolves with info when an update exists, else null. */
    checkForUpdate(): Promise<UpdateInfo | null>;
    /** Download the release DMG into ~/Downloads and mount it; resolves with its path. */
    downloadUpdate(info: UpdateInfo): Promise<string>;
    openExternal(url: string): Promise<void>;
    revealLog(): Promise<void>;
    /** Absolute path of the SQLite file, so it can be opened outside Pallet. */
    databasePath(): Promise<string>;
    onUpdateAvailable(cb: (info: UpdateInfo) => void): () => void;
    /** Subscribe to in-app DMG download progress; returns unsubscribe. */
    onUpdateDownloadState(cb: (state: UpdateDownloadState) => void): () => void;
  };
  folderSize: {
    /**
     * Total apparent bytes under a folder. Resolves null when the request was
     * cancelled before it started; cached results come back immediately.
     */
    get(target: SizeTarget, path: string): Promise<number | null>;
    /** Drop a request that hasn't started yet (row scrolled out of view). */
    cancel(target: SizeTarget, path: string): Promise<void>;
    /** Forget cached totals for a folder and everything under it. */
    invalidate(target: SizeTarget, path: string): Promise<void>;
  };
  prefs: {
    get(): Promise<Preferences>;
    /** Merges a patch; resolves with the full new set. */
    set(patch: Partial<Preferences>): Promise<Preferences>;
    /** Subscribe to changes from any window; returns unsubscribe. */
    onChange(cb: (prefs: Preferences) => void): () => void;
  };
  keybindings: {
    get(): Promise<KeybindingsState>;
    /** Persist one command's shortcuts; rejects with EKEYBINDING when invalid. */
    set(id: CommandId, keys: string[]): Promise<void>;
    /** Delete one command's overrides, restoring its defaults. */
    reset(id: CommandId): Promise<void>;
    /** Delete every override. */
    resetAll(): Promise<void>;
    /** Create keybindings.json when missing, then open it. */
    open(): Promise<void>;
    /** While true, menu accelerators for the customizable menu items are suspended. */
    setRecording(active: boolean): Promise<void>;
    /** Subscribe to effective-binding changes; returns unsubscribe. */
    onChange(cb: (state: KeybindingsState) => void): () => void;
  };
  window: {
    /** Main window only: ⌘W pressed; disconnect the active remote pane or no-op. */
    onCloseRequest(cb: () => void): () => void;
    /** main → renderer: open the Settings modal. */
    onSettingsOpen(cb: () => void): () => void;
  };
  ui: {
    /** Native context menu; resolves with the clicked item id, or null. */
    contextMenu(items: ContextMenuItem[]): Promise<string | null>;
    /** Native open-file dialog; resolves with a path or null. */
    pickFile(title: string): Promise<string | null>;
  };
}
