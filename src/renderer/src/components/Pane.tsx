import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, AlertTriangle, Server, CircleX, RefreshCw } from "lucide-react";
import type { SortKey } from "@shared/types";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { visibleEntries } from "@/lib/entries";
import { FileList } from "./FileList";
import { Button } from "@/components/ui/button";
import { navigate, pathLib, setActive, setSort, useAppState, type PaneBackend, type PaneId } from "@/store/panes";
import { disconnectPane, reconnectPane } from "@/store/sftp";

function SortHeader({
  paneId,
  label,
  colKey,
  activeKey,
  dir,
  className,
}: {
  paneId: PaneId;
  label: string;
  colKey: SortKey;
  activeKey: SortKey;
  dir: "asc" | "desc";
  className?: string;
}): React.JSX.Element {
  const isActive = colKey === activeKey;
  const Chevron = dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <button
      className={cn(
        "text-muted-foreground hover:text-foreground flex items-center gap-0.5 px-1 text-xs font-medium",
        isActive && "text-foreground",
        className,
      )}
      onClick={() => setSort(paneId, colKey)}
    >
      <span className="truncate">{label}</span>
      {isActive && <Chevron className="size-3 shrink-0" />}
    </button>
  );
}

function Breadcrumbs({ paneId, cwd, backend }: { paneId: PaneId; cwd: string; backend: PaneBackend }): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cwd);
  const lib = pathLib(backend);
  const rootLabel = backend.kind === "sftp" ? backend.host : "Macintosh HD";

  const segments = useMemo(() => {
    const segs = lib.segments(cwd);
    // Show at most the last 4 segments to keep the bar readable.
    return segs.length > 4 ? segs.slice(segs.length - 4) : segs;
  }, [cwd, lib]);

  if (editing) {
    return (
      <form
        className="flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          const target = draft.trim();
          setEditing(false);
          if (target && target !== cwd) void navigate(paneId, lib.normalize(target));
        }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
            e.stopPropagation();
          }}
          className="border-input bg-background focus:ring-ring w-full rounded-sm border px-1.5 py-0.5 font-mono text-xs outline-none focus:ring-1"
          spellCheck={false}
        />
      </form>
    );
  }

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      onDoubleClick={() => {
        setDraft(cwd);
        setEditing(true);
      }}
      title="Double-click to edit path"
    >
      {segments.map((seg, i) => (
        <span
          key={seg.path}
          className="flex min-w-0 items-center gap-0.5"
        >
          {i > 0 && <ChevronRight className="text-muted-foreground/60 size-3 shrink-0" />}
          <button
            className={cn(
              "hover:bg-accent max-w-40 truncate rounded-sm px-1 py-0.5 text-xs",
              i === segments.length - 1 ? "font-medium" : "text-muted-foreground",
            )}
            onClick={() => {
              if (seg.path !== cwd) void navigate(paneId, seg.path);
            }}
          >
            {seg.name === "/" ? rootLabel : seg.name}
          </button>
        </span>
      ))}
    </div>
  );
}

export function Pane({ paneId }: { paneId: PaneId }): React.JSX.Element {
  const app = useAppState();
  const pane = app.panes[paneId];
  const isActive = app.active === paneId;

  const visible = useMemo(
    () => visibleEntries(pane.entries, pane.sortKey, pane.sortDir, app.showHidden),
    [pane.entries, pane.sortKey, pane.sortDir, app.showHidden],
  );

  const statusLine = useMemo(() => {
    const items = `${visible.length} item${visible.length === 1 ? "" : "s"}`;
    const sel = pane.selected.size;
    const selPart = sel > 0 ? `${sel} of ${visible.length} selected` : items;
    const avail = pane.availBytes != null ? `, ${formatBytes(pane.availBytes)} available` : "";
    return selPart + avail;
  }, [visible.length, pane.selected.size, pane.availBytes]);

  return (
    <section
      className={cn(
        "bg-background flex min-w-0 flex-1 flex-col overflow-hidden border-t-2",
        isActive ? "border-t-primary" : "border-t-transparent",
      )}
      onMouseDownCapture={() => setActive(paneId)}
      data-pane={paneId}
    >
      <div className="flex h-8 items-center gap-1 border-b px-2">
        {pane.backend.kind === "sftp" && (
          <span
            className="bg-primary/10 text-primary flex shrink-0 items-center gap-1 rounded-full py-0.5 pr-0.5 pl-2 text-[11px] font-medium"
            title={`${pane.backend.username}@${pane.backend.host} — click × to disconnect`}
          >
            <Server className="size-3" />
            {pane.backend.host}
            <button
              className="hover:bg-primary/20 rounded-full p-0.5"
              aria-label="Disconnect"
              onClick={() => void disconnectPane(paneId)}
            >
              <CircleX className="size-3.5" />
            </button>
          </span>
        )}
        <Breadcrumbs
          paneId={paneId}
          cwd={pane.cwd}
          backend={pane.backend}
        />
        {pane.loading && (
          <span className="border-muted-foreground/40 border-t-foreground size-3 shrink-0 animate-spin rounded-full border" />
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_5.5rem_11rem] gap-2 border-b px-3 py-1">
        <SortHeader
          paneId={paneId}
          label="Name"
          colKey="name"
          activeKey={pane.sortKey}
          dir={pane.sortDir}
          className="justify-start"
        />
        <SortHeader
          paneId={paneId}
          label="Size"
          colKey="size"
          activeKey={pane.sortKey}
          dir={pane.sortDir}
          className="justify-end"
        />
        <SortHeader
          paneId={paneId}
          label="Date Modified"
          colKey="mtime"
          activeKey={pane.sortKey}
          dir={pane.sortDir}
          className="justify-end"
        />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {pane.error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertTriangle className="size-6 text-amber-500" />
            <p className="text-muted-foreground text-sm">{pane.error}</p>
          </div>
        ) : visible.length === 0 && !pane.loading && pane.cwd ? (
          <div
            className="text-muted-foreground flex flex-1 items-center justify-center text-sm"
            onMouseDown={() => setActive(paneId)}
          >
            Empty folder
          </div>
        ) : (
          <FileList
            paneId={paneId}
            pane={pane}
            visible={visible}
            isActive={isActive}
          />
        )}
        {pane.backend.kind === "sftp" && pane.backend.status !== "connected" && (
          <div className="bg-background/70 absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 backdrop-blur-[1px]">
            {pane.backend.status === "disconnected" ? (
              <>
                <AlertTriangle className="text-destructive size-6" />
                <p className="text-sm font-medium">Connection lost</p>
                {pane.backend.statusDetail && <p className="text-muted-foreground text-xs">{pane.backend.statusDetail}</p>}
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    onClick={() => reconnectPane(paneId)}
                  >
                    <RefreshCw data-icon="inline-start" /> Reconnect
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void disconnectPane(paneId)}
                  >
                    Disconnect
                  </Button>
                </div>
              </>
            ) : (
              <>
                <span className="border-muted-foreground/40 border-t-foreground size-5 animate-spin rounded-full border-2" />
                <p className="text-muted-foreground text-sm">
                  {pane.backend.status === "connecting" ? "Connecting…" : "Reconnecting…"}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <div className="text-muted-foreground border-t px-3 py-1 text-center text-[11px]">{statusLine}</div>
    </section>
  );
}
