import { describe, expect, test } from "bun:test";
import { remotePath, localPath } from "../../src/shared/paths";

describe("remotePath.normalize", () => {
  test("collapses dot segments and duplicate slashes", () => {
    expect(remotePath.normalize("/a//b/./c")).toBe("/a/b/c");
    expect(remotePath.normalize("/a/b/../c")).toBe("/a/c");
    expect(remotePath.normalize("/a/b/..")).toBe("/a");
  });

  test("never escapes root", () => {
    expect(remotePath.normalize("/..")).toBe("/");
    expect(remotePath.normalize("/../..")).toBe("/");
  });

  test("root and empty", () => {
    expect(remotePath.normalize("/")).toBe("/");
    expect(remotePath.normalize("")).toBe(".");
    expect(remotePath.normalize("a/b/")).toBe("a/b");
  });

  test("relative paths keep leading ..", () => {
    expect(remotePath.normalize("../a")).toBe("../a");
    expect(remotePath.normalize("a/../../b")).toBe("../b");
  });
});

describe("remotePath.join", () => {
  test("joins and normalizes", () => {
    expect(remotePath.join("/srv", "www", "logs")).toBe("/srv/www/logs");
    expect(remotePath.join("/srv/", "/www")).toBe("/srv/www");
    expect(remotePath.join("/srv", "..")).toBe("/");
  });

  test("empty parts are ignored", () => {
    expect(remotePath.join("", "/a", "", "b")).toBe("/a/b");
    expect(remotePath.join()).toBe(".");
  });
});

describe("remotePath.dirname / basename", () => {
  test("dirname", () => {
    expect(remotePath.dirname("/a/b/c")).toBe("/a/b");
    expect(remotePath.dirname("/a")).toBe("/");
    expect(remotePath.dirname("/")).toBe("/");
    expect(remotePath.dirname("a/b")).toBe("a");
    expect(remotePath.dirname("a")).toBe(".");
  });

  test("basename", () => {
    expect(remotePath.basename("/a/b/c.txt")).toBe("c.txt");
    expect(remotePath.basename("/")).toBe("/");
    expect(remotePath.basename("/a/b/")).toBe("b");
  });
});

describe("remotePath.segments", () => {
  test("breadcrumbs for absolute path", () => {
    expect(remotePath.segments("/a/b")).toEqual([
      { name: "/", path: "/" },
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
    ]);
    expect(remotePath.segments("/")).toEqual([{ name: "/", path: "/" }]);
  });

  test("relative paths produce no segments", () => {
    expect(remotePath.segments("a/b")).toEqual([]);
  });
});

describe("extname", () => {
  test("extensions", () => {
    expect(remotePath.extname("/a/b.tar.gz")).toBe(".gz");
    expect(remotePath.extname("/a/b")).toBe("");
    expect(remotePath.extname("/a/.hidden")).toBe("");
  });
});

describe("localPath", () => {
  test("mirrors POSIX behavior on macOS", () => {
    expect(localPath.join("/Users", "alice", "Documents")).toBe("/Users/alice/Documents");
    expect(localPath.dirname("/Users/alice")).toBe("/Users");
    expect(localPath.isAbsolute("/Users")).toBe(true);
    expect(localPath.isAbsolute("Users")).toBe(false);
  });
});
