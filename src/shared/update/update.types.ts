/**
 * Update surfaces shared by main (checker + downloader) and renderer (toast).
 */

/** A newer GitHub release, as surfaced by the update checker. */
export interface UpdateInfo {
  version: string;
  url: string;
  prerelease: boolean;
  /** Browser download URL of the release's DMG; null when the release has none. */
  dmgUrl: string | null;
}

/** Progress of the in-app DMG download, pushed main → renderer. */
export interface UpdateDownloadState {
  status: "downloading" | "done" | "error";
  version: string;
  receivedBytes: number;
  totalBytes: number;
  /** Set on done: where the DMG landed (~/Downloads). */
  path?: string;
  /** Set on error. */
  error?: string;
}
