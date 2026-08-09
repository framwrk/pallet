/** Byte formatting following macOS convention: decimal units, 2 decimals max. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes === 0) return "Zero bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const rounded = unit === 0 ? String(value) : value >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${rounded} ${units[unit]}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

/** Finder-style modified date: "Today at 3:42 PM", "Yesterday at …", else date. */
export function formatModified(mtimeMs: number): string {
  if (!mtimeMs) return "--";
  const d = new Date(mtimeMs);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  if (d.getTime() >= startOfToday) return `Today at ${timeFmt.format(d)}`;
  if (d.getTime() >= startOfYesterday) return `Yesterday at ${timeFmt.format(d)}`;
  return `${dateFmt.format(d)} at ${timeFmt.format(d)}`;
}
