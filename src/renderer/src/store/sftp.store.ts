/** Renderer-side SFTP session flow: connect/disconnect panes, events (M3). */
import {
  closeQuickConnect,
  getState,
  navigate,
  pushHostKeyPrompt,
  pushToast,
  setActive,
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
  const previousBackend = getState().panes.right.backend;
  const result = await window.pallet.sftp.connect(profile);

  // Keep the current workspace intact while connecting. Once the replacement
  // succeeds, retire the old session before mounting the new one.
  if (previousBackend.kind === "sftp" && previousBackend.sessionId !== result.sessionId) {
    try {
      await window.pallet.sftp.disconnect(previousBackend.sessionId);
    } catch {
      // The new session is healthy; a stale old session must not block it.
    }
  }

  setBackend("right", {
    kind: "sftp",
    protocol: profile.protocol ?? "sftp",
    sessionId: result.sessionId,
    host: profile.host,
    username: profile.username,
    status: "connected",
  });
  setActive("right");
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
    // Session may already be gone; the remote pane closes either way.
  }
  setBackend("right", { kind: "none" });
  setActive("left");
  closeQuickConnect();
}

export function reconnectRemote(): void {
  const backend = getState().panes.right.backend;
  if (backend.kind !== "sftp") return;
  window.pallet.sftp.reconnect(backend.sessionId).catch((err) => pushToast(err.message));
}
