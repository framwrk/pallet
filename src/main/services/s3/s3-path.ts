export interface S3Location {
  /** Canonical starting key prefix without leading/trailing slashes. */
  rootPrefix: string;
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function splitPath(path: string): string[] {
  if (typeof path !== "string" || path.length === 0) throw invalidPath(path);
  if (hasControlChars(path)) throw invalidPath(path);
  if (!path.startsWith("/")) throw invalidPath(path);
  if (path === "/") return [];
  if (path.endsWith("/")) throw invalidPath(path);
  const parts = path.slice(1).split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") throw invalidPath(path);
  }
  return parts;
}

function invalidPath(path: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`Invalid remote path: ${JSON.stringify(path)}`);
  err.code = "EINVAL";
  return err;
}

export function invalidEntryName(name: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`Invalid S3 object name: ${JSON.stringify(name)}`);
  err.code = "EINVAL";
  return err;
}

/** A single visible listing entry name must round-trip as one path segment. */
export function assertEntryName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    hasControlChars(name)
  ) {
    throw invalidEntryName(name);
  }
}

/** Canonicalise a connection's optional starting prefix once, at construction. */
export function canonicalRootPrefix(prefix?: string | null): string {
  const raw = (prefix ?? "").trim();
  if (!raw || raw === "/") return "";
  if (hasControlChars(raw)) {
    const err: NodeJS.ErrnoException = new Error("Invalid S3 starting prefix");
    err.code = "EINVAL";
    throw err;
  }
  const parts = raw.split("/").filter((part) => part !== "");
  for (const part of parts) {
    if (part === "." || part === "..") {
      const err: NodeJS.ErrnoException = new Error("S3 prefix cannot contain . or .. segments");
      err.code = "EINVAL";
      throw err;
    }
  }
  return parts.join("/");
}

export function locationFor(rootPrefix?: string | null): S3Location {
  return { rootPrefix: canonicalRootPrefix(rootPrefix) };
}

/** Validate every renderer-supplied path in main, after transport. */
export function normalizePath(path: string): string {
  const parts = splitPath(path);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function isRootPath(path: string): boolean {
  return normalizePath(path) === "/";
}

/** Object key for a file path; "" is the bucket root (never a valid key). */
export function keyForPath(location: S3Location, path: string): string {
  const parts = splitPath(path);
  const rel = parts.join("/");
  if (location.rootPrefix === "") return rel;
  return rel === "" ? location.rootPrefix : `${location.rootPrefix}/${rel}`;
}

/** Prefix for a directory path, with the trailing slash only at the API boundary. */
export function prefixForPath(location: S3Location, path: string): string {
  const key = keyForPath(location, path);
  return key === "" ? "" : `${key}/`;
}

/** Visible path for a key inside the connection's root; throws if out of scope. */
export function pathForKey(location: S3Location, key: string): string {
  let rel: string;
  if (location.rootPrefix === "") {
    rel = key;
  } else if (key === location.rootPrefix) {
    rel = "";
  } else if (key.startsWith(`${location.rootPrefix}/`)) {
    rel = key.slice(location.rootPrefix.length + 1);
  } else {
    throw invalidPath(key);
  }
  const parts = rel.split("/");
  if (rel === "") return "/";
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw invalidPath(key);
  return `/${parts.join("/")}`;
}

export function joinPath(dir: string, name: string): string {
  assertEntryName(name);
  const base = normalizePath(dir);
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

/**
 * CopySource is a header value, so the bucket and every key segment are
 * percent-encoded independently. "/" stays the separator and "+" must not be
 * interpreted as a space by a compatible server.
 */
export function encodeCopySource(bucket: string, key: string): string {
  if (!bucket || bucket.includes("/")) throw invalidPath(bucket);
  if (!key) throw invalidPath(key);
  return `${encodeURIComponent(bucket)}/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

/** Synthetic POSIX modes: S3 has no permission bits of its own. */
export const S3_DIR_MODE = 0o040755;
export const S3_FILE_MODE = 0o100644;
