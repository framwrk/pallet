/** Renderer-side SFTP session flow: connect/disconnect panes, events (M3). */
import type { ConnectProfile } from "@shared/types";
import {
  getState,
  navigate,
  otherPane,
  pushHostKeyPrompt,
  pushToast,
  setBackend,
  setConnectOpen,
  updateSessionStatus,
  type PaneId,
} from "./panes";

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

export async function connectPane(id: PaneId, profile: ConnectProfile, otherPaneLocalPath?: string): Promise<void> {
  const result = await window.pallet.sftp.connect(profile);
  setConnectOpen(false);
  setBackend(id, {
    kind: "sftp",
    sessionId: result.sessionId,
    host: profile.host,
    username: profile.username,
    status: "connected",
  });
  await navigate(id, result.initialPath, "replace");
  if (otherPaneLocalPath) {
    const other = otherPane(id);
    if (getState().panes[other].backend.kind === "local") {
      await navigate(other, otherPaneLocalPath);
    }
  }
}

export async function disconnectPane(id: PaneId): Promise<void> {
  const backend = getState().panes[id].backend;
  if (backend.kind !== "sftp") return;
  try {
    await window.pallet.sftp.disconnect(backend.sessionId);
  } catch {
    // Session may already be gone; still fall back to local.
  }
  setBackend(id, { kind: "local" });
  const home = await window.pallet.fs.homeDir();
  await navigate(id, home, "replace");
}

export function reconnectPane(id: PaneId): void {
  const backend = getState().panes[id].backend;
  if (backend.kind !== "sftp") return;
  window.pallet.sftp.reconnect(backend.sessionId).catch((err) => pushToast(err.message));
}
