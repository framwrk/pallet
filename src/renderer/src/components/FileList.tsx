import { CornerUpRight, File as FileIcon, Folder } from "lucide-react";
import { type PaneId, type PaneState, clearSelection, extendTo, selectOnly, setActive, toggleSelect } from "@/store/panes";
import { cancelRename, commitRename, openEntry, showBackgroundContextMenu, showRowContextMenu } from "@/store/ops";
import { formatBytes, formatModified } from "@/lib/format";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "@shared/types";
import { cn } from "@/lib/utils";
import { enqueuePaneCopy } from "@/store/transfers";
import { isDirLike } from "@/lib/entries";
import { useVirtualizer } from "@tanstack/react-virtual";

const DND_MIME = "application/x-pallet-items";

interface DragPayload {
  pane: PaneId;
  names: string[];
}

function readDragPayload(e: React.DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DND_MIME);
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}

function RenameInput({ paneId, entry }: { paneId: PaneId; entry: Entry }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  const committed = useRef(false);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the stem, not the extension, Finder-style.
    const dot = entry.kind === "file" ? entry.name.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry.kind, entry.name]);

  function commit(): void {
    if (committed.current) return;
    committed.current = true;
    void commitRename(paneId, entry.name, ref.current?.value ?? entry.name);
  }

  return (
    <input
      ref={ref}
      defaultValue={entry.name}
      spellCheck={false}
      className="border-primary bg-background text-foreground w-full min-w-0 rounded-sm border px-1 py-0 text-[13px] outline-none"
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          committed.current = true;
          cancelRename(paneId);
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

const ROW_HEIGHT = 26;

interface FileListProps {
  paneId: PaneId;
  pane: PaneState;
  visible: Entry[];
  isActive: boolean;
}

export function FileList({ paneId, pane, visible, isActive }: FileListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<"pane" | string | null>(null);

  function onRowDragStart(e: React.DragEvent, entry: Entry): void {
    const names = pane.selected.has(entry.name) ? [...pane.selected] : [entry.name];
    if (!pane.selected.has(entry.name)) selectOnly(paneId, entry.name);
    e.dataTransfer.setData(DND_MIME, JSON.stringify({ pane: paneId, names } satisfies DragPayload));
    e.dataTransfer.effectAllowed = "copy";
  }

  function acceptDrop(e: React.DragEvent): boolean {
    if (![...e.dataTransfer.types].includes(DND_MIME)) return false;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    return true;
  }

  function onDrop(e: React.DragEvent, destDir?: string): void {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const payload = readDragPayload(e);
    if (!payload) return;
    // Dropping into the pane you dragged from with no folder target is a no-op.
    if (payload.pane === paneId && destDir === undefined) return;
    void enqueuePaneCopy(payload.pane, paneId, payload.names, destDir);
  }

  // TanStack Virtual returns methods that read live scroll state, so the React
  // Compiler refuses to memoize this component. That is the behaviour we want
  // here -- the rows must re-render on scroll -- so silence the advisory.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const focusedIndex = useMemo(() => visible.findIndex((e) => e.name === pane.focused), [visible, pane.focused]);

  useEffect(() => {
    if (focusedIndex >= 0) virtualizer.scrollToIndex(focusedIndex);
  }, [focusedIndex, virtualizer]);

  function onRowMouseDown(e: React.MouseEvent, entry: Entry): void {
    setActive(paneId);
    if (e.metaKey) {
      toggleSelect(paneId, entry.name);
    } else if (e.shiftKey) {
      extendTo(paneId, entry.name, visible);
    } else if (!pane.selected.has(entry.name)) {
      selectOnly(paneId, entry.name);
    } else {
      // Already-selected row: keep multi-selection (drag semantics later).
      selectOnly(paneId, entry.name);
    }
  }

  function onRowDoubleClick(entry: Entry): void {
    openEntry(paneId, entry);
  }

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === scrollRef.current || e.target === e.currentTarget) {
          setActive(paneId);
          clearSelection(paneId);
        }
      }}
      onContextMenu={(e) => {
        if (e.target === scrollRef.current || e.target === e.currentTarget) {
          e.preventDefault();
          setActive(paneId);
          void showBackgroundContextMenu(paneId);
        }
      }}
      onDragOver={(e) => {
        if (acceptDrop(e)) setDropTarget("pane");
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDropTarget(null);
      }}
      onDrop={(e) => onDrop(e)}
      data-drop-active={dropTarget === "pane" || undefined}
      style={dropTarget === "pane" ? { boxShadow: "inset 0 0 0 2px var(--primary)" } : undefined}
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const entry = visible[row.index];
          const selected = pane.selected.has(entry.name);
          const dirLike = isDirLike(entry);
          return (
            <div
              key={entry.name}
              className={cn(
                "absolute left-0 grid w-full grid-cols-[minmax(0,1fr)_5.5rem_11rem] items-center gap-2 px-3 text-[13px]",
                // row.index % 2 === 1 && !selected && "bg-muted/40",
                selected && (isActive ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"),
              )}
              style={{
                height: ROW_HEIGHT,
                transform: `translateY(${row.start}px)`,
                ...(dropTarget === entry.name ? { boxShadow: "inset 0 0 0 2px var(--primary)" } : {}),
              }}
              draggable
              onDragStart={(e) => onRowDragStart(e, entry)}
              onDragOver={(e) => {
                if (dirLike && acceptDrop(e)) {
                  e.stopPropagation();
                  setDropTarget(entry.name);
                }
              }}
              onDragLeave={() => {
                if (dropTarget === entry.name) setDropTarget(null);
              }}
              onDrop={(e) => {
                if (dirLike) onDrop(e, entry.path);
              }}
              onMouseDown={(e) => onRowMouseDown(e, entry)}
              onDoubleClick={() => onRowDoubleClick(entry)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setActive(paneId);
                void showRowContextMenu(paneId, entry);
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                {dirLike ? (
                  <Folder
                    className={cn("size-4 shrink-0", selected && isActive ? "text-primary-foreground" : "text-sky-500")}
                    fill="currentColor"
                    strokeWidth={0}
                  />
                ) : (
                  <FileIcon
                    className={cn(
                      "size-4 shrink-0",
                      selected && isActive ? "text-primary-foreground" : "text-muted-foreground",
                    )}
                  />
                )}
                {pane.renaming === entry.name ? (
                  <RenameInput
                    paneId={paneId}
                    entry={entry}
                  />
                ) : (
                  <span className="truncate">{entry.name}</span>
                )}
                {entry.kind === "symlink" && <CornerUpRight className="size-3 shrink-0 opacity-60" />}
              </span>
              <span
                className={cn(
                  "text-right tabular-nums",
                  !selected && "text-muted-foreground",
                  selected && isActive && "text-primary-foreground/80",
                )}
              >
                {dirLike ? "--" : formatBytes(entry.size)}
              </span>
              <span
                className={cn(
                  "truncate text-right tabular-nums",
                  !selected && "text-muted-foreground",
                  selected && isActive && "text-primary-foreground/80",
                )}
              >
                {formatModified(entry.mtimeMs)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
