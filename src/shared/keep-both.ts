/**
 * Finder/ForkLift-style "Keep Both" naming: file.txt → file (2).txt → file (3).txt.
 * Pure so the decision table is unit-testable (§8).
 */
export function keepBothName(existing: ReadonlySet<string>, name: string): string {
  if (!existing.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const isDotfile = dot <= 0;
  const stem = isDotfile ? name : name.slice(0, dot);
  const ext = isDotfile ? "" : name.slice(dot);
  // "file (2)" stems keep counting from their base.
  const match = stem.match(/^(.*) \((\d+)\)$/);
  const base = match ? match[1] : stem;
  let n = match ? Number.parseInt(match[2], 10) + 1 : 2;
  for (; n < 10_000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`No free name for ${name}`);
}
