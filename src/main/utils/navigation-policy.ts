/**
 * URL policy shared by the windows and the IPC surface. Keeping it pure makes
 * the rules testable without booting Electron.
 */

/** External links may only open http(s); other schemes can reach local files or app handlers. */
export function isAllowedExternalUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export interface NavigationPolicy {
  /** Development renderer origin, when the window is served by Vite. */
  devOrigin?: string;
  /** The exact local entry document the packaged window loads. */
  entryFileUrl: string;
}

/** A window may only stay on the dev origin or its own bundled entry document. */
export function isAllowedNavigation(target: string, policy: NavigationPolicy): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (policy.devOrigin) {
    try {
      if (url.origin === new URL(policy.devOrigin).origin) return true;
    } catch {
      // A malformed dev origin falls through to the local entry check.
    }
  }

  return url.protocol === "file:" && url.href === new URL(policy.entryFileUrl).href;
}
