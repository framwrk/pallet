/**
 * A window may only stay on the dev origin or its bundled entry document, and
 * external links only ever open http(s).
 */
import { describe, expect, test } from "bun:test";
import { isAllowedExternalUrl, isAllowedNavigation } from "../src/main/utils/navigation-policy";

const DEV_ORIGIN = "http://localhost:5173";
const ENTRY_FILE = "file:///Applications/Pallet.app/Contents/Resources/app.asar/out/renderer/index.html";

describe("isAllowedNavigation", () => {
  test("allows the development renderer origin", () => {
    expect(isAllowedNavigation(`${DEV_ORIGIN}/`, { devOrigin: DEV_ORIGIN, entryFileUrl: ENTRY_FILE })).toBe(true);
    expect(
      isAllowedNavigation(new URL("settings.html", DEV_ORIGIN).toString(), {
        devOrigin: DEV_ORIGIN,
        entryFileUrl: ENTRY_FILE,
      }),
    ).toBe(true);
  });

  test("allows the exact local entry document", () => {
    expect(isAllowedNavigation(ENTRY_FILE, { entryFileUrl: ENTRY_FILE })).toBe(true);
  });

  test("rejects remote pages, including other http origins", () => {
    expect(isAllowedNavigation("https://example.com/", { devOrigin: DEV_ORIGIN, entryFileUrl: ENTRY_FILE })).toBe(false);
    expect(isAllowedNavigation("http://localhost:9999/", { devOrigin: DEV_ORIGIN, entryFileUrl: ENTRY_FILE })).toBe(false);
  });

  test("rejects other local files and non-web schemes", () => {
    expect(isAllowedNavigation("file:///tmp/other.html", { devOrigin: DEV_ORIGIN, entryFileUrl: ENTRY_FILE })).toBe(false);
    expect(isAllowedNavigation("ftp://example.com/file", { devOrigin: DEV_ORIGIN, entryFileUrl: ENTRY_FILE })).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", { devOrigin: DEV_ORIGIN, entryFileUrl: ENTRY_FILE })).toBe(false);
    expect(isAllowedNavigation("not a url", { devOrigin: DEV_ORIGIN, entryFileUrl: ENTRY_FILE })).toBe(false);
  });
});

describe("isAllowedExternalUrl", () => {
  test("allows http and https", () => {
    expect(isAllowedExternalUrl("http://example.com/")).toBe(true);
    expect(isAllowedExternalUrl("https://example.com/path?q=1")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isAllowedExternalUrl("ftp://example.com/file")).toBe(false);
    expect(isAllowedExternalUrl("file:///tmp/other.html")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html,hi")).toBe(false);
    expect(isAllowedExternalUrl("mailto:hello@example.com")).toBe(false);
    expect(isAllowedExternalUrl("pallet://open")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
  });
});
