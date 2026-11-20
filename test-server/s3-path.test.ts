import {
  canonicalRootPrefix,
  encodeCopySource,
  isRootPath,
  joinPath,
  keyForPath,
  locationFor,
  normalizePath,
  pathForKey,
  prefixForPath,
} from "../src/main/services/s3/s3-path";
import { describe, expect, test } from "bun:test";

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
  return undefined;
}

describe("root prefix mapping", () => {
  test("an absent, empty, or root prefix maps the pane root to the bucket root", () => {
    for (const prefix of [undefined, null, "", "/", "  "]) {
      expect(locationFor(prefix).rootPrefix).toBe("");
    }
    const root = locationFor();
    expect(keyForPath(root, "/")).toBe("");
    expect(prefixForPath(root, "/")).toBe("");
    expect(keyForPath(root, "/a/b")).toBe("a/b");
  });

  test("canonicalRootPrefix trims and strips boundary slashes once", () => {
    expect(canonicalRootPrefix("photos")).toBe("photos");
    expect(canonicalRootPrefix("/photos/")).toBe("photos");
    expect(canonicalRootPrefix("/photos/2024/")).toBe("photos/2024");
    expect(canonicalRootPrefix("  /photos/2024/  ")).toBe("photos/2024");
  });

  test("canonicalRootPrefix rejects . and .. segments and control characters", () => {
    expect(errorCode(() => canonicalRootPrefix("/photos/../private"))).toBe("EINVAL");
    expect(errorCode(() => canonicalRootPrefix("./photos"))).toBe("EINVAL");
    expect(errorCode(() => canonicalRootPrefix("/photos/\u0000secret"))).toBe("EINVAL");
  });

  test("pane paths map onto keys underneath the connection root", () => {
    const location = locationFor("/photos/");
    expect(keyForPath(location, "/")).toBe("photos");
    expect(keyForPath(location, "/2024/cat.jpg")).toBe("photos/2024/cat.jpg");
    expect(prefixForPath(location, "/")).toBe("photos/");
    expect(prefixForPath(location, "/2024")).toBe("photos/2024/");
  });

  test("a trailing slash exists only at the API prefix boundary", () => {
    const location = locationFor("/photos");
    expect(normalizePath("/2024")).toBe("/2024");
    expect(keyForPath(location, "/2024")).toBe("photos/2024");
    expect(prefixForPath(location, "/2024")).toBe("photos/2024/");
    expect(keyForPath(location, "/")).toBe("photos");
  });

  test("isRootPath only accepts canonical paths", () => {
    expect(isRootPath("/")).toBe(true);
    expect(isRootPath("/a")).toBe(false);
    expect(errorCode(() => isRootPath("/a/"))).toBe("EINVAL");
  });
});

describe("path validation", () => {
  test("rejects empty and non-absolute paths", () => {
    for (const path of ["", "a/b", "./a", "../a", " /a"]) {
      expect(errorCode(() => normalizePath(path))).toBe("EINVAL");
    }
  });

  test("rejects repeated, dot, and trailing separators", () => {
    for (const path of ["//", "/a//b", "/a/./b", "/a/../b", "/a/", "/.", "/.."]) {
      expect(errorCode(() => normalizePath(path))).toBe("EINVAL");
    }
  });

  test("rejects NUL and control characters", () => {
    for (const path of ["/a\u0000b", "/a\nb", "/a\rb", "/a\tb", "/a\u007fb"]) {
      expect(errorCode(() => normalizePath(path))).toBe("EINVAL");
    }
  });

  test("accepts ordinary nested names including spaces and unicode", () => {
    expect(normalizePath("/a b/c-é.txt")).toBe("/a b/c-é.txt");
    expect(normalizePath("/.hidden/file")).toBe("/.hidden/file");
  });
});

describe("pathForKey", () => {
  const root = locationFor();
  const prefixed = locationFor("photos/2024");

  test("maps keys back to pane paths in scope", () => {
    expect(pathForKey(root, "a/b.txt")).toBe("/a/b.txt");
    expect(pathForKey(prefixed, "photos/2024/cat.jpg")).toBe("/cat.jpg");
    expect(pathForKey(prefixed, "photos/2024")).toBe("/");
  });

  test("rejects keys outside the connection root", () => {
    expect(errorCode(() => pathForKey(prefixed, "photos/2025/cat.jpg"))).toBe("EINVAL");
    expect(errorCode(() => pathForKey(prefixed, "photos/20240/cat.jpg"))).toBe("EINVAL");
    expect(errorCode(() => pathForKey(prefixed, "other/cat.jpg"))).toBe("EINVAL");
  });

  test("rejects keys whose relative segments are not one visible path", () => {
    expect(errorCode(() => pathForKey(prefixed, "photos/2024//cat.jpg"))).toBe("EINVAL");
    expect(errorCode(() => pathForKey(prefixed, "photos/2024/../cat.jpg"))).toBe("EINVAL");
    expect(errorCode(() => pathForKey(prefixed, "photos/2024/./cat.jpg"))).toBe("EINVAL");
  });
});

describe("joinPath", () => {
  test("joins validated entry names onto normalized directories", () => {
    expect(joinPath("/", "a")).toBe("/a");
    expect(joinPath("/dir", "a.txt")).toBe("/dir/a.txt");
    expect(errorCode(() => joinPath("/dir/", "a.txt"))).toBe("EINVAL");
  });

  test("rejects entry names that cannot round-trip as one segment", () => {
    for (const name of ["", ".", "..", "a/b", "a\u0000b", "a\nb"]) {
      expect(errorCode(() => joinPath("/dir", name))).toBe("EINVAL");
    }
  });
});

describe("encodeCopySource", () => {
  const bucket = "my-bucket";

  test("encodes reserved characters per segment", () => {
    expect(encodeCopySource(bucket, "plain.txt")).toBe("my-bucket/plain.txt");
    expect(encodeCopySource(bucket, "a+b.txt")).toBe("my-bucket/a%2Bb.txt");
    expect(encodeCopySource(bucket, "100%.txt")).toBe("my-bucket/100%25.txt");
    expect(encodeCopySource(bucket, "note#1.txt")).toBe("my-bucket/note%231.txt");
    expect(encodeCopySource(bucket, 'say "hi".txt')).toBe("my-bucket/say%20%22hi%22.txt");
    expect(encodeCopySource(bucket, "two words.txt")).toBe("my-bucket/two%20words.txt");
    expect(encodeCopySource(bucket, "café.txt")).toBe("my-bucket/caf%C3%A9.txt");
  });

  test("keeps slash separators and encodes each nested segment", () => {
    expect(encodeCopySource(bucket, "dir one/sub+dir/a b#c.txt")).toBe("my-bucket/dir%20one/sub%2Bdir/a%20b%23c.txt");
  });

  test("rejects an empty key or a bucket containing a slash", () => {
    expect(errorCode(() => encodeCopySource(bucket, ""))).toBe("EINVAL");
    expect(errorCode(() => encodeCopySource("bucket/extra", "a.txt"))).toBe("EINVAL");
  });
});
