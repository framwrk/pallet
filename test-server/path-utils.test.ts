import { describe, expect, test } from "bun:test";
import { expandHome, localPath, remotePath } from "../src/shared/path/path.utils";

describe("expandHome", () => {
  const home = "/Users/pallet";

  test("expands a bare ~ and a ~/ prefix", () => {
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~/", home)).toBe(home);
    expect(expandHome("~/Downloads/tmp", home)).toBe("/Users/pallet/Downloads/tmp");
  });

  test("leaves other paths untouched", () => {
    expect(expandHome("/Users/pallet/Downloads", home)).toBe("/Users/pallet/Downloads");
    expect(expandHome("Downloads/tmp", home)).toBe("Downloads/tmp");
    expect(expandHome("~pallet/Downloads", home)).toBe("~pallet/Downloads");
    expect(expandHome("~/../tmp", home)).toBe("/Users/tmp");
  });
});

test("localPath and remotePath stay separate objects", () => {
  expect(localPath).not.toBe(remotePath);
});
