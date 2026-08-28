import { CircleArrowDown, Dock, File, Film, HardDrive, Home, Image, Music, Plug, Server, Usb } from "lucide-react";
import { connectFavorite, favoriteContextMenu, reorderFavorites } from "@/store/favorite.store";
import { navigate, openQuickConnect, setEditingFavorite, useAppState } from "@/store/pane.store";
import { useRef, useState } from "react";
import type { Favorite } from "@shared/favorite/favorite.types";
import { LABEL_COLOR_CLASSES } from "@shared/favorite/favorite.constants";
import { cn } from "@/lib/utils";

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h2 className="text-muted-foreground px-2 pb-1 text-[11px] font-medium tracking-[0.01em]">{children}</h2>;
}

function SidebarItem({
  icon: Icon,
  label,
  path,
  currentPath,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  path: string;
  currentPath: string;
}): React.JSX.Element {
  const isCurrent = currentPath === path;

  return (
    <button
      type="button"
      aria-current={isCurrent ? "location" : undefined}
      className={cn(
        "group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none",
        "text-sidebar-foreground/85 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
        "focus-visible:ring-primary/55 focus-visible:ring-2 focus-visible:ring-inset",
        "transition-[background-color,color,box-shadow] duration-150",
        isCurrent && "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_var(--sidebar-border)]",
      )}
      onClick={() => void navigate("left", path)}
    >
      <Icon
        className={cn(
          "text-muted-foreground group-hover:text-sidebar-foreground size-4 shrink-0 transition-colors duration-150",
          isCurrent && "text-primary group-hover:text-primary",
        )}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

function FavoriteItem({
  favorite,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dragTarget,
}: {
  favorite: Favorite;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  dragTarget: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative flex h-8 w-full cursor-default items-center gap-2 rounded-lg px-2 text-left text-[13px] outline-none",
        "text-sidebar-foreground/85 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
        "focus-visible:ring-primary/55 focus-visible:ring-2 focus-visible:ring-inset",
        "transition-[background-color,color,box-shadow] duration-150",
        dragTarget && "pallet-sidebar-drop-target",
      )}
      onClick={() => void connectFavorite(favorite.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        void favoriteContextMenu(favorite).then((action) => {
          if (action === "edit") setEditingFavorite(favorite);
        });
      }}
      title={`${favorite.protocol.toUpperCase()} — ${favorite.username}@${favorite.host}:${favorite.port}${favorite.note ? ` — ${favorite.note}` : ""}`}
    >
      <Server className="text-muted-foreground group-hover:text-sidebar-foreground size-4 shrink-0 transition-colors duration-150" />
      <span className="truncate">{favorite.name}</span>
      {favorite.colorLabel !== "none" && (
        <span
          aria-hidden="true"
          className={cn(
            "ml-auto size-2.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.18)]",
            LABEL_COLOR_CLASSES[favorite.colorLabel],
          )}
        />
      )}
    </button>
  );
}

export function Sidebar(): React.JSX.Element {
  const app = useAppState();
  // Devices and folders drive the left pane, so it is the one they highlight.
  const common = { currentPath: app.panes.left.cwd };
  const kf = app.knownFolders;
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
    <aside
      aria-label="Locations and connections"
      className="pallet-sidebar m-2 flex w-64 shrink-0 flex-col overflow-hidden rounded-[14px] pt-9"
    >
      <nav className="pallet-sidebar-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
        <button
          type="button"
          className={cn(
            "group text-sidebar-foreground flex h-8 w-full items-center gap-2 rounded-full px-2.5 text-left text-[13px] outline-none",
            "bg-background/30 hover:bg-background/45 focus-visible:ring-primary/55 focus-visible:ring-2 focus-visible:ring-inset",
            "transition-[background-color,box-shadow] duration-150",
          )}
          onClick={() => openQuickConnect()}
          title="Connect to Server (⌘K)"
        >
          <Plug className="text-muted-foreground group-hover:text-sidebar-foreground size-4 shrink-0 transition-colors duration-150" />
          <span className="truncate font-medium">Connect to Server</span>
          <kbd
            aria-hidden="true"
            className="text-muted-foreground/75 ml-auto font-mono text-[10px] leading-none"
          >
            ⌘K
          </kbd>
        </button>

        <section aria-labelledby="sidebar-devices-title">
          <div id="sidebar-devices-title">
            <SectionTitle>Devices</SectionTitle>
          </div>
          <div className="space-y-0.5">
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
        </section>

        {kf && (
          <section aria-labelledby="sidebar-folders-title">
            <div id="sidebar-folders-title">
              <SectionTitle>Folders</SectionTitle>
            </div>
            <div className="space-y-0.5">
              <SidebarItem
                icon={Home}
                label="Home"
                path={kf.home}
                {...common}
              />
              <SidebarItem
                icon={Dock}
                label="Desktop"
                path={kf.desktop}
                {...common}
              />
              <SidebarItem
                icon={File}
                label="Documents"
                path={kf.documents}
                {...common}
              />
              <SidebarItem
                icon={CircleArrowDown}
                label="Downloads"
                path={kf.downloads}
                {...common}
              />
              <SidebarItem
                icon={Film}
                label="Movies"
                path={kf.movies}
                {...common}
              />
              <SidebarItem
                icon={Music}
                label="Music"
                path={kf.music}
                {...common}
              />
              <SidebarItem
                icon={Image}
                label="Pictures"
                path={kf.pictures}
                {...common}
              />
            </div>
          </section>
        )}

        {app.favorites.length > 0 && (
          <section
            aria-labelledby="sidebar-favorites-title"
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropIndex(null);
            }}
          >
            <div id="sidebar-favorites-title">
              <SectionTitle>Favorites</SectionTitle>
            </div>
            <div className="space-y-0.5">
              {app.favorites.map((favorite, i) => (
                <FavoriteItem
                  key={favorite.id}
                  favorite={favorite}
                  onDragStart={() => (dragIndex.current = i)}
                  onDragOver={(e) => {
                    if (dragIndex.current != null) {
                      e.preventDefault();
                      setDropIndex(i);
                    }
                  }}
                  onDrop={() => commitDrop(i)}
                  onDragEnd={() => {
                    dragIndex.current = null;
                    setDropIndex(null);
                  }}
                  dragTarget={dropIndex === i}
                />
              ))}
            </div>
          </section>
        )}
      </nav>
    </aside>
  );
}
