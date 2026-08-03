import { describe, expect, test } from "bun:test";
import { compareVersions, isValidVersion, parseVersion } from "../../src/shared/semver";

describe("parseVersion", () => {
  test("parses MAJOR.MINOR.PATCH", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseVersion("10.20.30")).toEqual({ major: 10, minor: 20, patch: 30 });
  });

  test("tolerates a leading v, as GitHub tags carry one", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("V1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("ignores surrounding whitespace", () => {
    expect(parseVersion("  1.2.3  ")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("rejects prerelease tags — versions are A.B.C and nothing else", () => {
    expect(parseVersion("0.1.0-beta.1")).toBeNull();
    expect(parseVersion("1.0.0-rc1")).toBeNull();
    expect(parseVersion("1.0.0-alpha")).toBeNull();
  });

  test("rejects build metadata", () => {
    expect(parseVersion("1.2.3+build.5")).toBeNull();
    expect(parseVersion("1.2.3-beta+exp")).toBeNull();
  });

  test("rejects anything that isn't exactly three numeric parts", () => {
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("1.2.3.4")).toBeNull();
    expect(parseVersion("1")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("x.y.z")).toBeNull();
    expect(parseVersion("1.2.x")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });
});

describe("isValidVersion", () => {
  test("accepts only A.B.C", () => {
    expect(isValidVersion("0.1.0")).toBe(true);
    expect(isValidVersion("v2.0.1")).toBe(true);
    expect(isValidVersion("0.1.0-beta.1")).toBe(false);
    expect(isValidVersion("0.1")).toBe(false);
  });
});

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.1.2", "1.1.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  test("equal versions compare equal, with or without the v prefix", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("compares numerically, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
  });

  test("an unparseable version is never treated as newer", () => {
    // The update check must stay quiet rather than prompt toward a tag it
    // cannot interpret, so incomparable pairs return 0 in both directions.
    expect(compareVersions("0.2.0-rc1", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.2.0-rc1")).toBe(0);
    expect(compareVersions("garbage", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "")).toBe(0);
  });
});
