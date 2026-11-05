import type { Entry, SortDir, SortKey } from "@shared/fs/fs.types";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function isDirLike(e: Entry): boolean {
  return e.kind === "dir" || (e.kind === "symlink" && e.targetKind === "dir");
}

/** Filter + sort a listing for display, Finder-style by default. */
export function visibleEntries(
  entries: readonly Entry[],
  sortKey: SortKey,
  sortDir: SortDir,
  showHidden: boolean,
  foldersFirst = true,
): Entry[] {
  const filtered = showHidden ? [...entries] : entries.filter((e) => !e.hidden);
  const sign = sortDir === "asc" ? 1 : -1;
  filtered.sort((a, b) => {
    const da = isDirLike(a);
    const db = isDirLike(b);
    if (foldersFirst && da !== db) return da ? -1 : 1;
    let cmp: number;
    switch (sortKey) {
      case "size":
        // Folder sizes aren't computed; fall back to name among folders. When
        // folders are mixed in, use their size so the order stays coherent.
        cmp = foldersFirst && da ? collator.compare(a.name, b.name) : a.size - b.size;
        break;
      case "mtime":
        cmp = a.mtimeMs - b.mtimeMs;
        break;
      default:
        cmp = collator.compare(a.name, b.name);
    }
    if (cmp === 0) cmp = collator.compare(a.name, b.name);
    return cmp * sign;
  });
  return filtered;
}
