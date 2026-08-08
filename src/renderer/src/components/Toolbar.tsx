import { ArrowLeft, ArrowRight, FolderPlus, Info, RotateCw, Trash2 } from "lucide-react";
import { goBack, goForward, refresh, setInspectorOpen, useAppState } from "@/store/panes";
import { newFolder, trashSelection } from "@/store/ops";
import { cn } from "@/lib/utils";
import { localPath } from "@shared/paths";

function ToolButton({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "text-foreground/80 hover:bg-accent hover:text-accent-foreground rounded-full px-2 py-1.5 disabled:pointer-events-none disabled:opacity-35",
        "[-webkit-app-region:no-drag]",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

function ToolButtonGroup({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="bg-sidebar flex items-center gap-0 rounded-full">{children}</div>;
}

export function Toolbar(): React.JSX.Element {
  const app = useAppState();
  const pane = app.panes[app.active];
  const title = pane.cwd === "/" ? "Macintosh HD" : localPath.basename(pane.cwd || "");

  return (
    <header className="flex h-11 shrink-0 items-center gap-4 px-2 [-webkit-app-region:drag]">
      <ToolButtonGroup>
        <ToolButton
          icon={ArrowLeft}
          label="Back"
          onClick={() => goBack(app.active)}
          disabled={pane.historyIndex <= 0}
        />
        <ToolButton
          icon={ArrowRight}
          label="Forward"
          onClick={() => goForward(app.active)}
          disabled={pane.historyIndex >= pane.history.length - 1}
        />
      </ToolButtonGroup>
      <div className="flex-1 truncate text-[13px] font-semibold">{title}</div>
      <ToolButtonGroup>
        <ToolButton
          icon={RotateCw}
          label="Refresh"
          onClick={() => refresh(app.active)}
        />
        <ToolButton
          icon={FolderPlus}
          label="New Folder"
          onClick={() => void newFolder(app.active)}
          disabled={!pane.cwd || !!pane.error}
        />
        <ToolButton
          icon={Trash2}
          label="Move to Trash"
          onClick={() => void trashSelection(app.active)}
          disabled={pane.selected.size === 0}
        />
        <ToolButton
          icon={Info}
          label="Get Info (⌘I)"
          onClick={() => setInspectorOpen(!app.inspectorOpen)}
        />
      </ToolButtonGroup>
    </header>
  );
}
