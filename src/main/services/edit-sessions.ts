/**
 * "Edit in external editor" (M6): download the remote file to a temp path,
 * open it with the default app, poll for changes, and re-upload through the
 * same .pallet-part staging the transfer queue uses.
 */
import { app, shell } from "electron";
import { createWriteStream, promises as fs, unwatchFile, watchFile } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { type TransferEndpoint, makeEndpoint } from "./transfer/endpoints";
import type { SessionManager } from "./session-manager";

export interface EditEvent {
  kind: "uploaded" | "error";
  remotePath: string;
  localPath: string;
  message?: string;
}

interface EditSession {
  sessionId: string;
  remotePath: string;
  localPath: string;
  remoteMode: number;
  endpoint: TransferEndpoint;
  uploading: boolean;
  dirty: boolean;
}

export class EditSessions {
  private edits = new Map<string, EditSession>();

  constructor(
    private sessions: SessionManager,
    private notify: (event: EditEvent) => void,
  ) {}

  /** Download and open; returns the local temp path. */
  async open(sessionId: string, remotePath: string): Promise<string> {
    const existing = [...this.edits.values()].find((e) => e.sessionId === sessionId && e.remotePath === remotePath);
    if (existing) {
      await shell.openPath(existing.localPath);
      return existing.localPath;
    }

    const name = remotePath.slice(remotePath.lastIndexOf("/") + 1);
    const dir = join(app.getPath("temp"), "pallet-edits", randomUUID());
    await fs.mkdir(dir, { recursive: true });
    const localPath = join(dir, name);

    const endpoint = makeEndpoint(this.sessions, { kind: "sftp", sessionId });
    const stat = await endpoint.statOrNull(remotePath);
    if (!stat) throw new Error("Remote file not found");
    const src = await endpoint.createReadStream(remotePath);
    await pipeline(src, createWriteStream(localPath));

    const edit: EditSession = {
      sessionId,
      remotePath,
      localPath,
      remoteMode: stat.mode,
      endpoint,
      uploading: false,
      dirty: false,
    };
    this.edits.set(localPath, edit);

    // Polling survives editors that write via rename (most of them).
    watchFile(localPath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs && curr.mtimeMs > 0) {
        void this.upload(edit);
      }
    });

    const openErr = await shell.openPath(localPath);
    if (openErr) {
      this.close(localPath);
      throw new Error(openErr);
    }
    return localPath;
  }

  private async upload(edit: EditSession): Promise<void> {
    if (edit.uploading) {
      edit.dirty = true;
      return;
    }
    edit.uploading = true;
    const partPath = edit.remotePath + ".pallet-part";
    try {
      const src = (await import("fs")).createReadStream(edit.localPath);
      const dst = await edit.endpoint.createWriteStream(partPath, edit.remoteMode);
      await pipeline(src, dst);
      await edit.endpoint.setMeta(partPath, { mtimeMs: Date.now(), mode: edit.remoteMode });
      await edit.endpoint.renameReplacing(partPath, edit.remotePath);
      this.notify({ kind: "uploaded", remotePath: edit.remotePath, localPath: edit.localPath });
    } catch (err) {
      await edit.endpoint.removeFile(partPath).catch(() => {});
      this.notify({
        kind: "error",
        remotePath: edit.remotePath,
        localPath: edit.localPath,
        message: (err as Error).message,
      });
    } finally {
      edit.uploading = false;
      if (edit.dirty) {
        edit.dirty = false;
        void this.upload(edit);
      }
    }
  }

  close(localPath: string): void {
    unwatchFile(localPath);
    const edit = this.edits.get(localPath);
    edit?.endpoint.dispose();
    this.edits.delete(localPath);
  }

  closeSession(sessionId: string): void {
    for (const [localPath, edit] of this.edits) {
      if (edit.sessionId === sessionId) this.close(localPath);
    }
  }
}
