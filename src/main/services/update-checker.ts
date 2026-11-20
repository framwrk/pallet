import { compareVersions, parseVersion } from "@shared/version/version.utils";
import { getPreferences, setPreferenceRow } from "./prefs-store";
import type { UpdateInfo } from "@shared/update/update.types";
import { app } from "electron";
import { log } from "./logger";

const REPO = "framwrk/pallet";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface GithubRelease {
  tag_name: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const includePrerelease = getPreferences().receivePrereleaseUpdates;
  const url = includePrerelease
    ? `https://api.github.com/repos/${REPO}/releases?per_page=10`
    : `https://api.github.com/repos/${REPO}/releases/latest`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "pallet-update-check" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const body = (await res.json()) as GithubRelease | GithubRelease[];
  const releases = Array.isArray(body) ? body : [body];
  setPreferenceRow("updates.lastCheck", String(Date.now()));

  const current = app.getVersion();
  let best: { release: GithubRelease; version: string } | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    if (release.prerelease && !includePrerelease) continue;
    const parsed = parseVersion(release.tag_name);
    if (!parsed) continue;
    const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    if (compareVersions(version, current) <= 0) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = { release, version };
  }
  if (!best) return null;
  return {
    version: best.version,
    url: best.release.html_url,
    prerelease: best.release.prerelease,
    dmgUrl: best.release.assets?.find((a) => a.name.endsWith(".dmg"))?.browser_download_url ?? null,
  };
}

/** On-launch (delayed) + daily checks; notify() fires only on a newer version. */
export function startUpdateChecks(notify: (info: UpdateInfo) => void): void {
  const run = async (): Promise<void> => {
    try {
      if (!getPreferences().automaticallyCheckForUpdates) return;
      const info = await checkForUpdate();
      if (info) notify(info);
    } catch (err) {
      log("update-check failed", (err as Error).message);
    }
  };
  setTimeout(() => void run(), 10_000);
  setInterval(() => void run(), CHECK_INTERVAL_MS);
}
