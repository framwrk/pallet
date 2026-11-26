import type { Appearance, Preferences, RowDensity, TransferPanelSide } from "@shared/prefs/prefs.types";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Cog,
  Contrast,
  FileBraces,
  Info,
  Keyboard,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings2,
  Star,
  Trash2,
  XIcon,
} from "lucide-react";
import type { CommandId, KeybindingCommand } from "@shared/keybindings/keybinding.types";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { KEYBINDING_COMMANDS, KEYBINDING_GROUPS, LOCKED_KEYBINDINGS } from "@shared/keybindings/keybinding.constants";
import {
  MAX_CONCURRENCY,
  MAX_EDITOR_POLL_INTERVAL_MS,
  MAX_EDITOR_SAVE_DEBOUNCE_MS,
  MAX_EDITOR_UPLOAD_TIMEOUT_MS,
  MAX_KEEPALIVE_SECONDS,
  MAX_TRANSFER_RETRIES,
  MAX_TRANSFER_TIMEOUT_SECONDS,
  MIN_CONCURRENCY,
  MIN_EDITOR_POLL_INTERVAL_MS,
  MIN_EDITOR_SAVE_DEBOUNCE_MS,
  MIN_EDITOR_UPLOAD_TIMEOUT_MS,
  MIN_KEEPALIVE_SECONDS,
  MIN_TRANSFER_RETRIES,
  MIN_TRANSFER_TIMEOUT_SECONDS,
  PREVIEW_SIZE_OPTIONS,
  SPEED_STATS_WINDOW_OPTIONS,
} from "@shared/prefs/prefs.constants";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import type { SortDir, SortKey } from "@shared/fs/fs.types";
import type { UpdateDownloadState, UpdateInfo } from "@shared/update/update.types";
import { displayParts, eventToKey, findConflict, validateKey } from "@shared/keybindings/keybinding.utils";
import { formatBytes, formatModified } from "@renderer/lib/format.utils";
import { pushToast, setAddingFavorite, setEditingFavorite, setSettingsOpen, useAppState } from "@/store/pane.store";
import { removeFavorite, reorderFavorites, requestFavoriteConnection } from "@/store/favorite.store";
import { setKeybindingRecording, useKeybindings } from "@/store/keybinding.store";
import type { AppInfo } from "@shared/app/app.types";
import { Button } from "@renderer/components/ui/button";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { Favorite } from "@shared/favorite/favorite.types";
import { FavoriteDialog } from "@renderer/components/connection/FavoriteDialog";
import { Input } from "@renderer/components/ui/input";
import { LABEL_COLOR_CLASSES } from "@shared/favorite/favorite.constants";
import type { LucideIcon } from "lucide-react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Switch } from "@renderer/components/ui/switch";
import appIcon from "@renderer/assets/pallet-icon.png";
import { cn } from "@renderer/lib/utils";

type TabId = "general" | "appearance" | "favorites" | "transfers" | "keybindings" | "updates" | "advanced" | "about";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Contrast },
  { id: "favorites", label: "Favorites", icon: Star },
  { id: "transfers", label: "Transfers", icon: ArrowUpDown },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "advanced", label: "Advanced", icon: Cog },
  { id: "about", label: "About", icon: Info },
];

const SETTINGS_NAV_GROUPS: { heading: string | null; tabs: TabId[] }[] = [
  { heading: null, tabs: ["general", "appearance", "favorites", "transfers", "keybindings"] },
  { heading: "Maintenance", tabs: ["updates", "advanced"] },
  { heading: null, tabs: ["about"] },
];

function navRow(active: boolean): string {
  return cn(
    "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset [&>svg]:text-sidebar-icon [&>svg]:shrink-0",
    active
      ? "bg-sidebar-row-selected text-sidebar-foreground [&>svg]:text-sidebar-foreground"
      : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground hover:[&>svg]:text-sidebar-foreground",
  );
}

const REPO_URL = "https://github.com/framwrk/pallet";
const RELEASES_URL = `${REPO_URL}/releases`;
const ISSUES_URL = `${REPO_URL}/issues`;
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
const AUTHOR_URL = "https://github.com/framwrk";

type UpdateCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; info: UpdateInfo }
  | { status: "failed" };

const APPEARANCES: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const TRANSFER_PANEL_SIDES: Record<TransferPanelSide, string> = {
  left: "Bottom left",
  right: "Bottom right",
};

const ROW_DENSITIES: Record<RowDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
};

const SORT_OPTIONS: Record<string, string> = {
  "name:asc": "Name, A–Z",
  "name:desc": "Name, Z–A",
  "mtime:desc": "Date Modified, Newest First",
  "mtime:asc": "Date Modified, Oldest First",
  "size:asc": "Size, Smallest First",
  "size:desc": "Size, Largest First",
};

const PREVIEW_LABELS = ["256 KB", "1 MB", "4 MB", "8 MB"];
const PREVIEW_OPTIONS: Record<string, string> = Object.fromEntries(
  PREVIEW_SIZE_OPTIONS.map((bytes, index) => [String(bytes), PREVIEW_LABELS[index]]),
);

const SPEED_WINDOW_OPTIONS: Record<string, string> = Object.fromEntries(
  SPEED_STATS_WINDOW_OPTIONS.map((seconds) => [String(seconds), `Last ${seconds} seconds`]),
);

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-foreground min-h-7 px-3 text-base font-semibold sm:px-4">{title}</h2>
      <div className="border-border/60 bg-card/40 text-foreground [&>*+*]:border-border/50 overflow-hidden rounded-xl border shadow-xs/5 [&>*+*]:border-t">
        {children}
      </div>
    </section>
  );
}

function Group({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div>{children}</div>;
}

/**
 * T3's `SettingsRow`: the title leads with its one-line description below,
 * the control trails, and at the modal's fixed column width both sit on one
 * line with the text column capped to a comfortable measure. `indent` marks
 * a row as subordinate to the one above it, which also gets the hairline
 * that separates them. `htmlFor` turns the label into a real control label;
 * the switches and select are buttons underneath, so a wrapping <label>
 * would not associate.
 */
function Row({
  label,
  description,
  descriptionId,
  indent,
  separated,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  descriptionId?: string;
  indent?: boolean;
  separated?: boolean;
  htmlFor?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const id = descriptionId ?? (htmlFor ? `${htmlFor}-desc` : undefined);
  return (
    <div className={cn("flex items-center gap-8 px-3 py-3 sm:px-4", (indent || separated) && "border-t", indent && "pl-7")}>
      <div className="min-w-0 flex-1 space-y-1">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="text-foreground block text-sm font-medium"
          >
            {label}
          </label>
        ) : (
          <span className="text-foreground block text-sm font-medium">{label}</span>
        )}
        {description && (
          <p
            id={id}
            className="text-muted-foreground max-w-2xl text-xs leading-normal text-balance"
          >
            {description}
          </p>
        )}
      </div>
      {children != null && <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">{children}</div>}
    </div>
  );
}

function LinkRow({
  label,
  description,
  href,
  separated,
}: {
  label: string;
  description?: string;
  href: string;
  separated?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        "hover:bg-foreground/4 focus-visible:outline-ring flex w-full items-center justify-between gap-8 px-3 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-4",
        separated && "border-t",
      )}
      onClick={() => void window.pallet.app.openExternal(href)}
    >
      <span className="min-w-0 flex-1 space-y-1">
        <span className="text-foreground block text-sm font-medium">{label}</span>
        {description && <span className="text-muted-foreground block text-xs leading-normal">{description}</span>}
      </span>
      <ArrowUpRight
        className="text-muted-foreground size-3.5 shrink-0 self-center"
        strokeWidth={2}
      />
    </button>
  );
}

function Stepper({
  onStep,
  canDecrement,
  canIncrement,
  subject,
}: {
  onStep: (delta: number) => void;
  canDecrement: boolean;
  canIncrement: boolean;
  subject: string;
}): React.JSX.Element {
  const half =
    "flex flex-1 w-4 items-center justify-center text-muted-foreground hover:text-foreground active:bg-foreground/10 disabled:pointer-events-none disabled:opacity-40";
  return (
    <div className="flex h-6 flex-col overflow-hidden rounded-sm border">
      <button
        type="button"
        className={half}
        disabled={!canIncrement}
        onClick={() => onStep(1)}
        aria-label={`Increase ${subject}`}
      >
        <ChevronUp
          className="size-2.5"
          strokeWidth={2.5}
        />
      </button>
      <div className="bg-border h-px" />
      <button
        type="button"
        className={half}
        disabled={!canDecrement}
        onClick={() => onStep(-1)}
        aria-label={`Decrease ${subject}`}
      >
        <ChevronDown
          className="size-2.5"
          strokeWidth={2.5}
        />
      </button>
    </div>
  );
}

function NumberField({
  id,
  value,
  min,
  max,
  step = 1,
  subject,
  describedBy,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  subject: string;
  describedBy?: string;
  onChange: (value: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(String(value));
  }

  function clamp(next: number): number {
    return Math.min(max, Math.max(min, next));
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        id={id}
        inputMode="numeric"
        role="spinbutton"
        aria-describedby={describedBy}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        className="h-6 w-16 rounded-sm px-2 text-center text-[13px] tabular-nums"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = Number.parseInt(e.target.value, 10);
          if (Number.isInteger(parsed) && parsed >= min && parsed <= max) onChange(parsed);
        }}
        onBlur={() => setText(String(value))}
      />
      <Stepper
        subject={subject}
        onStep={(delta) => onChange(clamp(value + delta * step))}
        canDecrement={value > min}
        canIncrement={value < max}
      />
    </div>
  );
}

function sortValue(prefs: Preferences): string {
  return `${prefs.defaultSortKey}:${prefs.defaultSortDir}`;
}

function GeneralPanel({ prefs, save }: { prefs: Preferences; save: (patch: Partial<Preferences>) => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <Section title="File list">
        <Row
          label="Show hidden files"
          description="Also toggled with ⇧⌘. in the file browser."
          htmlFor="pref-show-hidden"
        >
          <Switch
            id="pref-show-hidden"
            aria-describedby="pref-show-hidden-desc"
            checked={prefs.showHidden}
            onCheckedChange={(checked) => save({ showHidden: checked })}
          />
        </Row>
      </Section>
      <Section title="Sorting">
        <Row
          label="Sort files by"
          description="A changed sort applies to both panes now."
          htmlFor="pref-sort"
        >
          <Select
            items={SORT_OPTIONS}
            value={sortValue(prefs)}
            onValueChange={(value) => {
              if (!value) return;
              const [key, dir] = value.split(":");
              save({ defaultSortKey: key as SortKey, defaultSortDir: dir as SortDir });
            }}
          >
            <SelectTrigger
              id="pref-sort"
              aria-describedby="pref-sort-desc"
              className="w-48 rounded-sm py-0 pr-1.5 text-[13px] data-[size=default]:h-6 [&>svg]:hidden"
            >
              <SelectValue />
              <span className="text-muted-foreground flex">
                <ChevronsUpDown
                  className="size-3.5"
                  strokeWidth={2}
                />
              </span>
            </SelectTrigger>
            <SelectContent
              align="start"
              alignItemWithTrigger={false}
              className="min-w-0 p-1"
            >
              {Object.entries(SORT_OPTIONS).map(([value, label]) => (
                <SelectItem
                  key={value}
                  value={value}
                  className="py-0.5 text-[13px]"
                >
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="Folders first"
          description="Keep folders above files regardless of the sort."
          separated
          htmlFor="pref-folders-first"
        >
          <Switch
            id="pref-folders-first"
            aria-describedby="pref-folders-first-desc"
            checked={prefs.foldersFirst}
            onCheckedChange={(checked) => save({ foldersFirst: checked })}
          />
        </Row>
      </Section>
      <Section title="Folder sizes">
        <Row
          label="Calculate folder sizes"
          description="Total each folder’s contents instead of showing “--”. Local folders only unless you include remote ones."
          htmlFor="pref-folder-sizes"
        >
          <Switch
            id="pref-folder-sizes"
            aria-describedby="pref-folder-sizes-desc"
            checked={prefs.calculateFolderSizes}
            onCheckedChange={(checked) => save({ calculateFolderSizes: checked })}
          />
        </Row>
        {prefs.calculateFolderSizes && (
          <Row
            label="Include remote folders"
            description="Sizing a remote tree over SSH is far slower than reading it off disk."
            indent
            htmlFor="pref-remote-folder-sizes"
          >
            <Switch
              id="pref-remote-folder-sizes"
              aria-describedby="pref-remote-folder-sizes-desc"
              checked={prefs.calculateRemoteFolderSizes}
              onCheckedChange={(checked) => save({ calculateRemoteFolderSizes: checked })}
            />
          </Row>
        )}
      </Section>
      <Section title="Previews">
        <Row
          label="Preview files up to"
          description="Larger files still show their metadata in the inspector; only the inline text or image body is skipped."
          htmlFor="pref-preview-max"
        >
          <Select
            items={PREVIEW_OPTIONS}
            value={String(prefs.previewMaxBytes)}
            onValueChange={(value) => {
              if (value) save({ previewMaxBytes: Number(value) });
            }}
          >
            <SelectTrigger
              id="pref-preview-max"
              aria-describedby="pref-preview-max-desc"
              className="w-28 rounded-sm py-0 pr-1.5 text-[13px] data-[size=default]:h-6 [&>svg]:hidden"
            >
              <SelectValue />
              <span className="text-muted-foreground flex">
                <ChevronsUpDown
                  className="size-3.5"
                  strokeWidth={2}
                />
              </span>
            </SelectTrigger>
            <SelectContent
              align="start"
              alignItemWithTrigger={false}
              className="min-w-0 p-1"
            >
              {Object.entries(PREVIEW_OPTIONS).map(([value, label]) => (
                <SelectItem
                  key={value}
                  value={value}
                  className="py-0.5 text-[13px]"
                >
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Section>
    </div>
  );
}

function AppearancePanel({
  prefs,
  save,
}: {
  prefs: Preferences;
  save: (patch: Partial<Preferences>) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Interface">
        <Group>
          <Row
            label="Appearance"
            description="System follows the macOS appearance setting."
            htmlFor="pref-appearance"
          >
            <Select
              items={APPEARANCES}
              value={prefs.appearance}
              onValueChange={(value) => save({ appearance: value as Appearance })}
            >
              <SelectTrigger
                id="pref-appearance"
                aria-describedby="pref-appearance-desc"
                className="w-32 rounded-sm py-0 pr-1.5 text-[13px] data-[size=default]:h-6 [&>svg]:hidden"
              >
                <SelectValue />
                <span className="text-muted-foreground flex">
                  <ChevronsUpDown
                    className="size-3.5"
                    strokeWidth={2}
                  />
                </span>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className="min-w-0 p-1"
              >
                {Object.entries(APPEARANCES).map(([value, label]) => (
                  <SelectItem
                    key={value}
                    value={value}
                    className="py-0.5 text-[13px]"
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          <Row
            label="Row density"
            description="Compact matches Finder’s default density; comfortable adds breathing room to every row."
            separated
            htmlFor="pref-row-density"
          >
            <Select
              items={ROW_DENSITIES}
              value={prefs.rowDensity}
              onValueChange={(value) => save({ rowDensity: value as RowDensity })}
            >
              <SelectTrigger
                id="pref-row-density"
                aria-describedby="pref-row-density-desc"
                className="w-32 rounded-sm py-0 pr-1.5 text-[13px] data-[size=default]:h-6 [&>svg]:hidden"
              >
                <SelectValue />
                <span className="text-muted-foreground flex">
                  <ChevronsUpDown
                    className="size-3.5"
                    strokeWidth={2}
                  />
                </span>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className="min-w-0 p-1"
              >
                {Object.entries(ROW_DENSITIES).map(([value, label]) => (
                  <SelectItem
                    key={value}
                    value={value}
                    className="py-0.5 text-[13px]"
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        </Group>
      </Section>
    </div>
  );
}

const PROTOCOL_LABELS: Record<Favorite["protocol"], string> = {
  sftp: "SFTP",
  ftp: "FTP",
  ftps: "FTPS",
  "ftps-implicit": "FTPS (Implicit)",
  s3: "S3",
  smb: "SMB",
};

function favoriteEndpoint(favorite: Favorite): string {
  if (favorite.protocol === "s3") {
    const bucket = favorite.s3Bucket ?? favorite.host;
    return favorite.s3Region ? `${bucket} · ${favorite.s3Region}` : bucket;
  }
  if (favorite.protocol === "smb") return `${favorite.username}@${favorite.host}/${favorite.smbShare ?? ""}`;
  return `${favorite.username}@${favorite.host}:${favorite.port}`;
}

function FavoriteRow({
  favorite,
  index,
  total,
  connecting,
  confirming,
  onConnect,
  onEdit,
  onMove,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  favorite: Favorite;
  index: number;
  total: number;
  connecting: boolean;
  confirming: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onMove: (delta: number) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
      <Server className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate text-sm font-medium">{favorite.name}</span>
          {favorite.colorLabel !== "none" && (
            <span
              role="img"
              aria-label={`Label ${favorite.colorLabel}`}
              className={cn(
                "size-2.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.18)]",
                LABEL_COLOR_CLASSES[favorite.colorLabel],
              )}
            />
          )}
        </div>
        {confirming ? (
          <p className="text-destructive text-xs leading-normal">
            Delete this favorite{favorite.secretStored ? " and its saved credentials" : ""}? This can’t be undone.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              <span className="bg-foreground/[0.06] shrink-0 rounded px-1 py-px text-[10px] font-medium">
                {PROTOCOL_LABELS[favorite.protocol]}
              </span>
              <span className="truncate font-mono text-[11px]">{favoriteEndpoint(favorite)}</span>
            </p>
            {favorite.lastUsedAt !== undefined && (
              <p className="text-muted-foreground text-[11px]">Last used {formatModified(favorite.lastUsedAt)}</p>
            )}
          </>
        )}
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={onCancelDelete}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            variant="destructive"
            onClick={onDelete}
          >
            Delete
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={connecting}
            aria-label={`Connect to ${favorite.name}`}
            onClick={onConnect}
          >
            {connecting && <LoaderCircle className="animate-spin" />}
            {connecting ? "Connecting…" : "Connect"}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Edit ${favorite.name}`}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Move ${favorite.name} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Move ${favorite.name} down`}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Delete ${favorite.name}`}
            onClick={onAskDelete}
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  );
}

function FavoritesPanel(): React.JSX.Element {
  const { favorites, connecting } = useAppState();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  function addFavorite(): void {
    setAddingFavorite(true);
  }

  function connectFavorite(favorite: Favorite): void {
    setSettingsOpen(false);
    void requestFavoriteConnection(favorite.id);
  }

  function editFavorite(favorite: Favorite): void {
    setEditingFavorite(favorite);
  }

  function moveFavorite(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= favorites.length) return;
    const ids = favorites.map((f) => f.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved);
    void reorderFavorites(ids);
  }

  function deleteFavorite(favorite: Favorite): void {
    void removeFavorite(favorite.id).then(() => setConfirmingId(null));
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Saved connections">
        {favorites.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
            <Star
              className="text-muted-foreground size-6"
              strokeWidth={1.5}
            />
            <p className="text-foreground mt-1 text-sm font-medium">No saved connections</p>
            <p className="text-muted-foreground max-w-sm text-xs leading-normal text-balance">
              Add a server here and Pallet tests the connection before saving it.
            </p>
            <Button
              size="xs"
              variant="outline"
              className="mt-2"
              onClick={addFavorite}
            >
              <Plus />
              Add Favorite…
            </Button>
          </div>
        ) : (
          <>
            {favorites.map((favorite, index) => (
              <FavoriteRow
                key={favorite.id}
                favorite={favorite}
                index={index}
                total={favorites.length}
                connecting={connecting?.favoriteId === favorite.id}
                confirming={confirmingId === favorite.id}
                onConnect={() => connectFavorite(favorite)}
                onEdit={() => editFavorite(favorite)}
                onMove={(delta) => moveFavorite(index, delta)}
                onAskDelete={() => setConfirmingId(favorite.id)}
                onCancelDelete={() => setConfirmingId(null)}
                onDelete={() => deleteFavorite(favorite)}
              />
            ))}
            <button
              type="button"
              className="text-primary hover:bg-foreground/4 focus-visible:outline-ring flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-4"
              onClick={addFavorite}
            >
              <Plus className="size-4" />
              Add Favorite…
            </button>
          </>
        )}
      </Section>
    </div>
  );
}

function TransfersPanel({
  prefs,
  save,
  concurrencyText,
  onConcurrencyChange,
  setConcurrencyText,
  stepConcurrency,
}: {
  prefs: Preferences;
  save: (patch: Partial<Preferences>) => void;
  concurrencyText: string;
  onConcurrencyChange: (value: string) => void;
  setConcurrencyText: (value: string) => void;
  stepConcurrency: (delta: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Connections">
        <Group>
          <Row
            label="Default concurrency"
            description="The number of parallel transfer channels; seeds the field in the connection dialog."
            htmlFor="pref-concurrency"
          >
            <div className="flex items-center gap-1.5">
              <Input
                id="pref-concurrency"
                inputMode="numeric"
                role="spinbutton"
                aria-describedby="pref-concurrency-desc"
                aria-valuemin={MIN_CONCURRENCY}
                aria-valuemax={MAX_CONCURRENCY}
                aria-valuenow={prefs.defaultConcurrency}
                className="h-6 w-12 rounded-sm px-2 text-center text-[13px] tabular-nums"
                value={concurrencyText}
                onChange={(e) => onConcurrencyChange(e.target.value)}
                onBlur={() => setConcurrencyText(String(prefs.defaultConcurrency))}
              />
              <Stepper
                subject="default concurrency"
                onStep={stepConcurrency}
                canDecrement={prefs.defaultConcurrency > MIN_CONCURRENCY}
                canIncrement={prefs.defaultConcurrency < MAX_CONCURRENCY}
              />
            </div>
          </Row>
          <Row
            label="Default keepalive"
            description="Keeps idle sessions alive; 0 disables it. Seeds the connection dialog's field."
            separated
            htmlFor="pref-keepalive"
          >
            <NumberField
              id="pref-keepalive"
              value={prefs.defaultKeepaliveSeconds}
              min={MIN_KEEPALIVE_SECONDS}
              max={MAX_KEEPALIVE_SECONDS}
              step={5}
              subject="default keepalive"
              describedBy="pref-keepalive-desc"
              onChange={(value) => save({ defaultKeepaliveSeconds: value })}
            />
          </Row>
          <Row
            label="Reconnect automatically"
            description="Retries dropped sessions with backoff. Off leaves a dropped pane disconnected until you reconnect."
            separated
            htmlFor="pref-auto-reconnect"
          >
            <Switch
              id="pref-auto-reconnect"
              aria-describedby="pref-auto-reconnect-desc"
              checked={prefs.autoReconnect}
              onCheckedChange={(checked) => save({ autoReconnect: checked })}
            />
          </Row>
        </Group>
      </Section>
      <Section title="Reliability">
        <Group>
          <Row
            label="Verify copied files with SHA-256"
            description="Rereads both source and staged copy before replacement. Adds disk and network traffic and requires read permission. Applies to new transfers."
            htmlFor="pref-verify-copied-files"
          >
            <Switch
              id="pref-verify-copied-files"
              aria-describedby="pref-verify-copied-files-desc"
              checked={prefs.verifyCopiedFiles}
              onCheckedChange={(checked) => save({ verifyCopiedFiles: checked })}
            />
          </Row>
          <Row
            label="Stall timeout"
            separated
            description="A transfer with no progress for this long is abandoned and retried."
            htmlFor="pref-transfer-timeout"
          >
            <div className="flex items-center gap-1.5">
              <NumberField
                id="pref-transfer-timeout"
                value={prefs.transferTimeoutSeconds}
                min={MIN_TRANSFER_TIMEOUT_SECONDS}
                max={MAX_TRANSFER_TIMEOUT_SECONDS}
                step={5}
                subject="stall timeout"
                describedBy="pref-transfer-timeout-desc"
                onChange={(value) => save({ transferTimeoutSeconds: value })}
              />
              <span className="text-muted-foreground text-[11px]">seconds</span>
            </div>
          </Row>
          <Row
            label="Retries per file"
            description="How many times a stalled or failed transfer is retried when the channel is at fault."
            separated
            htmlFor="pref-transfer-retries"
          >
            <NumberField
              id="pref-transfer-retries"
              value={prefs.transferMaxRetries}
              min={MIN_TRANSFER_RETRIES}
              max={MAX_TRANSFER_RETRIES}
              subject="retries per file"
              describedBy="pref-transfer-retries-desc"
              onChange={(value) => save({ transferMaxRetries: value })}
            />
          </Row>
        </Group>
      </Section>
      <Section title="Speed statistics">
        <Group>
          <Row
            label="Speed window"
            description="Sets the trailing window for the average and median speeds in the transfer panel."
            htmlFor="pref-speed-window"
          >
            <Select
              items={SPEED_WINDOW_OPTIONS}
              value={String(prefs.speedStatsWindowSeconds)}
              onValueChange={(value) => {
                if (value) save({ speedStatsWindowSeconds: Number(value) });
              }}
            >
              <SelectTrigger
                id="pref-speed-window"
                aria-describedby="pref-speed-window-desc"
                className="w-36 rounded-sm py-0 pr-1.5 text-[13px] data-[size=default]:h-6 [&>svg]:hidden"
              >
                <SelectValue />
                <span className="text-muted-foreground flex">
                  <ChevronsUpDown
                    className="size-3.5"
                    strokeWidth={2}
                  />
                </span>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className="min-w-0 p-1"
              >
                {Object.entries(SPEED_WINDOW_OPTIONS).map(([value, label]) => (
                  <SelectItem
                    key={value}
                    value={value}
                    className="py-0.5 text-[13px]"
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        </Group>
      </Section>
      <Section title="Transfer panel">
        <Group>
          <Row
            label="Position"
            description="Which bottom corner of the workspace the transfer panel floats in."
            htmlFor="pref-transfer-panel-side"
          >
            <Select
              items={TRANSFER_PANEL_SIDES}
              value={prefs.transferPanelSide}
              onValueChange={(value) => save({ transferPanelSide: value as TransferPanelSide })}
            >
              <SelectTrigger
                id="pref-transfer-panel-side"
                aria-describedby="pref-transfer-panel-side-desc"
                className="w-36 rounded-sm py-0 pr-1.5 text-[13px] data-[size=default]:h-6 [&>svg]:hidden"
              >
                <SelectValue />
                <span className="text-muted-foreground flex">
                  <ChevronsUpDown
                    className="size-3.5"
                    strokeWidth={2}
                  />
                </span>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className="min-w-0 p-1"
              >
                {Object.entries(TRANSFER_PANEL_SIDES).map(([value, label]) => (
                  <SelectItem
                    key={value}
                    value={value}
                    className="py-0.5 text-[13px]"
                  >
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
        </Group>
      </Section>
    </div>
  );
}

function UpdatesPanel({ prefs, save }: { prefs: Preferences; save: (patch: Partial<Preferences>) => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Update checks">
        <Group>
          <Row
            label="Check for updates automatically"
            description="Pallet checks GitHub Releases on launch and once a day."
            htmlFor="pref-auto-update"
          >
            <Switch
              id="pref-auto-update"
              aria-describedby="pref-auto-update-desc"
              checked={prefs.automaticallyCheckForUpdates}
              onCheckedChange={(checked) => save({ automaticallyCheckForUpdates: checked })}
            />
          </Row>
          <Row
            label="Include prerelease versions"
            description="Prereleases are releases GitHub flags as prerelease; version numbers stay MAJOR.MINOR.PATCH."
            separated
            htmlFor="pref-prerelease"
          >
            <Switch
              id="pref-prerelease"
              aria-describedby="pref-prerelease-desc"
              checked={prefs.receivePrereleaseUpdates}
              onCheckedChange={(checked) => save({ receivePrereleaseUpdates: checked })}
            />
          </Row>
        </Group>
      </Section>
    </div>
  );
}

function AdvancedPanel({
  prefs,
  save,
  dbPath,
  dbPathFailed,
  copied,
  copyDbPath,
}: {
  prefs: Preferences;
  save: (patch: Partial<Preferences>) => void;
  dbPath: string | null;
  dbPathFailed: boolean;
  copied: boolean;
  copyDbPath: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <Section title="External editor">
        <Group>
          <Row
            label="Upload delay"
            description="Applies to files opened with an external editor; lets the writer settle before Pallet uploads."
            htmlFor="pref-editor-debounce"
          >
            <div className="flex items-center gap-1.5">
              <NumberField
                id="pref-editor-debounce"
                value={prefs.editorSaveDebounceMs}
                min={MIN_EDITOR_SAVE_DEBOUNCE_MS}
                max={MAX_EDITOR_SAVE_DEBOUNCE_MS}
                step={100}
                subject="upload delay"
                describedBy="pref-editor-debounce-desc"
                onChange={(value) => save({ editorSaveDebounceMs: value })}
              />
              <span className="text-muted-foreground text-[11px]">ms</span>
            </div>
          </Row>
          <Row
            label="Change polling"
            description="How often Pallet checks external-editor files for changes."
            separated
            htmlFor="pref-editor-poll"
          >
            <div className="flex items-center gap-1.5">
              <NumberField
                id="pref-editor-poll"
                value={prefs.editorPollIntervalMs}
                min={MIN_EDITOR_POLL_INTERVAL_MS}
                max={MAX_EDITOR_POLL_INTERVAL_MS}
                step={100}
                subject="change polling"
                describedBy="pref-editor-poll-desc"
                onChange={(value) => save({ editorPollIntervalMs: value })}
              />
              <span className="text-muted-foreground text-[11px]">ms</span>
            </div>
          </Row>
          <Row
            label="Upload timeout"
            description="How long an external-editor upload may run before it is abandoned."
            separated
            htmlFor="pref-editor-timeout"
          >
            <div className="flex items-center gap-1.5">
              <NumberField
                id="pref-editor-timeout"
                value={prefs.editorUploadTimeoutMs}
                min={MIN_EDITOR_UPLOAD_TIMEOUT_MS}
                max={MAX_EDITOR_UPLOAD_TIMEOUT_MS}
                step={5000}
                subject="upload timeout"
                describedBy="pref-editor-timeout-desc"
                onChange={(value) => save({ editorUploadTimeoutMs: value })}
              />
              <span className="text-muted-foreground text-[11px]">ms</span>
            </div>
          </Row>
        </Group>
      </Section>
      <Section title="Storage">
        <Group>
          <Row
            label="Database path"
            description="Favorites, known host keys, and a diagnostic transfer history log live in this SQLite file — any SQLite client can open it. Quit Pallet before writing to it."
          >
            <div className="flex min-w-0 gap-2">
              {/* CSS truncation keeps the full text in the accessibility tree;
                  the title is only the visual tooltip. */}
              <span
                title={dbPath ?? undefined}
                className="text-muted-foreground max-w-40 min-w-0 truncate font-mono text-[11px] select-text"
              >
                {dbPath ?? (dbPathFailed ? "Unavailable" : "")}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={dbPath === null}
                onClick={copyDbPath}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={dbPath === null}
                onClick={() => {
                  if (dbPath !== null) void window.pallet.fs.reveal(dbPath);
                }}
              >
                Reveal
              </Button>
            </div>
          </Row>
        </Group>
      </Section>
    </div>
  );
}

function AboutPanel({
  appInfo,
  updateNote,
  updateAction,
  updateCheck,
  checkNow,
  startUpdate,
  updateBusy,
  copiedInfo,
  copyVersionInfo,
}: {
  appInfo: AppInfo | null;
  updateNote: string;
  updateAction: string;
  updateCheck: UpdateCheck;
  checkNow: () => Promise<void>;
  startUpdate: (info: UpdateInfo) => void;
  updateBusy: boolean;
  copiedInfo: boolean;
  copyVersionInfo: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-1.5 pb-1 text-center">
        <img
          src={appIcon}
          alt=""
          className="size-16 rounded-[18px] shadow-sm"
        />
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[17px] font-semibold">Pallet</span>
          {appInfo && <span className="text-muted-foreground text-[11px] tabular-nums">{appInfo.version}</span>}
        </div>
        <p className="text-muted-foreground max-w-xs text-[11px] leading-snug">
          A free and open-source macOS SFTP, FTP, and FTPS file manager.
        </p>
      </div>

      <Section title="Links">
        <Group>
          <LinkRow
            label="GitHub Repository"
            description="The source code and its history."
            href={REPO_URL}
          />
          <LinkRow
            label="Release Notes"
            description="What’s new in every version."
            href={RELEASES_URL}
            separated
          />
          <LinkRow
            label="Report an Issue…"
            description="File bugs and feature requests."
            href={ISSUES_URL}
            separated
          />
        </Group>
      </Section>

      <Section title="Update check">
        <Group>
          <Row
            label="Check for updates"
            description={updateNote}
            descriptionId="note-update-check"
          >
            <Button
              size="xs"
              variant="outline"
              aria-describedby="note-update-check"
              disabled={updateCheck.status === "checking" || updateBusy}
              onClick={() => {
                if (updateCheck.status !== "available") {
                  void checkNow();
                } else if (updateCheck.info.dmgUrl === null) {
                  void window.pallet.app.openExternal(updateCheck.info.url);
                } else {
                  startUpdate(updateCheck.info);
                }
              }}
            >
              {updateAction}
            </Button>
          </Row>
        </Group>
      </Section>

      <Section title="Privacy">
        <Group>
          <Row
            label="Data collection"
            description="Pallet has no accounts and collects no telemetry. The only outbound request is the GitHub Releases update check."
          >
            <span className="text-muted-foreground text-[12px]">None</span>
          </Row>
        </Group>
      </Section>

      <Section title="Diagnostics">
        <Group>
          <Row
            label="Log file"
            description="Reveal the app log; it is scrubbed of credentials."
            descriptionId="note-log-file-desc"
          >
            <Button
              size="xs"
              variant="outline"
              aria-describedby="note-log-file-desc"
              onClick={() => void window.pallet.app.revealLog()}
            >
              Reveal in Finder
            </Button>
          </Row>
          <Row
            label="Version info"
            description="Copies Pallet, Electron, macOS, and architecture for a bug report."
            separated
            descriptionId="note-version-info-desc"
          >
            <Button
              size="xs"
              variant="outline"
              aria-describedby="note-version-info-desc"
              disabled={appInfo === null}
              onClick={copyVersionInfo}
            >
              {copiedInfo ? "Copied" : "Copy"}
            </Button>
          </Row>
        </Group>
      </Section>

      <Section title="License">
        <Group>
          <Row
            label="License"
            description="Pallet is free and open source under the Apache License 2.0."
          >
            <Button
              size="xs"
              variant="outline"
              onClick={() => void window.pallet.app.openExternal(LICENSE_URL)}
            >
              Apache 2.0
            </Button>
          </Row>
          <Row
            label="Copyright"
            description="© 2026 Framwrk."
            separated
          />
          <Row
            label="Built with"
            description="Electron · React · Base UI · ssh2 · basic-ftp"
            separated
          />
          <LinkRow
            label="Framwrk on GitHub"
            description="The developer behind Pallet."
            href={AUTHOR_URL}
            separated
          />
        </Group>
      </Section>
    </div>
  );
}

function scrollRowIntoView(row: HTMLElement | null): void {
  row?.scrollIntoView({ block: "nearest" });
}

const KEY_CHIP =
  "bg-foreground/[0.075] text-foreground/85 inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 font-mono text-[11px] leading-none";

const KEY_GROUP = "inline-flex items-center gap-1";

function KeyChips({ keys }: { keys: string[] }): React.JSX.Element {
  return (
    <>
      {keys.map((key) => (
        <Fragment key={key}>
          {displayParts(key).map((part) => (
            <kbd
              key={part}
              className={KEY_CHIP}
            >
              {part}
            </kbd>
          ))}
        </Fragment>
      ))}
    </>
  );
}

function modifierPreview(event: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (event.metaKey) parts.push("⌘");
  if (event.ctrlKey) parts.push("⌃");
  if (event.altKey) parts.push("⌥");
  if (event.shiftKey) parts.push("⇧");
  return parts.length > 0 ? parts.join("") : null;
}

function KeybindingsPanel(): React.JSX.Element {
  const bindings = useKeybindings();
  const [query, setQuery] = useState("");
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [recorder, setRecorder] = useState<{ commandId: CommandId } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRowRef = useRef<HTMLDivElement | null>(null);
  const recordingActive = recorder !== null;

  const cancelRecorder = useCallback(() => {
    setRecorder(null);
    setPreview(null);
    setError(null);
    setKeybindingRecording(false);
  }, []);

  function startRecorder(commandId: CommandId): void {
    setRecorder({ commandId });
    setPreview(null);
    setError(null);
    setKeybindingRecording(true);
  }

  useEffect(() => {
    if (!recorder) return;
    const { commandId } = recorder;
    const effective = bindings.effective;

    function onKeyDown(event: KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        cancelRecorder();
        return;
      }
      const key = eventToKey(event);
      if (key === null) {
        setPreview(modifierPreview(event));
        return;
      }
      setPreview(null);

      const issue = validateKey(key, { allowEscape: false });
      if (issue !== null) {
        setError(issue.message);
        return;
      }
      const conflict = findConflict(effective, commandId, key);
      if (conflict !== null) {
        const title = KEYBINDING_COMMANDS.find((command) => command.id === conflict)?.title ?? conflict;
        setError(`${displayParts(key).join("")} is already used by ${title}`);
        return;
      }

      if (effective[commandId] === key) {
        cancelRecorder();
        return;
      }
      void window.pallet.keybindings
        .set(commandId, key)
        .then(() => cancelRecorder())
        .catch((err: unknown) => setError((err as Error).message));
    }

    function onPointerDown(event: PointerEvent): void {
      if (recorderRowRef.current?.contains(event.target as Node)) return;
      cancelRecorder();
    }

    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [bindings.effective, cancelRecorder, recorder]);

  useEffect(() => {
    setKeybindingRecording(recordingActive);
    return () => {
      if (recordingActive) setKeybindingRecording(false);
    };
  }, [recordingActive]);

  const term = query.trim().toLowerCase();
  const matches = (command: KeybindingCommand): boolean => {
    if (!term) return true;
    const key = bindings.effective[command.id];
    return (
      command.title.toLowerCase().includes(term) ||
      command.group.toLowerCase().includes(term) ||
      (key !== null && (displayParts(key).join("").toLowerCase().includes(term) || key.toLowerCase().includes(term)))
    );
  };
  const lockedMatches = (title: string, group: string, key: string): boolean => {
    if (!term) return true;
    return (
      title.toLowerCase().includes(term) ||
      group.toLowerCase().includes(term) ||
      displayParts(key).join("").toLowerCase().includes(term) ||
      key.toLowerCase().includes(term)
    );
  };

  const groups = KEYBINDING_GROUPS.map((group) => ({
    group,
    commands: KEYBINDING_COMMANDS.filter((command) => command.group === group && matches(command)),
    locked: LOCKED_KEYBINDINGS.filter(
      (locked) => locked.group === group && lockedMatches(locked.title, locked.group, locked.key),
    ),
  })).filter((entry) => entry.commands.length > 0 || entry.locked.length > 0);

  const customized = Object.keys(bindings.overrides).length > 0;

  function resetAll(): void {
    void window.pallet.keybindings
      .resetAll()
      .then(() => setConfirmResetAll(false))
      .catch((err: unknown) => pushToast((err as Error).message));
  }

  function openFile(): void {
    void window.pallet.keybindings.open().catch((err: unknown) => {
      pushToast(`Couldn’t open keybindings.json: ${(err as Error).message}`);
    });
  }

  function removeShortcut(commandId: CommandId): void {
    void window.pallet.keybindings.set(commandId, null).catch((err: unknown) => pushToast((err as Error).message));
  }

  function errorFor(commandId: CommandId): string | null {
    return recorder?.commandId === commandId ? error : null;
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Keybindings">
        <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search keybindings"
              aria-label="Search keybindings"
              spellCheck={false}
              className="h-7 rounded-sm ps-7 text-[13px]"
            />
          </div>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label="Open keybindings.json"
            title="Open keybindings.json"
            onClick={openFile}
          >
            <FileBraces />
          </Button>
        </div>
      </Section>

      {(bindings.syntaxError !== null || bindings.issues.length > 0) && (
        <div className="border-destructive/30 bg-destructive/5 flex flex-col gap-2 rounded-xl border px-3 py-2.5 sm:px-4">
          <p className="text-destructive text-sm font-medium">keybindings.json has problems</p>
          <div className="text-destructive/90 space-y-1 font-mono text-[11px] leading-normal">
            {bindings.syntaxError !== null && <p>{bindings.syntaxError}</p>}
            {bindings.issues.map((issue, index) => (
              <p key={`${issue.code}-${index}`}>{issue.message}</p>
            ))}
          </div>
          <Button
            size="xs"
            variant="link"
            className="w-fit"
            onClick={openFile}
          >
            Open keybindings.json
          </Button>
        </div>
      )}

      {groups.length === 0 ? (
        <p className="text-muted-foreground px-3 text-sm sm:px-4">No keybindings match “{query.trim()}”.</p>
      ) : (
        groups.map(({ group, commands, locked }) => (
          <Section
            key={group}
            title={group}
          >
            {commands.map((command, rowIndex) => {
              const key = bindings.effective[command.id];
              const modified = Object.prototype.hasOwnProperty.call(bindings.overrides, command.id);
              const recording = recorder?.commandId === command.id;
              const rowError = errorFor(command.id);
              return (
                <div
                  key={command.id}
                  ref={recording ? recorderRowRef : undefined}
                  onBlur={(event) => {
                    if (!recording) return;
                    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                    cancelRecorder();
                  }}
                  className={cn("group/row flex items-center gap-8 px-3 py-3 sm:px-4", rowIndex > 0 && "border-t")}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-foreground truncate text-sm font-medium">{command.title}</span>
                      {modified && (
                        <span
                          aria-hidden="true"
                          title="Modified"
                          className="bg-primary size-1.5 shrink-0 rounded-full"
                        />
                      )}
                    </div>
                    {rowError !== null && (
                      <p
                        aria-live="polite"
                        className="text-destructive text-xs leading-normal"
                      >
                        {rowError}
                      </p>
                    )}
                  </div>
                  <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5">
                    {recording ? (
                      <button
                        type="button"
                        aria-label={`Recording a shortcut for ${command.title}`}
                        className="border-primary/60 bg-primary/10 focus-visible:ring-primary/55 inline-flex h-6 items-center rounded-md border px-1.5 leading-none outline-none focus-visible:ring-2"
                      >
                        <span className="text-muted-foreground font-sans text-[11px]">{preview ?? "Press a shortcut…"}</span>
                      </button>
                    ) : key === null ? (
                      <button
                        type="button"
                        aria-label={`Assign shortcut for ${command.title}`}
                        title="Assign shortcut"
                        onClick={() => startRecorder(command.id)}
                        className="border-border/70 text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground inline-flex h-6 items-center gap-1 rounded-md border border-dashed px-2 text-[11px] font-medium"
                      >
                        <Plus className="size-3" />
                        Assign
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <MenuPrimitive.Root>
                          <MenuPrimitive.Trigger
                            type="button"
                            disabled={recordingActive}
                            aria-label={`More options for ${displayParts(key).join(" ")} in ${command.title}`}
                            className={cn(
                              "text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground flex size-6 items-center justify-center rounded-md",
                              recordingActive
                                ? "pointer-events-none opacity-0"
                                : "opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100",
                            )}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </MenuPrimitive.Trigger>
                          <MenuPrimitive.Portal>
                            <MenuPrimitive.Positioner
                              side="bottom"
                              align="end"
                              sideOffset={4}
                              className="z-50"
                            >
                              <MenuPrimitive.Popup className="bg-popover text-popover-foreground border-border/70 w-44 rounded-[10px] border p-1 shadow-2xl">
                                <MenuPrimitive.Item
                                  onClick={() => removeShortcut(command.id)}
                                  className="text-destructive data-[highlighted]:bg-destructive/10 flex cursor-default items-center rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium outline-none select-none"
                                >
                                  Unassign
                                </MenuPrimitive.Item>
                              </MenuPrimitive.Popup>
                            </MenuPrimitive.Positioner>
                          </MenuPrimitive.Portal>
                        </MenuPrimitive.Root>
                        <button
                          type="button"
                          aria-label={`Shortcut ${displayParts(key).join(" ")} for ${command.title}, press to change`}
                          onClick={() => startRecorder(command.id)}
                          className={cn(
                            KEY_GROUP,
                            "focus-visible:ring-primary/55 -my-1 rounded-md p-1 outline-none focus-visible:ring-2",
                            "hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06]",
                          )}
                        >
                          <KeyChips keys={[key]} />
                        </button>
                      </div>
                    )}
                    {modified && (
                      <button
                        type="button"
                        aria-label="Reset to default"
                        title="Reset to default"
                        onClick={() => {
                          void window.pallet.keybindings
                            .reset(command.id)
                            .catch((err: unknown) => pushToast((err as Error).message));
                        }}
                        className="text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground flex size-6 items-center justify-center rounded"
                      >
                        <RotateCcw className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {locked.map((lockedRow, index) => (
              <div
                key={lockedRow.title}
                className={cn("flex items-center gap-8 px-3 py-3 sm:px-4", commands.length + index > 0 && "border-t")}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-foreground truncate text-sm font-medium">{lockedRow.title}</span>
                </div>
                <div className="flex min-w-0 shrink-0 items-center justify-end gap-1.5">
                  <span className={KEY_GROUP}>
                    <KeyChips keys={[lockedRow.key]} />
                  </span>
                  <span
                    aria-label="Built in; can't be changed"
                    title="Built in; can't be changed"
                    className="text-muted-foreground ms-1 flex size-6 items-center justify-center"
                  >
                    <Lock className="size-3" />
                  </span>
                </div>
              </div>
            ))}
          </Section>
        ))
      )}

      <div className="border-border/60 bg-card/40 rounded-xl border px-3 py-3 shadow-xs/5 sm:px-4">
        {confirmResetAll ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-foreground min-w-0 flex-1 text-sm font-medium">Reset all keybindings to defaults?</p>
            <div className="ms-auto flex shrink-0 items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setConfirmResetAll(false)}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                variant="destructive"
                onClick={resetAll}
              >
                Reset
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-foreground text-sm font-medium">Reset all keybindings</p>
              <p className="text-muted-foreground text-xs leading-normal">
                {customized ? "Restore every shortcut to its default." : "All shortcuts are at their defaults."}
              </p>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={!customized}
              onClick={() => setConfirmResetAll(true)}
            >
              Reset All to Defaults…
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsSidebarNav({ tab, onSelect }: { tab: TabId; onSelect: (tab: TabId) => void }): React.JSX.Element {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);

  const trimmed = query.trim().toLowerCase();
  const searching = trimmed.length > 0;
  const results = searching ? TABS.filter((t) => t.label.toLowerCase().includes(trimmed)) : [];
  const maxResultIndex = Math.max(results.length - 1, 0);
  if (activeResultIndex > maxResultIndex) {
    setActiveResultIndex(maxResultIndex);
  }

  function clearSearch(): void {
    setQuery("");
    setActiveResultIndex(0);
  }

  function chooseResult(result: { id: TabId }): void {
    onSelect(result.id);
    clearSearch();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing) return;
      const isFind = event.key.toLowerCase() === "f" && event.metaKey && !event.altKey && !event.shiftKey;
      const isSlash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isFind && !isSlash) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest("[role='listbox'], [role='menu']") !== null)
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && searching) {
      // Only clearing the query should happen here; letting the event bubble
      // would close the whole modal (Base UI's Escape handler is above us).
      event.preventDefault();
      event.stopPropagation();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex + 1) % results.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((activeResultIndex - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) chooseResult(result);
    }
  }

  return (
    <nav
      aria-label="Settings sections"
      className="bg-sidebar flex w-60 shrink-0 flex-col border-e"
    >
      <div className="flex flex-col gap-2 overflow-y-auto p-2">
        <div className="group hover:bg-sidebar-row-hover hover:text-sidebar-foreground text-sidebar-muted-foreground flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm font-medium">
          <Search
            className="text-sidebar-muted-foreground/80 size-4 shrink-0"
            strokeWidth={2}
          />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveResultIndex(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search"
            aria-label="Search settings"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searching && results.length > 0}
            aria-controls={searching && results.length > 0 ? "settings-search-results" : undefined}
            aria-activedescendant={
              searching && results[activeResultIndex] ? `settings-search-result-${results[activeResultIndex].id}` : undefined
            }
            spellCheck={false}
            className="text-sidebar-foreground placeholder:text-sidebar-muted-foreground min-w-0 flex-1 bg-transparent text-sm font-medium outline-none"
          />
          {searching ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="shrink-0"
              aria-label="Clear settings search"
              onClick={() => {
                clearSearch();
                searchInputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : (
            <kbd
              aria-hidden="true"
              className="text-muted-foreground bg-foreground/[0.07] pointer-events-none inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded px-1 font-sans text-xs font-medium select-none"
            >
              /
            </kbd>
          )}
        </div>
        {searching && results.length === 0 ? (
          <p
            role="status"
            className="text-sidebar-muted-foreground px-2 py-6 text-center text-xs"
          >
            No settings found
          </p>
        ) : null}
        {searching ? (
          <div
            id={results.length > 0 ? "settings-search-results" : undefined}
            role={results.length > 0 ? "listbox" : undefined}
            aria-label={results.length > 0 ? "Settings search results" : undefined}
            className="flex flex-col gap-1"
          >
            {results.map((t, index) => (
              <button
                key={t.id}
                id={`settings-search-result-${t.id}`}
                type="button"
                role="option"
                aria-selected={index === activeResultIndex}
                tabIndex={-1}
                ref={index === activeResultIndex ? scrollRowIntoView : undefined}
                className={navRow(index === activeResultIndex)}
                onMouseMove={() => setActiveResultIndex(index)}
                onClick={() => chooseResult(t)}
              >
                <t.icon
                  className="size-4 shrink-0"
                  strokeWidth={1.75}
                />
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {SETTINGS_NAV_GROUPS.map((group, index) => (
              <div
                key={index}
                role="group"
                aria-label={group.heading ?? undefined}
                className="flex flex-col gap-1"
              >
                {group.heading ? (
                  // The group carries this label; a heading is not a valid list child.
                  <h3
                    aria-hidden="true"
                    className="text-sidebar-muted-foreground/80 px-2 text-xs font-medium"
                  >
                    {group.heading}
                  </h3>
                ) : null}
                {group.tabs.map((id) => {
                  const entry = TABS.find((t) => t.id === id)!;
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-current={tab === id ? "page" : undefined}
                      className={navRow(tab === id)}
                      onClick={() => onSelect(id)}
                    >
                      <entry.icon
                        className="size-4 shrink-0"
                        strokeWidth={1.75}
                      />
                      {entry.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

/**
 * Settings as an in-app modal over the file browser (no separate window): the
 * app behind is dimmed and blurred, and its shortcuts idle while a dialog owns
 * the interaction.
 */
export function SettingsDialog(): React.JSX.Element {
  const { settingsOpen } = useAppState();
  const [tab, setTab] = useState<TabId>("general");
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [concurrencyText, setConcurrencyText] = useState("");
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [dbPathFailed, setDbPathFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>({ status: "idle" });
  const [updateDownload, setUpdateDownload] = useState<UpdateDownloadState | null>(null);
  const [copiedInfo, setCopiedInfo] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const backdropPressRef = useRef(false);

  useEffect(() => {
    function adopt(next: Preferences): void {
      setPrefs(next);
      setConcurrencyText(String(next.defaultConcurrency));
    }
    void window.pallet.prefs.get().then(adopt);
    void window.pallet.app
      .databasePath()
      .then(setDbPath)
      .catch(() => setDbPathFailed(true));
    void window.pallet.app
      .info()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
    const offPrefs = window.pallet.prefs.onChange(adopt);
    const offDownload = window.pallet.app.onUpdateDownloadState(setUpdateDownload);
    return () => {
      offPrefs();
      offDownload();
    };
  }, []);

  function requestSettingsClose(): void {
    // Closing unmounts a focused field without a blur, so commit-on-blur rows
    // would drop what was typed. Blur first so they commit.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && popupRef.current?.contains(focused)) focused.blur();
    setSettingsOpen(false);
  }

  function save(patch: Partial<Preferences>): void {
    void window.pallet.prefs.set(patch).then(setPrefs);
  }

  function onConcurrencyChange(value: string): void {
    setConcurrencyText(value);
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n) && n >= MIN_CONCURRENCY && n <= MAX_CONCURRENCY) save({ defaultConcurrency: n });
  }

  function copyDbPath(): void {
    if (dbPath === null) return;
    void navigator.clipboard.writeText(dbPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function checkNow(): Promise<void> {
    setUpdateCheck({ status: "checking" });
    setUpdateDownload(null);
    try {
      const info = await window.pallet.app.checkForUpdate();
      setUpdateCheck(info ? { status: "available", info } : { status: "current" });
    } catch {
      setUpdateCheck({ status: "failed" });
    }
  }

  function startUpdate(info: UpdateInfo): void {
    setUpdateDownload({ status: "downloading", version: info.version, receivedBytes: 0, totalBytes: 0 });
    void window.pallet.app.downloadUpdate(info).catch((err: unknown) => {
      setUpdateDownload({
        status: "error",
        version: info.version,
        receivedBytes: 0,
        totalBytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  function copyVersionInfo(): void {
    if (appInfo === null) return;
    const text = `Pallet ${appInfo.version} · Electron ${appInfo.electron} · macOS ${appInfo.systemVersion} · ${appInfo.arch}`;
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedInfo(true);
      setTimeout(() => setCopiedInfo(false), 1500);
    });
  }

  function stepConcurrency(delta: number): void {
    if (prefs === null) return;
    const next = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, prefs.defaultConcurrency + delta));
    setConcurrencyText(String(next));
    save({ defaultConcurrency: next });
  }

  const downloadState =
    updateCheck.status === "available" && updateDownload?.version === updateCheck.info.version ? updateDownload : null;
  const updateDownloading = downloadState?.status === "downloading";
  const updateDownloaded = downloadState?.status === "done";
  const updateDownloadFailed = downloadState?.status === "error";
  const updateBusy = updateDownloading || updateDownloaded;

  const updateNote =
    updateCheck.status === "checking"
      ? "Checking GitHub Releases…"
      : updateCheck.status === "current"
        ? "You’re running the latest version."
        : updateCheck.status === "available"
          ? updateDownloading && downloadState
            ? downloadState.totalBytes > 0
              ? `Downloading ${formatBytes(downloadState.receivedBytes)} of ${formatBytes(downloadState.totalBytes)}…`
              : `Downloading ${formatBytes(downloadState.receivedBytes)}…`
            : updateDownloaded
              ? "Saved to Downloads and opened — Pallet is closing, drag it into Applications."
              : updateDownloadFailed
                ? "Couldn’t download the update. Try again."
                : `Pallet ${updateCheck.info.version} is available.`
          : updateCheck.status === "failed"
            ? "Couldn’t reach GitHub Releases. Try again."
            : "Checks GitHub Releases now instead of waiting for the scheduled check.";

  const updateAction =
    updateCheck.status === "checking"
      ? "Checking…"
      : updateCheck.status === "available"
        ? updateBusy
          ? "Updating…"
          : updateCheck.info.dmgUrl
            ? "Update"
            : "View Release"
        : updateCheck.status === "failed"
          ? "Try Again"
          : updateCheck.status === "current"
            ? "Check Again"
            : "Check Now";

  return (
    <DialogPrimitive.Root
      open={settingsOpen}
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) requestSettingsClose();
      }}
    >
      {/* Nested inside the Settings root so Base UI treats it as a child dialog:
          Escape, focus trapping, and stacking all defer from Settings to it. */}
      <FavoriteDialog />
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="dialog-backdrop ease-entrance fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-ending-style:duration-[160ms] data-starting-style:opacity-0" />
        <DialogPrimitive.Viewport
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-10"
          onPointerDown={(event) => {
            backdropPressRef.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (backdropPressRef.current && event.target === event.currentTarget) requestSettingsClose();
            backdropPressRef.current = false;
          }}
        >
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={popupRef}
            finalFocus={false}
            aria-label="Settings"
            className="bg-background text-foreground ease-entrance relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden transition-[opacity,scale] duration-200 outline-none [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-ending-style:duration-[160ms] data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[44rem] sm:max-w-[60rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            <header className="flex h-12 shrink-0 items-center border-b ps-5 pe-2">
              <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                <span className="text-muted-foreground shrink-0">Settings</span>
                <span
                  aria-hidden="true"
                  className="text-muted-foreground/60 shrink-0"
                >
                  /
                </span>
                <span className="truncate">{TABS.find((t) => t.id === tab)!.label}</span>
              </div>
              <DialogPrimitive.Close
                aria-label="Close (Esc)"
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="ms-auto"
                  />
                }
              >
                <XIcon />
              </DialogPrimitive.Close>
            </header>
            <div className="flex min-h-0 flex-1">
              <SettingsSidebarNav
                tab={tab}
                onSelect={setTab}
              />
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-2xl px-5 py-5">
                  {tab === "keybindings" ? (
                    <KeybindingsPanel />
                  ) : prefs === null ? null : tab === "general" ? (
                    <GeneralPanel
                      prefs={prefs}
                      save={save}
                    />
                  ) : tab === "appearance" ? (
                    <AppearancePanel
                      prefs={prefs}
                      save={save}
                    />
                  ) : tab === "favorites" ? (
                    <FavoritesPanel />
                  ) : tab === "transfers" ? (
                    <TransfersPanel
                      prefs={prefs}
                      save={save}
                      concurrencyText={concurrencyText}
                      onConcurrencyChange={onConcurrencyChange}
                      setConcurrencyText={setConcurrencyText}
                      stepConcurrency={stepConcurrency}
                    />
                  ) : tab === "updates" ? (
                    <UpdatesPanel
                      prefs={prefs}
                      save={save}
                    />
                  ) : tab === "advanced" ? (
                    <AdvancedPanel
                      prefs={prefs}
                      save={save}
                      dbPath={dbPath}
                      dbPathFailed={dbPathFailed}
                      copied={copied}
                      copyDbPath={copyDbPath}
                    />
                  ) : tab === "about" ? (
                    <AboutPanel
                      appInfo={appInfo}
                      updateNote={updateNote}
                      updateAction={updateAction}
                      updateCheck={updateCheck}
                      checkNow={checkNow}
                      startUpdate={startUpdate}
                      updateBusy={updateBusy}
                      copiedInfo={copiedInfo}
                      copyVersionInfo={copyVersionInfo}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
