import type { Entry } from "@shared/fs/fs.types";
import { kindFromMode } from "../../utils/file-mode";

/** `stat` flavour found on the server: GNU coreutils and BusyBox share `-c`, BSD uses `-f`. */
export type StatDialect = "gnu" | "bsd";

/** Exit codes the scripts below use to report errno-like failures. */
const EXIT_CODES: Record<number, string> = { 44: "ENOENT", 45: "ENOTDIR", 46: "EEXIST", 47: "EISDIR" };

export const READY_MARKER = "PALLET-READY\n";

export function scpError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

/** Single-quote a value for POSIX sh. Paths never reach a shell any other way. */
export function shQuote(value: string): string {
  if (value.includes("\0")) throw scpError("EINVAL", "Path contains a NUL byte");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Remote paths are absolute, so none can be mistaken for an option. */
export function quotePath(path: string): string {
  if (!path.startsWith("/")) throw scpError("EINVAL", `Not an absolute path: ${path}`);
  return shQuote(path);
}

function statFormat(dialect: StatDialect): string {
  return dialect === "gnu" ? "stat -c '%f %s %Y %n' --" : "stat -f '%p %z %m %N' --";
}

const EXISTS = (q: string): string => `{ [ -e ${q} ] || [ -L ${q} ]; }`;

/**
 * Probe output, sections separated by NUL: home directory, GNU stat sample,
 * BSD stat sample, scp location. Exercises the same printf | xargs -0 stat
 * pipeline the listing uses.
 */
export const PROBE_SCRIPT = [
  "pwd -P; printf '\\0'",
  `printf '/\\0' | xargs -0 ${statFormat("gnu")} 2>/dev/null; printf '\\0'`,
  `printf '/\\0' | xargs -0 ${statFormat("bsd")} 2>/dev/null; printf '\\0'`,
  "command -v scp; printf '\\0'",
  "",
].join("\n");

export interface ProbeResult {
  home: string;
  dialect: StatDialect | null;
  hasScp: boolean;
}

export function parseProbe(output: Buffer): ProbeResult {
  const [home = "", gnu = "", bsd = "", scp = ""] = output.toString("utf8").split("\0");
  const dialect = /^[0-9a-f]+ \d+ \d+ \/\n$/.test(gnu) ? "gnu" : /^[0-7]+ \d+ \d+ \/\n$/.test(bsd) ? "bsd" : null;
  return { home: home.replace(/\n$/, "") || "/", dialect, hasScp: scp.trim().length > 0 };
}

/**
 * List one directory without forking per entry. Output: `<kind><name>\0` per
 * entry (kind d/f/u is the followed target: dir, other, dangling), an empty
 * record, then one `stat` line per entry in the same order.
 */
export function listScript(dir: string, dialect: StatDialect): string {
  const q = quotePath(dir);
  return [
    `${EXISTS(q)} || exit 44`,
    `[ -d ${q} ] || exit 45`,
    `cd -- ${q} || exit 1`,
    "set -- * .[!.]* ..?*",
    "n=0",
    `for f do if [ -e "$f" ] || [ -L "$f" ]; then n=$((n + 1)); if [ -d "$f" ]; then k=d; elif [ -e "$f" ]; then k=f; else k=u; fi; printf '%s%s\\0' "$k" "$f"; fi; done`,
    "printf '\\0'",
    `[ "$n" -eq 0 ] || for f do if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\\0' "$f"; fi; done | xargs -0 ${statFormat(dialect)}`,
    "exit 0",
    "",
  ].join("\n");
}

/** Output: `<kind>\0` then one stat line named exactly as the path. */
export function statScript(path: string, dialect: StatDialect): string {
  const q = quotePath(path);
  return [
    `${EXISTS(q)} || exit 44`,
    `if [ -d ${q} ]; then k=d; elif [ -e ${q} ]; then k=f; else k=u; fi`,
    "printf '%s\\0' \"$k\"",
    `${statFormat(dialect)} ${q}`,
    "",
  ].join("\n");
}

export interface RawStat {
  /** Kind of the followed target; "u" for a dangling link. */
  target: "d" | "f" | "u";
  mode: number;
  size: number;
  mtimeMs: number;
}

/**
 * Read `mode size mtime name\n` records whose names are known in advance.
 * Matching each record against its expected name keeps a newline inside a
 * name from shifting the join; a name with no record vanished mid-listing.
 */
function parseStatRecords(text: string, names: string[], dialect: StatDialect): Map<string, Omit<RawStat, "target">> {
  const out = new Map<string, Omit<RawStat, "target">>();
  const header = dialect === "gnu" ? /([0-9a-f]+) (\d+) (\d+) /y : /([0-7]+) (\d+) (\d+) /y;
  let pos = 0;
  let index = 0;
  while (pos < text.length) {
    header.lastIndex = pos;
    const match = header.exec(text);
    if (!match) throw scpError("EPROTO", "Unexpected stat output from the server");
    const after = pos + match[0].length;
    let found = -1;
    for (let i = index; i < names.length; i++) {
      if (text.startsWith(`${names[i]}\n`, after)) {
        found = i;
        break;
      }
    }
    if (found === -1) throw scpError("EPROTO", "Unexpected stat output from the server");
    out.set(names[found], {
      mode: Number.parseInt(match[1], dialect === "gnu" ? 16 : 8),
      size: Number(match[2]),
      mtimeMs: Number(match[3]) * 1000,
    });
    index = found + 1;
    pos = after + names[found].length + 1;
  }
  return out;
}

export function parseListing(stdout: Buffer, dialect: StatDialect): { name: string; stat: RawStat }[] {
  const text = stdout.toString("utf8");
  const records: { name: string; target: RawStat["target"] }[] = [];
  let pos = 0;
  for (;;) {
    const end = text.indexOf("\0", pos);
    if (end === -1) throw scpError("EPROTO", "Truncated listing from the server");
    const record = text.slice(pos, end);
    pos = end + 1;
    if (record === "") break;
    const target = record[0];
    if (target !== "d" && target !== "f" && target !== "u") throw scpError("EPROTO", "Unexpected listing output");
    records.push({ name: record.slice(1), target });
  }
  const stats = parseStatRecords(
    text.slice(pos),
    records.map((r) => r.name),
    dialect,
  );
  return records.flatMap((r) => {
    const stat = stats.get(r.name);
    return stat ? [{ name: r.name, stat: { ...stat, target: r.target } }] : [];
  });
}

export function parseStat(stdout: Buffer, path: string, dialect: StatDialect): RawStat {
  const text = stdout.toString("utf8");
  const target = text[0];
  if (text[1] !== "\0" || (target !== "d" && target !== "f" && target !== "u")) {
    throw scpError("EPROTO", "Unexpected stat output from the server");
  }
  const stat = parseStatRecords(text.slice(2), [path], dialect).get(path);
  if (!stat) throw scpError("ENOENT", `Remote path not found: ${path}`);
  return { ...stat, target };
}

export function entryFrom(dir: string, name: string, stat: RawStat): Entry {
  const kind = kindFromMode(stat.mode);
  return {
    name,
    path: dir === "/" ? `/${name}` : `${dir}/${name}`,
    kind,
    ...(kind === "symlink"
      ? { targetKind: stat.target === "d" ? ("dir" as const) : stat.target === "f" ? ("file" as const) : ("unknown" as const) }
      : {}),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
    hidden: name.startsWith("."),
  };
}

export const realpathScript = (path: string): string =>
  `${EXISTS(quotePath(path))} || exit 44\ncd -- ${quotePath(path)} || exit 45\npwd -P\n`;

export const mkdirScript = (path: string): string => `${EXISTS(quotePath(path))} && exit 46\nmkdir -- ${quotePath(path)}\n`;

export const mkdirpScript = (path: string): string =>
  `mkdir -p -- ${quotePath(path)} || exit 1\n[ -d ${quotePath(path)} ] || exit 45\n`;

/** Browse rename: never replaces an existing destination. */
export const renameScript = (from: string, to: string): string =>
  [
    `${EXISTS(quotePath(from))} || exit 44`,
    `${EXISTS(quotePath(to))} && exit 46`,
    `mv -- ${quotePath(from)} ${quotePath(to)}`,
    "",
  ].join("\n");

/**
 * Commit a staged file. `[ -d ]` follows links, so a directory or a link to
 * one fails instead of `mv` moving the staged file inside it.
 */
export const replaceScript = (from: string, to: string): string =>
  [`[ -d ${quotePath(to)} ] && exit 47`, `mv -f -- ${quotePath(from)} ${quotePath(to)}`, ""].join("\n");

export const removeFileScript = (path: string): string => `rm -f -- ${quotePath(path)}\n`;

/** POSIX `rm -r` removes symlinks without following them. */
export const removeTreeScript = (path: string): string => {
  if (path === "/") throw scpError("EINVAL", "Cannot delete the root folder");
  return `${EXISTS(quotePath(path))} || exit 44\nrm -rf -- ${quotePath(path)}\n`;
};

export function octalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

export const chmodScript = (path: string, mode: number): string => `chmod ${octalMode(mode)} ${quotePath(path)}\n`;

/** `touch -t` takes local time, so pin the zone to UTC. Sets atime too, like SFTP utimes. */
export function touchScript(path: string, mtimeMs: number): string {
  const d = new Date(Math.floor(mtimeMs / 1000) * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.${pad(d.getUTCSeconds())}`;
  return `TZ=UTC0 touch -t ${stamp} -- ${quotePath(path)}\n`;
}

/** The marker is printed on the same line as `exec`, so the shell has read the whole script before it appears. */
export const sinkScript = (path: string): string => `printf 'PALLET-READY\\n'; exec scp -p -t -- ${quotePath(path)}\n`;
export const sourceScript = (path: string): string => `printf 'PALLET-READY\\n'; exec scp -p -f -- ${quotePath(path)}\n`;

export function exitError(code: number | null, stderr: string, fallback: string): NodeJS.ErrnoException {
  const errno = code === null ? undefined : EXIT_CODES[code];
  const detail = stderr.trim().split("\n").at(-1)?.trim();
  if (errno === "ENOENT") return scpError(errno, `${fallback}: no such file or folder`);
  if (errno === "ENOTDIR") return scpError(errno, `${fallback}: not a folder`);
  if (errno === "EEXIST") return scpError(errno, `${fallback}: already exists`);
  if (errno === "EISDIR") return scpError(errno, `${fallback}: a folder is in the way`);
  if (/permission denied/i.test(detail ?? "")) return scpError("EACCES", `${fallback}: ${detail}`);
  return scpError(code === null ? "ECONNABORTED" : "EIO", detail ? `${fallback}: ${detail}` : fallback);
}
