/** Renderer-side SFTP session flow: connect/disconnect panes, events (M3). */
import {
  closeQuickConnect,
  getState,
  navigate,
  openQuickConnect,
  pushHostKeyPrompt,
  pushToast,
  setBackend,
  updateSessionStatus,
} from "./pane.store";
import type { ConnectProfile } from "@shared/sftp/sftp.types";

let eventsBound = false;

/** Bind main-process event streams once, at app startup. */
export function initSftpEvents(): void {
  if (eventsBound) return;
  eventsBound = true;
  window.pallet.sftp.onStatus((event) => {
    updateSessionStatus(event.sessionId, event.status, event.detail);
  });
  window.pallet.hostKeys.onVerify((prompt) => {
    pushHostKeyPrompt(prompt);
  });
  window.pallet.edit.onEvent((event) => {
    const name = event.remotePath.slice(event.remotePath.lastIndexOf("/") + 1);
    if (event.kind === "uploaded") {
      pushToast(`Uploaded ${name}`, "info");
    } else {
      pushToast(`Re-upload failed for ${name}: ${event.message ?? "unknown error"}`);
    }
  });
}

/** The server always lands in the right pane; `localPath` steers the left one. */
export async function connectRemote(profile: ConnectProfile, localPath?: string): Promise<void> {
  const result = await window.pallet.sftp.connect(profile);
  setBackend("right", {
    kind: "sftp",
    sessionId: result.sessionId,
    host: profile.host,
    username: profile.username,
    status: "connected",
  });
  await navigate("right", result.initialPath, "replace");
  closeQuickConnect();
  if (localPath) await navigate("left", localPath);
}

export async function disconnectRemote(): Promise<void> {
  const backend = getState().panes.right.backend;
  if (backend.kind !== "sftp") return;
  try {
    await window.pallet.sftp.disconnect(backend.sessionId);
  } catch {
    // Session may already be gone; the pane goes back to Quick Connect either way.
  }
  setBackend("right", { kind: "none" });
  openQuickConnect();
}

export function reconnectRemote(): void {
  const backend = getState().panes.right.backend;
  if (backend.kind !== "sftp") return;
  window.pallet.sftp.reconnect(backend.sessionId).catch((err) => pushToast(err.message));
}
