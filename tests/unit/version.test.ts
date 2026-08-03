/**
 * The shipped version must be exactly MAJOR.MINOR.PATCH.
 *
 * `app.getVersion()`, the DMG/ZIP filenames, and the update check all read
 * from package.json, so a stray suffix there would propagate everywhere at
 * once — and the update comparison rejects non-conforming versions, which
 * would silently disable update prompts for anyone on that build.
 */
import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import { isValidVersion, parseVersion } from "../../src/shared/semver";

describe("package version", () => {
  test("is a plain MAJOR.MINOR.PATCH version", () => {
    expect(isValidVersion(pkg.version)).toBe(true);
  });

  test("carries no prerelease tag, build metadata, or v prefix", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("round-trips through the parser unchanged", () => {
    const parsed = parseVersion(pkg.version);
    expect(parsed).not.toBeNull();
    expect(`${parsed!.major}.${parsed!.minor}.${parsed!.patch}`).toBe(pkg.version);
  });
});
