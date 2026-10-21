/** Renderer-side SFTP session flow: connect/disconnect panes, events (M3). */
import {
  type PaneId,
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
/** Last local directory shown by the left pane, restored after a remote visit. */
let leftLocalCwd: string | null = null;

/** Remember the current local directory before replacing the left pane with a server. */
export function rememberLeftLocalPane(): void {
  const pane = getState().panes.left;
  if (pane.backend.kind === "local") leftLocalCwd = pane.cwd || null;
}

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

/**
 * Connect a pane to a server. The right pane is the default target; the left
 * pane opts in for remote-to-remote work.
 */
export async function connectRemote(profile: ConnectProfile, localPath?: string, paneId: PaneId = "right"): Promise<void> {
  const previousBackend = getState().panes[paneId].backend;
  if (paneId === "left" && previousBackend.kind === "local") {
    rememberLeftLocalPane();
  }
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

  setBackend(paneId, {
    kind: "sftp",
    protocol: profile.protocol ?? "sftp",
    sessionId: result.sessionId,
    host: profile.host,
    username: profile.username,
    status: "connected",
  });
  setActive(paneId);
  await navigate(paneId, result.initialPath, "replace");
  closeQuickConnect();
  // A favorite's local path only belongs to a local left pane.
  if (paneId === "right" && localPath && getState().panes.left.backend.kind === "local") {
    await navigate("left", localPath);
  }
}

/** Disconnect a remote pane; the left pane returns to the local disk. */
export async function disconnectPane(paneId: PaneId): Promise<void> {
  const backend = getState().panes[paneId].backend;
  if (backend.kind !== "sftp") return;
  try {
    await window.pallet.sftp.disconnect(backend.sessionId);
  } catch {
    // Session may already be gone; the pane closes either way.
  }
  if (paneId === "left") {
    const restore = leftLocalCwd;
    setBackend("left", { kind: "local" });
    // The local disk returns to the left, so retire the copy the sidebar put right.
    if (getState().panes.right.backend.kind === "local") setBackend("right", { kind: "none" });
    setActive("left");
    const home = await window.pallet.fs.homeDir();
    if (!(await navigate("left", restore ?? home, "replace")) && restore && restore !== home) {
      await navigate("left", home, "replace");
    }
  } else {
    setBackend("right", { kind: "none" });
    setActive("left");
  }
  closeQuickConnect();
}

export function reconnectPane(paneId: PaneId): void {
  const backend = getState().panes[paneId].backend;
  if (backend.kind !== "sftp") return;
  window.pallet.sftp.reconnect(backend.sessionId).catch((err) => pushToast(err.message));
}
