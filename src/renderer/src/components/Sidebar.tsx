import { useRef, useState } from "react";
import { Download, FileText, HardDrive, Home, Monitor, Plug, Server, Usb } from "lucide-react";
import type { ColorLabel, Favorite } from "@shared/types";
import { cn } from "@/lib/utils";
import { type PaneId, navigate, setConnectOpen, setEditingFavorite, useAppState } from "@/store/panes";
import { connectFavorite, favoriteContextMenu, reorderFavorites } from "@/store/favorites";

const LABEL_COLORS: Record<ColorLabel, string> = {
  none: "",
  red: "bg-red-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-400",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  gray: "bg-gray-400",
};

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-muted-foreground px-2 pb-1 text-[10px] font-semibold tracking-wider">{children}</div>;
}

function SidebarItem({
  icon: Icon,
  label,
  path,
  activePaneId,
  currentPath,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  path: string;
  activePaneId: PaneId;
  currentPath: string;
}): React.JSX.Element {
  return (
    <button
      className={cn(
        "text-sidebar-foreground hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]",
        currentPath === path && "bg-sidebar-accent font-medium",
      )}
      onClick={() => void navigate(activePaneId, path)}
    >
      <Icon className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function FavoriteItem({
  favorite,
  activePaneId,
  onDragStart,
  onDragOver,
  onDrop,
  dragTarget,
}: {
  favorite: Favorite;
  activePaneId: PaneId;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  dragTarget: boolean;
}): React.JSX.Element {
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        "text-sidebar-foreground hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]",
        dragTarget && "border-primary border-t-2",
      )}
      onClick={() => void connectFavorite(activePaneId, favorite.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        void favoriteContextMenu(activePaneId, favorite).then((action) => {
          if (action === "edit") setEditingFavorite(favorite);
        });
      }}
      title={`${favorite.username}@${favorite.host}:${favorite.port}${favorite.note ? ` — ${favorite.note}` : ""}`}
    >
      <Server className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
      <span className="truncate">{favorite.name}</span>
      {favorite.colorLabel !== "none" && (
        <span className={cn("ml-auto size-2.5 shrink-0 rounded-full", LABEL_COLORS[favorite.colorLabel])} />
      )}
    </button>
  );
}

export function Sidebar(): React.JSX.Element {
  const app = useAppState();
  const currentPath = app.panes[app.active].cwd;
  const kf = app.knownFolders;
  const common = { activePaneId: app.active, currentPath };
  const dragIndex = useRef<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function commitDrop(target: number): void {
    const from = dragIndex.current;
    dragIndex.current = null;
    setDropIndex(null);
    if (from == null || from === target) return;
    const ids = app.favorites.map((f) => f.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(target > from ? target - 1 : target, 0, moved);
    void reorderFavorites(ids);
  }

  return (
    <aside className="bg-sidebar m-2 flex w-48 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg p-2">
      <button
        className="border-border text-sidebar-foreground hover:bg-sidebar-accent flex w-full items-center gap-2 rounded-md border border-dashed px-2 py-1.5 text-left text-[13px]"
        onClick={() => setConnectOpen(true)}
        title="Connect to Server (⌘K)"
      >
        <Plug className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
        <span className="truncate">Connect to Server…</span>
      </button>
      <div>
        <SectionTitle>DEVICES</SectionTitle>
        {app.volumes.map((v) => (
          <SidebarItem
            key={v.path}
            icon={v.isRoot ? HardDrive : Usb}
            label={v.name}
            path={v.path}
            {...common}
          />
        ))}
      </div>
      {kf && (
        <div>
          <SectionTitle>PLACES</SectionTitle>
          <SidebarItem
            icon={Home}
            label="Home"
            path={kf.home}
            {...common}
          />
          <SidebarItem
            icon={Monitor}
            label="Desktop"
            path={kf.desktop}
            {...common}
          />
          <SidebarItem
            icon={FileText}
            label="Documents"
            path={kf.documents}
            {...common}
          />
          <SidebarItem
            icon={Download}
            label="Downloads"
            path={kf.downloads}
            {...common}
          />
        </div>
      )}
      {app.favorites.length > 0 && (
        <div onDragLeave={() => setDropIndex(null)}>
          <SectionTitle>FAVORITES</SectionTitle>
          {app.favorites.map((favorite, i) => (
            <FavoriteItem
              key={favorite.id}
              favorite={favorite}
              activePaneId={app.active}
              onDragStart={() => (dragIndex.current = i)}
              onDragOver={(e) => {
                if (dragIndex.current != null) {
                  e.preventDefault();
                  setDropIndex(i);
                }
              }}
              onDrop={() => commitDrop(i)}
              dragTarget={dropIndex === i}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
