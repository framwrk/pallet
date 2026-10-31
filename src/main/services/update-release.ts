/**
 * Resolve the DMG URL and published SHA-256 for a version from GitHub.
 *
 * The renderer supplies only a version; main looks the release up itself, so a
 * compromised renderer cannot redirect the download or skip verification.
 * GitHub's per-asset `digest` is preferred; older releases fall back to the
 * `checksums.txt` asset that `scripts/verify-release.sh` publishes.
 */
import {
  canonicalUpdateVersion,
  normalizeSha256,
  parseChecksums,
  updateAssetName,
  validateAssetUrl,
} from "./update-download.utils";

const REPO = "framwrk/pallet";
const CHECKSUMS_ASSET = "checksums.txt";
const API_TIMEOUT_MS = 30_000;

interface GithubAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
  assets?: GithubAsset[];
}

export interface UpdateRelease {
  version: string;
  dmgUrl: string;
  checksum: string;
}

async function fetchText(url: string, accept?: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "pallet-update-download",
      ...(accept ? { Accept: accept } : {}),
    },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Could not look up the update release: HTTP ${res.status}`);
  return res.text();
}

export async function resolveUpdateRelease(versionInput: unknown): Promise<UpdateRelease> {
  const version = canonicalUpdateVersion(versionInput);
  const filename = updateAssetName(version);

  const body = await fetchText(`https://api.github.com/repos/${REPO}/releases/tags/v${version}`, "application/vnd.github+json");
  const release = JSON.parse(body) as GithubRelease;
  if (!release || typeof release !== "object") throw new Error("Could not look up the update release");
  if (release.draft) throw new Error("This update release is still a draft");
  if (canonicalUpdateVersion(release.tag_name) !== version) {
    throw new Error("The update release does not match the requested version");
  }

  const asset = release.assets?.find((candidate) => candidate.name === filename);
  if (!asset) throw new Error(`The release has no ${filename} asset`);
  const dmgUrl = validateAssetUrl(asset.browser_download_url);

  const digest = normalizeSha256(asset.digest);
  if (digest) return { version, dmgUrl, checksum: digest };

  const checksums = release.assets?.find((candidate) => candidate.name === CHECKSUMS_ASSET);
  if (!checksums) throw new Error("The release publishes no checksum for its disk image");
  const text = await fetchText(validateAssetUrl(checksums.browser_download_url));
  const checksum = parseChecksums(text, filename);
  if (!checksum) throw new Error("The release checksum does not cover its disk image");
  return { version, dmgUrl, checksum };
}
