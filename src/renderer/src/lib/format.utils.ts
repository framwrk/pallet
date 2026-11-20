/** Byte formatting following macOS convention: decimal units, 2 decimals max. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes === 0) return "Zero bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB", "PB"];
  // Round whole bytes first, so 999.6 becomes 1 KB rather than "1000 bytes".
  let value = bytes < 1000 ? Math.round(bytes) : bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit === 0) return `${value} ${units[0]}`;
  // Pick decimals from the rounded value, carrying into the next unit: 99.996 KB is
  // "100 KB" and 999.6 KB is "1.00 MB", never "100.00 KB" or "1000 KB".
  let rounded = value.toFixed(2);
  if (Number(rounded) >= 100) rounded = value.toFixed(0);
  if (Number(rounded) >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
    rounded = value.toFixed(2);
  }
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
