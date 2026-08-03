/**
 * Version comparison for update checks.
 *
 * Pallet versions are strictly `MAJOR.MINOR.PATCH` — three non-negative
 * integers, nothing else. No prerelease tags, no build metadata. A leading
 * `v` is tolerated only because GitHub release tags conventionally carry one
 * (`v0.2.0`), and it is stripped before parsing.
 *
 * Anything that doesn't match that shape is rejected rather than
 * interpreted. That is deliberate: an unrecognised tag must never be treated
 * as newer and prompt the user to "update" to something unparseable.
 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

const STRICT = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(input: string): ParsedVersion | null {
  const m = input.trim().replace(/^v/i, "").match(STRICT);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** True when `input` is a well-formed MAJOR.MINOR.PATCH version. */
export function isValidVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

/**
 * negative: a < b, 0: equal or incomparable, positive: a > b.
 *
 * An unparseable version compares equal, so callers treat it as "not newer"
 * and stay quiet instead of acting on something they don't understand.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}
