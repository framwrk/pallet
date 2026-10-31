/**
 * "Edit in external editor" (M6): download the remote file to a temp path,
 * open it with the default app, poll for changes, and re-upload through the
 * same .pallet-part staging the transfer queue uses.
 */
import { type TransferEndpoint, makeEndpoint } from "./transfer/transfer-endpoint";
import { app, shell } from "electron";
import { createReadStream, createWriteStream, promises as fs, unwatchFile, watchFile } from "fs";
import { PART_SUFFIX } from "@shared/transfer/transfer.constants";
import type { SessionManager } from "./sftp/session-manager";
import { join } from "path";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";

export interface EditEvent {
  kind: "uploaded" | "error";
  remotePath: string;
  localPath: string;
  message?: string;
}

/** Wait for the writer to settle before reading the file back. */
const DEFAULT_SAVE_DEBOUNCE_MS = 800;
const DEFAULT_POLL_INTERVAL_MS = 1000;
/** A dead channel must not leave `uploading` stuck forever. */
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;

export interface EditSessionsOptions {
  saveDebounceMs?: number;
  pollIntervalMs?: number;
  uploadTimeoutMs?: number;
}

interface EditSession {
  sessionId: string;
  remotePath: string;
  localPath: string;
  tempDir: string;
  remoteMode: number;
  endpoint: TransferEndpoint;
  uploading: boolean;
  dirty: boolean;
  closed: boolean;
  /** Debounce timer for the next upload. */
  saveTimer: NodeJS.Timeout | null;
  /** Last size/mtime observed by the watcher, to confirm the file settled. */
  pendingSize: number;
  pendingMtimeMs: number;
  /** Aborts an upload that stalls; also cleared on close. */
  abort: AbortController | null;
}

export class EditSessions {
  private edits = new Map<string, EditSession>();
  private readonly saveDebounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(
    private sessions: SessionManager,
    private notify: (event: EditEvent) => void,
    options: EditSessionsOptions = {},
  ) {
    this.saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  /** Download and open; returns the local temp path. */
  async open(sessionId: string, remotePath: string): Promise<string> {
    const existing = [...this.edits.values()].find((e) => e.sessionId === sessionId && e.remotePath === remotePath);
    if (existing) {
      await shell.openPath(existing.localPath);
      return existing.localPath;
    }

    const name = remotePath.slice(remotePath.lastIndexOf("/") + 1);
    const tempDir = join(app.getPath("temp"), "pallet-edits", randomUUID());
    await fs.mkdir(tempDir, { recursive: true });
    const localPath = join(tempDir, name);

    const endpoint = makeEndpoint(this.sessions, { kind: "sftp", sessionId });
    const stat = await endpoint.statOrNull(remotePath);
    if (!stat) throw new Error("Remote file not found");
    const src = await endpoint.createReadStream(remotePath);
    await pipeline(src, createWriteStream(localPath));

    const edit: EditSession = {
      sessionId,
      remotePath,
      localPath,
      tempDir,
      remoteMode: stat.mode,
      endpoint,
      uploading: false,
      dirty: false,
      closed: false,
      saveTimer: null,
      pendingSize: 0,
      pendingMtimeMs: 0,
      abort: null,
    };
    this.edits.set(localPath, edit);

    // Polling survives editors that write via rename (most of them).
    watchFile(localPath, { interval: this.pollIntervalMs }, (curr, prev) => {
      const changed = curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size;
      if (changed && curr.mtimeMs > 0) this.scheduleUpload(edit, curr.size, curr.mtimeMs);
    });

    const openErr = await shell.openPath(localPath);
    if (openErr) {
      await this.close(localPath);
      throw new Error(openErr);
    }
    return localPath;
  }

  /**
   * Reset the debounce on every change so an in-place editor that writes for
   * longer than the poll interval is never caught mid-write.
   */
  private scheduleUpload(edit: EditSession, size: number, mtimeMs: number): void {
    if (edit.closed) return;
    edit.pendingSize = size;
    edit.pendingMtimeMs = mtimeMs;
    if (edit.saveTimer) clearTimeout(edit.saveTimer);
    edit.saveTimer = setTimeout(() => {
      edit.saveTimer = null;
      void this.uploadIfSettled(edit);
    }, this.saveDebounceMs);
  }

  /** A change may land between the last poll and the debounce firing. */
  private async uploadIfSettled(edit: EditSession): Promise<void> {
    if (edit.closed) return;
    let stat;
    try {
      stat = await fs.stat(edit.localPath);
    } catch {
      return;
    }
    if (stat.size !== edit.pendingSize || stat.mtimeMs !== edit.pendingMtimeMs) {
      this.scheduleUpload(edit, stat.size, stat.mtimeMs);
      return;
    }
    await this.upload(edit);
  }

  private async upload(edit: EditSession): Promise<void> {
    if (edit.closed) return;
    if (edit.uploading) {
      edit.dirty = true;
      return;
    }
    edit.uploading = true;
    const partPath = edit.remotePath + PART_SUFFIX;
    const abort = new AbortController();
    edit.abort = abort;
    let stallTimer: NodeJS.Timeout | undefined;
    try {
      // Race the pipeline as well as aborting it: a dead channel may never
      // settle even after the signal is aborted.
      const stalled = new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => {
          abort.abort();
          reject(Object.assign(new Error("Edit upload timed out"), { code: "ETIMEDOUT" }));
        }, this.uploadTimeoutMs);
      });
      await Promise.race([this.streamUpload(edit, partPath, abort.signal), stalled]);
      await edit.endpoint.setMeta(partPath, { mtimeMs: Date.now(), mode: edit.remoteMode });
      await edit.endpoint.renameReplacing(partPath, edit.remotePath);
      this.notify({ kind: "uploaded", remotePath: edit.remotePath, localPath: edit.localPath });
    } catch (err) {
      await edit.endpoint.removeFile(partPath).catch(() => {});
      if (!edit.closed) {
        this.notify({
          kind: "error",
          remotePath: edit.remotePath,
          localPath: edit.localPath,
          message: (err as Error).message,
        });
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      edit.abort = null;
      edit.uploading = false;
      if (edit.dirty && !edit.closed) {
        edit.dirty = false;
        this.scheduleUpload(edit, edit.pendingSize, edit.pendingMtimeMs);
      }
    }
  }

  private async streamUpload(edit: EditSession, partPath: string, signal: AbortSignal): Promise<void> {
    const src = createReadStream(edit.localPath);
    const dst = await edit.endpoint.createWriteStream(partPath, edit.remoteMode, { signal });
    await pipeline(src, dst, { signal });
  }

  /** Stop watching, abort any upload, and remove the local temp copy. */
  async close(localPath: string): Promise<void> {
    unwatchFile(localPath);
    const edit = this.edits.get(localPath);
    if (!edit) return;
    edit.closed = true;
    if (edit.saveTimer) {
      clearTimeout(edit.saveTimer);
      edit.saveTimer = null;
    }
    edit.abort?.abort();
    edit.endpoint.dispose();
    this.edits.delete(localPath);
    await fs.rm(edit.tempDir, { recursive: true, force: true });
  }

  async closeSession(sessionId: string): Promise<void> {
    const paths = [...this.edits.values()].filter((e) => e.sessionId === sessionId).map((e) => e.localPath);
    await Promise.all(paths.map((localPath) => this.close(localPath)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.edits.keys()].map((localPath) => this.close(localPath)));
  }
}
