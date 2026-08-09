import { CornerUpRight, File as FileIcon, Folder, X } from "lucide-react";
import type { Entry, PreviewData } from "@shared/fs/fs.types";
import { type PaneBackend, pushToast, refresh, setInspectorOpen, useAppState } from "@/store/pane.store";
import { formatBytes, formatModified } from "@/lib/format.utils";
import { isSizeable, useFolderSizes } from "@renderer/hooks/folder-size.hook";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isDirLike } from "@/lib/entry.utils";
import { localPath } from "@shared/path/path.utils";

const PREVIEW_MAX = 1024 * 1024; // §2.1: inline preview < 1 MB
const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".json",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".xml",
  ".yml",
  ".yaml",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".java",
  ".log",
  ".conf",
  ".ini",
  ".toml",
  ".env",
  ".sql",
  ".csv",
]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

function modeString(mode: number, kind: Entry["kind"]): string {
  const t = kind === "dir" ? "d" : kind === "symlink" ? "l" : "-";
  let out = t;
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (mode >> shift) & 0o7;
    out += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-");
  }
  return out;
}

function PermissionsMatrix({
  mode,
  editable,
  onChange,
}: {
  mode: number;
  editable: boolean;
  onChange: (mode: number) => void;
}): React.JSX.Element {
  const rows: { label: string; shift: number }[] = [
    { label: "Owner", shift: 6 },
    { label: "Group", shift: 3 },
    { label: "Others", shift: 0 },
  ];
  const cols = [
    { label: "R", bit: 4 },
    { label: "W", bit: 2 },
    { label: "X", bit: 1 },
  ];
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th className="pb-1 text-left font-normal" />
          {cols.map((c) => (
            <th
              key={c.label}
              className="pb-1 text-center font-normal"
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td className="text-muted-foreground py-0.5">{row.label}</td>
            {cols.map((col) => {
              const checked = ((mode >> row.shift) & col.bit) !== 0;
              return (
                <td
                  key={col.label}
                  className="py-0.5 text-center"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!editable}
                    onChange={() => onChange(mode ^ (col.bit << row.shift))}
                  />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Preview({ entry, backend }: { entry: Entry; backend: PaneBackend }): React.JSX.Element | null {
  // Mounted with key={entry.path} so each file starts from clean state.
  const [data, setData] = useState<PreviewData | null>(null);
  const [failed, setFailed] = useState(false);
  const ext = localPath.extname(entry.name).toLowerCase();
  const isImage = ext in IMAGE_MIME;
  const isText = TEXT_EXTS.has(ext);
  const eligible = entry.kind === "file" && (isImage || isText) && entry.size <= PREVIEW_MAX;

  useEffect(() => {
    if (!eligible) return;
    let stale = false;
    const load =
      backend.kind === "sftp"
        ? window.pallet.sftp.readPreview(backend.sessionId, entry.path, PREVIEW_MAX)
        : window.pallet.fs.readPreview(entry.path, PREVIEW_MAX);
    load.then(
      (d) => {
        if (!stale) setData(d);
      },
      () => {
        if (!stale) setFailed(true);
      },
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per mount
  }, []);

  if (!eligible || failed) return null;
  if (!data) {
    return <div className="text-muted-foreground py-4 text-center text-xs">Loading preview…</div>;
  }
  if (isImage) {
    return (
      <img
        src={`data:${IMAGE_MIME[ext]};base64,${data.base64}`}
        alt={entry.name}
        className="max-h-48 w-full rounded-md border object-contain"
      />
    );
  }
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  return (
    <pre className="bg-muted/40 max-h-48 overflow-auto rounded-md border p-2 text-[10px] leading-snug whitespace-pre-wrap">
      {text.slice(0, 20_000)}
      {data.truncated && "\n…"}
    </pre>
  );
}

export function Inspector(): React.JSX.Element | null {
  const app = useAppState();
  const pane = app.panes[app.active];
  const entry = useMemo(() => {
    if (pane.selected.size === 1) {
      const name = [...pane.selected][0];
      return pane.entries.find((e) => e.name === name) ?? null;
    }
    return null;
  }, [pane.selected, pane.entries]);

  const editable = pane.backend.kind === "sftp" && entry !== null;
  // Draft is tagged with the file it belongs to; switching files discards it.
  const [draft, setDraft] = useState<{ path: string; mode: number } | null>(null);
  const draftMode = entry && draft?.path === entry.path ? draft.mode : null;
  const setDraftMode = (m: number): void => {
    if (entry) setDraft({ path: entry.path, mode: m & 0o7777 });
  };

  // Above the early return so the hook order stays fixed; an empty list while
  // the inspector is closed keeps it from walking anything you cannot see.
  const folderSizes = useFolderSizes(app.inspectorOpen && entry && isSizeable(entry) ? [entry.path] : [], pane.backend);

  if (!app.inspectorOpen) return null;

  const mode = draftMode ?? (entry ? entry.mode & 0o7777 : 0);
  const dirty = entry !== null && draftMode !== null && draftMode !== (entry.mode & 0o7777);

  async function applyMode(): Promise<void> {
    if (!entry || pane.backend.kind !== "sftp" || draftMode == null) return;
    try {
      await window.pallet.sftp.chmod(pane.backend.sessionId, entry.path, draftMode);
      refresh(app.active);
      pushToast(`Permissions updated for ${entry.name}`, "info");
    } catch (err) {
      pushToast((err as Error).message);
    }
  }

  return (
    <aside className="bg-sidebar flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l p-3">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-semibold tracking-wide">INFO</span>
        <button
          className="hover:bg-accent rounded p-0.5"
          onClick={() => setInspectorOpen(false)}
          aria-label="Close inspector"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {!entry ? (
        <p className="text-muted-foreground text-xs">
          {pane.selected.size > 1 ? `${pane.selected.size} items selected` : "No selection"}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            {isDirLike(entry) ? (
              <Folder
                className="size-8 text-sky-500"
                fill="currentColor"
                strokeWidth={0}
              />
            ) : (
              <FileIcon className="text-muted-foreground size-8" />
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{entry.name}</div>
              <div className="text-muted-foreground text-[11px]">
                {entry.kind === "dir"
                  ? "Folder"
                  : entry.kind === "symlink"
                    ? "Symbolic link"
                    : localPath.extname(entry.name)
                      ? `${localPath.extname(entry.name).slice(1).toUpperCase()} file`
                      : "File"}
              </div>
            </div>
          </div>

          <Preview
            key={entry.path + entry.mtimeMs}
            entry={entry}
            backend={pane.backend}
          />

          <dl className="flex flex-col gap-1 text-xs">
            {(
              [
                ["Kind", entry.kind === "dir" ? "Folder" : entry.kind === "symlink" ? "Symlink" : "File"],
                [
                  "Size",
                  !isDirLike(entry)
                    ? formatBytes(entry.size)
                    : folderSizes.has(entry.path)
                      ? formatBytes(folderSizes.get(entry.path)!)
                      : "--",
                ],
                ["Modified", formatModified(entry.mtimeMs)],
                ["Where", localPath.dirname(entry.path)],
                ["Extension", localPath.extname(entry.name) || "--"],
              ] as const
            ).map(([k, v]) => (
              <div
                key={k}
                className="grid grid-cols-[4.5rem_1fr] gap-2"
              >
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-all">{v}</dd>
              </div>
            ))}
            {entry.kind === "symlink" && (
              <div className="grid grid-cols-[4.5rem_1fr] gap-2">
                <dt className="text-muted-foreground">Target</dt>
                <dd className="flex items-center gap-1">
                  <CornerUpRight className="size-3" /> {entry.targetKind ?? "unknown"}
                </dd>
              </div>
            )}
          </dl>

          <div className="border-t pt-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium">Permissions</span>
              <code className="text-muted-foreground text-[11px]">{modeString(mode, entry.kind)}</code>
            </div>
            <PermissionsMatrix
              mode={mode}
              editable={editable}
              onChange={(m) => setDraftMode(m)}
            />
            <div className="mt-2 flex items-center gap-2">
              <input
                className={cn(
                  "border-input bg-background w-16 rounded-sm border px-1.5 py-0.5 font-mono text-xs",
                  !editable && "opacity-60",
                )}
                value={mode.toString(8).padStart(4, "0")}
                disabled={!editable}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 8);
                  if (Number.isInteger(parsed)) setDraftMode(parsed & 0o7777);
                }}
                spellCheck={false}
              />
              {editable && (
                <Button
                  size="xs"
                  disabled={!dirty}
                  onClick={() => void applyMode()}
                >
                  Apply
                </Button>
              )}
              {!editable && <span className="text-muted-foreground text-[10px]">Editable on remote files</span>}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
