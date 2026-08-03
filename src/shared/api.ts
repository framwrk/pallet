import type { ConflictAction, ConflictPrompt, TransferJobSnapshot, TransferRequest } from "./transfers";
import type {
  ConnectProfile,
  ConnectResult,
  ContextMenuItem,
  DirListing,
  EditEventPayload,
  Entry,
  Favorite,
  FavoriteInput,
  HostKeyPrompt,
  KnownFolders,
  PreviewData,
  SessionStatusEvent,
  VolumeInfo,
} from "./types";

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
  transfer: {
    enqueue(request: TransferRequest): Promise<string>;
    pause(id: string): Promise<void>;
    resume(id: string): Promise<void>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    resolveConflict(id: string, action: ConflictAction, applyToAll: boolean): Promise<void>;
    snapshots(): Promise<TransferJobSnapshot[]>;
    onUpdate(cb: (snapshot: TransferJobSnapshot) => void): () => void;
    onConflict(cb: (prompt: ConflictPrompt) => void): () => void;
  };
  favorites: {
    list(): Promise<Favorite[]>;
    /** secret: undefined = keep, null = clear, string = replace. */
    save(input: FavoriteInput, secret?: string | null): Promise<Favorite>;
    remove(id: string): Promise<void>;
    reorder(ids: string[]): Promise<void>;
    /** Connects main-side with the stored secret; ENOSECRET if none. */
    connect(id: string): Promise<ConnectResult & { favorite: Favorite }>;
  };
  hostKeys: {
    /** Subscribe to TOFU verification prompts; returns unsubscribe. */
    onVerify(cb: (prompt: HostKeyPrompt) => void): () => void;
    respond(requestId: string, trust: boolean): Promise<void>;
  };
  app: {
    version(): Promise<string>;
    /** Manual check; resolves with info when an update exists, else null. */
    checkForUpdate(): Promise<{ version: string; url: string; prerelease: boolean } | null>;
    openExternal(url: string): Promise<void>;
    revealLog(): Promise<void>;
    onUpdateAvailable(cb: (info: { version: string; url: string; prerelease: boolean }) => void): () => void;
  };
  ui: {
    /** Native context menu; resolves with the clicked item id, or null. */
    contextMenu(items: ContextMenuItem[]): Promise<string | null>;
    /** Native open-file dialog; resolves with a path or null. */
    pickFile(title: string): Promise<string | null>;
  };
}
