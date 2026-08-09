/**
 * Path utilities usable from any process, including the renderer.
 *
 * The renderer is banned (by lint rule) from importing Node's `path`, because
 * remote paths are always POSIX regardless of the local platform. `remotePath`
 * is strictly POSIX; `localPath` handles the local platform, which for Pallet
 * is macOS only, so both are slash-separated — but they stay separate modules
 * so the distinction survives if a Windows build ever happens, and so remote
 * semantics (no `~`, no drive letters) stay isolated.
 */

function normalizeSegments(input: string): { abs: boolean; segs: string[] } {
  const abs = input.startsWith("/");
  const segs: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segs.length > 0 && segs[segs.length - 1] !== "..") segs.pop();
      else if (!abs) segs.push("..");
      continue;
    }
    segs.push(part);
  }
  return { abs, segs };
}

function posixNormalize(p: string): string {
  const { abs, segs } = normalizeSegments(p);
  if (segs.length === 0) return abs ? "/" : ".";
  return (abs ? "/" : "") + segs.join("/");
}

function posixJoin(...parts: string[]): string {
  const joined = parts.filter((p) => p !== "").join("/");
  return joined === "" ? "." : posixNormalize(joined);
}

function posixDirname(p: string): string {
  const n = posixNormalize(p);
  if (n === "/") return "/";
  const idx = n.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return n.slice(0, idx);
}

function posixBasename(p: string): string {
  const n = posixNormalize(p);
  if (n === "/") return "/";
  const idx = n.lastIndexOf("/");
  return idx === -1 ? n : n.slice(idx + 1);
}

/** Split an absolute path into breadcrumb segments, each with its full path. */
function posixSegments(p: string): { name: string; path: string }[] {
  const n = posixNormalize(p);
  const out: { name: string; path: string }[] = [{ name: "/", path: "/" }];
  if (n === "/" || !n.startsWith("/")) return n.startsWith("/") ? out : [];
  let acc = "";
  for (const part of n.split("/").slice(1)) {
    acc += "/" + part;
    out.push({ name: part, path: acc });
  }
  return out;
}

function extname(p: string): string {
  const base = posixBasename(p);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx) : "";
}

export const remotePath = {
  join: posixJoin,
  normalize: posixNormalize,
  dirname: posixDirname,
  basename: posixBasename,
  segments: posixSegments,
  extname,
  isAbsolute: (p: string): boolean => p.startsWith("/"),
};

// macOS local paths are POSIX; kept as a distinct object on purpose (see header).
export const localPath = {
  join: posixJoin,
  normalize: posixNormalize,
  dirname: posixDirname,
  basename: posixBasename,
  segments: posixSegments,
  extname,
  isAbsolute: (p: string): boolean => p.startsWith("/"),
};
