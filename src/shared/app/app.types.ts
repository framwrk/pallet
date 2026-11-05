/** Runtime details shown in Settings → About and copied into bug reports. */
export interface AppInfo {
  version: string;
  /** Electron runtime version. */
  electron: string;
  /** macOS product version, not the Darwin kernel version. */
  systemVersion: string;
  /** CPU architecture, e.g. "arm64". */
  arch: string;
}
