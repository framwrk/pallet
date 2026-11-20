import {
  type PaneId,
  beginConnection,
  closeQuickConnect,
  dismissConnectionToast,
  endConnection,
  getState,
  isCurrentConnection,
  navigate,
  pushHostKeyPrompt,
  pushToast,
  setActive,
  setBackend,
  updateSessionStatus,
} from "./pane.store";
import type { ConnectProfile } from "@shared/sftp/sftp.types";
import { expandHome } from "@shared/path/path.utils";

let eventsBound = false;
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
  const label = profile.s3?.bucket ?? `${profile.username}@${profile.host}`;
  const attemptId = beginConnection({ paneId, label, host: profile.host });
  if (!attemptId) {
    const pending = getState().connecting;
    throw new Error(pending ? `Still connecting to ${pending.label}` : "Another connection is already opening");
  }
  try {
    const previousBackend = getState().panes[paneId].backend;
    if (paneId === "left" && previousBackend.kind === "local") {
      rememberLeftLocalPane();
    }
    const result = await window.pallet.sftp.connect(profile, attemptId);
    await dropIfCancelled(attemptId, result.sessionId);

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
      ...(profile.s3
        ? {
            s3: {
              bucket: profile.s3.bucket,
              ...(profile.s3.endpoint ? { endpoint: profile.s3.endpoint } : {}),
              region: profile.s3.region,
              ...(profile.remotePath ? { prefix: profile.remotePath } : {}),
            },
          }
        : {}),
    });
    setActive(paneId);
    dismissConnectionToast();
    await navigate(paneId, result.initialPath, "replace");
    await closeIfCancelled(attemptId, paneId);
    closeQuickConnect();
    if (paneId === "right" && localPath && getState().panes.left.backend.kind === "local") {
      await navigate("left", expandHome(localPath, await window.pallet.fs.homeDir()));
    }
  } catch (err) {
    // Error codes do not survive the context bridge, so judge by the attempt itself.
    throw isCurrentConnection(attemptId) ? err : cancelledError();
  } finally {
    endConnection(attemptId);
  }
}

/** Raised by a connect the user cancelled; callers stay quiet about it. */
export function isCancelledConnection(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "ECANCELED";
}

function cancelledError(): Error {
  return Object.assign(new Error("Connection cancelled"), { code: "ECANCELED" });
}

/** Stop the connection that is opening. Its pane keeps whatever it showed before. */
export function cancelConnection(): void {
  const attempt = getState().connecting;
  if (!attempt) return;
  endConnection(attempt.id);
  void window.pallet.sftp.cancelConnect(attempt.id).catch(() => {});
}

/** Main finished before the cancel reached it: close the session nobody wants. */
export async function dropIfCancelled(attemptId: string, sessionId: string): Promise<void> {
  if (isCurrentConnection(attemptId)) return;
  await window.pallet.sftp.disconnect(sessionId).catch(() => {});
  throw cancelledError();
}

/** Cancelled while the first listing loaded: the pane is live, so close it. */
export async function closeIfCancelled(attemptId: string, paneId: PaneId): Promise<void> {
  if (isCurrentConnection(attemptId)) return;
  await disconnectPane(paneId);
  throw cancelledError();
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
