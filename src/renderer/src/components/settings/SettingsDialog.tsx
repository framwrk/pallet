import type { Appearance, Preferences, RowDensity } from "@shared/prefs/prefs.types";
import {
  ArrowUpDown,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Cog,
  Contrast,
  Info,
  RefreshCw,
  Settings2,
  XIcon,
} from "lucide-react";
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
import { setSettingsOpen, useAppState } from "@/store/pane.store";
import { useEffect, useRef, useState } from "react";
import type { AppInfo } from "@shared/app/app.types";
import { Button } from "@renderer/components/ui/button";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Input } from "@renderer/components/ui/input";
import type { LucideIcon } from "lucide-react";
import { Switch } from "@renderer/components/ui/switch";
import type { UpdateInfo } from "@shared/update/update.types";
import appIcon from "@renderer/assets/pallet-icon.png";
import { cn } from "@renderer/lib/utils";

type TabId = "general" | "appearance" | "transfers" | "updates" | "advanced" | "about";

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Contrast },
  { id: "transfers", label: "Transfers", icon: ArrowUpDown },
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "advanced", label: "Advanced", icon: Cog },
  { id: "about", label: "About", icon: Info },
];

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

/** One inset group of rows, with the footnote that explains them below it. */
function Group({
  footnote,
  footnoteId,
  children,
}: {
  footnote?: string;
  footnoteId?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="bg-card overflow-hidden rounded-lg border">{children}</div>
      {footnote && (
        <p
          id={footnoteId}
          className="text-muted-foreground mt-1.5 px-3 text-[11px] leading-snug"
        >
          {footnote}
        </p>
      )}
    </div>
  );
}

/**
 * Label leading, control trailing — the macOS grouped-form row. `indent` marks
 * a row as subordinate to the one above it, which also gets the hairline that
 * separates them. `htmlFor` turns the label into a real control label; the
 * switches and select are buttons underneath, so a wrapping <label> would not
 * associate.
 */
function Row({
  label,
  indent,
  separated,
  htmlFor,
  children,
}: {
  label: string;
  indent?: boolean;
  /** A peer row below the first one: separated, but not visually subordinate. */
  separated?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex min-h-10 items-center justify-between gap-6 px-3 py-1.5",
        (indent || separated) && "border-t",
        indent && "pl-7",
      )}
    >
      {htmlFor ? (
        <label
          htmlFor={htmlFor}
          className="text-[13px]"
        >
          {label}
        </label>
      ) : (
        <span className="text-[13px]">{label}</span>
      )}
      {children}
    </div>
  );
}

/** A whole-row external link; the row itself is the affordance. */
function LinkRow({ label, href, separated }: { label: string; href: string; separated?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        "hover:bg-foreground/4 focus-visible:outline-ring flex min-h-10 w-full items-center justify-between gap-6 px-3 py-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2",
        separated && "border-t",
      )}
      onClick={() => void window.pallet.app.openExternal(href)}
    >
      <span className="text-[13px]">{label}</span>
      <ArrowUpRight
        className="text-muted-foreground size-3.5"
        strokeWidth={2}
      />
    </button>
  );
}

/** AppKit-style stepper: two stacked halves that clamp at the bounds. */
function Stepper({
  onStep,
  canDecrement,
  canIncrement,
  subject,
}: {
  onStep: (delta: number) => void;
  canDecrement: boolean;
  canIncrement: boolean;
  /** Names the value in the button labels; "Increase" alone is anonymous. */
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

/**
 * Numeric row control. Text is held locally so a half-typed number doesn't
 * fight the stored value; only in-range values are committed as you type.
 */
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
  // Adopt a value that changed outside this field (stepper or settings reload)
  // without an effect; a half-typed value keeps its own text until then.
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
    <div className="flex flex-col gap-4">
      <Group
        footnote="Also toggled with ⇧⌘. in the file browser."
        footnoteId="note-listing"
      >
        <Row
          label="Show hidden files"
          htmlFor="pref-show-hidden"
        >
          <Switch
            id="pref-show-hidden"
            aria-describedby="note-listing"
            checked={prefs.showHidden}
            onCheckedChange={(checked) => save({ showHidden: checked })}
          />
        </Row>
      </Group>
      <Group
        footnote="A changed sort applies to both panes now."
        footnoteId="note-sorting"
      >
        <Row
          label="Sort files by"
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
              aria-describedby="note-sorting"
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
          separated
          htmlFor="pref-folders-first"
        >
          <Switch
            id="pref-folders-first"
            aria-describedby="note-sorting"
            checked={prefs.foldersFirst}
            onCheckedChange={(checked) => save({ foldersFirst: checked })}
          />
        </Row>
      </Group>
      <Group
        footnote="Totals the contents of each folder instead of showing “--”. Local folders only, unless you include remote ones — sizing a tree over SSH is far slower than reading it off disk."
        footnoteId="note-folder-sizes"
      >
        <Row
          label="Calculate folder sizes"
          htmlFor="pref-folder-sizes"
        >
          <Switch
            id="pref-folder-sizes"
            aria-describedby="note-folder-sizes"
            checked={prefs.calculateFolderSizes}
            onCheckedChange={(checked) => save({ calculateFolderSizes: checked })}
          />
        </Row>
        {prefs.calculateFolderSizes && (
          <Row
            label="Include remote folders"
            indent
            htmlFor="pref-remote-folder-sizes"
          >
            <Switch
              id="pref-remote-folder-sizes"
              aria-describedby="note-folder-sizes"
              checked={prefs.calculateRemoteFolderSizes}
              onCheckedChange={(checked) => save({ calculateRemoteFolderSizes: checked })}
            />
          </Row>
        )}
      </Group>
      <Group
        footnote="Larger files still show their metadata in the inspector; only the inline text or image body is skipped."
        footnoteId="note-preview"
      >
        <Row
          label="Preview files up to"
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
              aria-describedby="note-preview"
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
      </Group>
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
    <div className="flex flex-col gap-4">
      <Group
        footnote="System follows the macOS appearance setting."
        footnoteId="note-appearance"
      >
        <Row
          label="Appearance"
          htmlFor="pref-appearance"
        >
          <Select
            items={APPEARANCES}
            value={prefs.appearance}
            onValueChange={(value) => save({ appearance: value as Appearance })}
          >
            {/* The size variant sets its own height, so the override has to
                match that variant to win. */}
            <SelectTrigger
              id="pref-appearance"
              aria-describedby="note-appearance"
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
      </Group>
      <Group
        footnote="Compact matches Finder’s default density. Comfortable adds breathing room to every row."
        footnoteId="note-density"
      >
        <Row
          label="Row density"
          htmlFor="pref-row-density"
        >
          <Select
            items={ROW_DENSITIES}
            value={prefs.rowDensity}
            onValueChange={(value) => save({ rowDensity: value as RowDensity })}
          >
            <SelectTrigger
              id="pref-row-density"
              aria-describedby="note-density"
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
  /** Held separately so a half-typed number doesn't fight the stored value. */
  onConcurrencyChange: (value: string) => void;
  setConcurrencyText: (value: string) => void;
  stepConcurrency: (delta: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <Group
        footnote="These seed the fields in the connection dialog. Concurrency is the number of parallel transfer channels; keepalive keeps idle sessions alive, and 0 disables it."
        footnoteId="note-connections"
      >
        <Row
          label="Default concurrency"
          htmlFor="pref-concurrency"
        >
          <div className="flex items-center gap-1.5">
            <Input
              id="pref-concurrency"
              inputMode="numeric"
              role="spinbutton"
              aria-describedby="note-connections"
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
            describedBy="note-connections"
            onChange={(value) => save({ defaultKeepaliveSeconds: value })}
          />
        </Row>
        <Row
          label="Reconnect automatically"
          separated
          htmlFor="pref-auto-reconnect"
        >
          <Switch
            id="pref-auto-reconnect"
            aria-describedby="note-connections"
            checked={prefs.autoReconnect}
            onCheckedChange={(checked) => save({ autoReconnect: checked })}
          />
        </Row>
      </Group>
      <Group
        footnote="A file is abandoned after this long without progress, then retried up to the per-file limit when the channel is at fault."
        footnoteId="note-transfer-reliability"
      >
        <Row
          label="Stall timeout"
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
              describedBy="note-transfer-reliability"
              onChange={(value) => save({ transferTimeoutSeconds: value })}
            />
            <span className="text-muted-foreground text-[11px]">seconds</span>
          </div>
        </Row>
        <Row
          label="Retries per file"
          separated
          htmlFor="pref-transfer-retries"
        >
          <NumberField
            id="pref-transfer-retries"
            value={prefs.transferMaxRetries}
            min={MIN_TRANSFER_RETRIES}
            max={MAX_TRANSFER_RETRIES}
            subject="retries per file"
            describedBy="note-transfer-reliability"
            onChange={(value) => save({ transferMaxRetries: value })}
          />
        </Row>
      </Group>
      <Group
        footnote="Sets the trailing window for the average and median speeds in the transfer drawer."
        footnoteId="note-speed-window"
      >
        <Row
          label="Speed window"
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
              aria-describedby="note-speed-window"
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
    </div>
  );
}

function UpdatesPanel({ prefs, save }: { prefs: Preferences; save: (patch: Partial<Preferences>) => void }): React.JSX.Element {
  return (
    <Group
      footnote="Pallet checks GitHub Releases on launch and once a day. Prereleases are releases GitHub flags as prerelease; version numbers stay MAJOR.MINOR.PATCH."
      footnoteId="note-updates"
    >
      <Row
        label="Check for updates automatically"
        htmlFor="pref-auto-update"
      >
        <Switch
          id="pref-auto-update"
          aria-describedby="note-updates"
          checked={prefs.automaticallyCheckForUpdates}
          onCheckedChange={(checked) => save({ automaticallyCheckForUpdates: checked })}
        />
      </Row>
      <Row
        label="Include prerelease versions"
        separated
        htmlFor="pref-prerelease"
      >
        <Switch
          id="pref-prerelease"
          aria-describedby="note-updates"
          checked={prefs.receivePrereleaseUpdates}
          onCheckedChange={(checked) => save({ receivePrereleaseUpdates: checked })}
        />
      </Row>
    </Group>
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
    <div className="flex flex-col gap-4">
      <Group
        footnote="Applies to files opened with an external editor. The delay lets the writer settle before uploading; the poll interval controls how often Pallet checks for changes."
        footnoteId="note-editor"
      >
        <Row
          label="Upload delay"
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
              describedBy="note-editor"
              onChange={(value) => save({ editorSaveDebounceMs: value })}
            />
            <span className="text-muted-foreground text-[11px]">ms</span>
          </div>
        </Row>
        <Row
          label="Change polling"
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
              describedBy="note-editor"
              onChange={(value) => save({ editorPollIntervalMs: value })}
            />
            <span className="text-muted-foreground text-[11px]">ms</span>
          </div>
        </Row>
        <Row
          label="Upload timeout"
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
              describedBy="note-editor"
              onChange={(value) => save({ editorUploadTimeoutMs: value })}
            />
            <span className="text-muted-foreground text-[11px]">ms</span>
          </div>
        </Row>
      </Group>
      <Group footnote="Favorites, known host keys, and a diagnostic transfer history log live in this SQLite file — any SQLite client can open it. Pallet does not surface transfer history in the app. Quit Pallet before writing to it.">
        <Row label="Database Path">
          <div className="flex min-w-0 gap-2">
            {/* CSS truncation keeps the full text in the accessibility tree;
                the title is only the visual tooltip. */}
            <span
              title={dbPath ?? undefined}
              className="text-muted-foreground min-w-0 truncate font-mono text-[11px] select-text"
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
    </div>
  );
}

function AboutPanel({
  appInfo,
  updateNote,
  updateAction,
  updateCheck,
  checkNow,
  copiedInfo,
  copyVersionInfo,
}: {
  appInfo: AppInfo | null;
  updateNote: string;
  updateAction: string;
  updateCheck: UpdateCheck;
  checkNow: () => Promise<void>;
  copiedInfo: boolean;
  copyVersionInfo: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
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

      <Group>
        <LinkRow
          label="GitHub Repository"
          href={REPO_URL}
        />
        <LinkRow
          label="Release Notes"
          href={RELEASES_URL}
          separated
        />
        <LinkRow
          label="Report an Issue…"
          href={ISSUES_URL}
          separated
        />
      </Group>

      <Group
        footnote={updateNote}
        footnoteId="note-update-check"
      >
        <Row label="Check for updates">
          <Button
            size="xs"
            variant="outline"
            aria-describedby="note-update-check"
            disabled={updateCheck.status === "checking"}
            onClick={() => {
              if (updateCheck.status === "available") {
                void window.pallet.app.openExternal(updateCheck.info.url);
              } else {
                void checkNow();
              }
            }}
          >
            {updateAction}
          </Button>
        </Row>
      </Group>

      <Group
        footnote="Pallet has no accounts and collects no telemetry. The only outbound request is the GitHub Releases update check."
        footnoteId="note-privacy"
      >
        <Row label="Data collection">
          <span className="text-muted-foreground text-[12px]">None</span>
        </Row>
      </Group>

      <Group
        footnote="The version text copies Pallet, Electron, macOS, and architecture for a bug report. Logs are scrubbed of credentials."
        footnoteId="note-diagnostics"
      >
        <Row label="Log file">
          <Button
            size="xs"
            variant="outline"
            aria-describedby="note-diagnostics"
            onClick={() => void window.pallet.app.revealLog()}
          >
            Reveal in Finder
          </Button>
        </Row>
        <Row
          label="Version info"
          separated
        >
          <Button
            size="xs"
            variant="outline"
            aria-describedby="note-diagnostics"
            disabled={appInfo === null}
            onClick={copyVersionInfo}
          >
            {copiedInfo ? "Copied" : "Copy"}
          </Button>
        </Row>
      </Group>

      <Group footnote="Pallet is free and open source under the Apache License 2.0.">
        <Row label="License">
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
          separated
        >
          <span className="text-muted-foreground text-[11px]">© 2026 Framwrk</span>
        </Row>
        <Row
          label="Built with"
          separated
        >
          <span className="text-muted-foreground text-[11px]">Electron · React · Base UI · ssh2 · basic-ftp</span>
        </Row>
        <LinkRow
          label="Framwrk on GitHub"
          href={AUTHOR_URL}
          separated
        />
      </Group>
    </div>
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
  // Held separately so a half-typed number doesn't fight the stored value.
  const [concurrencyText, setConcurrencyText] = useState("");
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [dbPathFailed, setDbPathFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck>({ status: "idle" });
  const [copiedInfo, setCopiedInfo] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPressRef = useRef(false);

  useEffect(() => {
    function adopt(next: Preferences): void {
      setPrefs(next);
      setConcurrencyText(String(next.defaultConcurrency));
    }
    void window.pallet.prefs.get().then(adopt);
    // The main handler can't fail, but a rejected invoke beats a silently empty row.
    void window.pallet.app
      .databasePath()
      .then(setDbPath)
      .catch(() => setDbPathFailed(true));
    void window.pallet.app
      .info()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
    return window.pallet.prefs.onChange(adopt);
  }, []);

  // Focus the surface, not its first control: no stray focus ring, no phone
  // keyboard. On close, leave focus alone; returning it would paint a ring.
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
    try {
      const info = await window.pallet.app.checkForUpdate();
      setUpdateCheck(info ? { status: "available", info } : { status: "current" });
    } catch {
      setUpdateCheck({ status: "failed" });
    }
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

  const updateNote =
    updateCheck.status === "checking"
      ? "Checking GitHub Releases…"
      : updateCheck.status === "current"
        ? "You’re running the latest version."
        : updateCheck.status === "available"
          ? `Pallet ${updateCheck.info.version} is available.`
          : updateCheck.status === "failed"
            ? "Couldn’t reach GitHub Releases. Try again."
            : "Checks GitHub Releases now instead of waiting for the scheduled check.";

  const updateAction =
    updateCheck.status === "checking"
      ? "Checking…"
      : updateCheck.status === "available"
        ? "View Release"
        : updateCheck.status === "failed"
          ? "Try Again"
          : updateCheck.status === "current"
            ? "Check Again"
            : "Check Now";

  return (
    <DialogPrimitive.Root
      open={settingsOpen}
      // Portaled layers outside this tree (toasts, Select popups) are not
      // backdrop presses; dismissal goes through the viewport handlers below.
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) requestSettingsClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Viewport
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 lg:p-10"
          onPointerDown={(event) => {
            // A dismissal is a press that both starts and ends on the
            // backdrop; a selection ending there is not one.
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
            className="bg-background text-foreground relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden transition-[opacity,scale] duration-150 ease-out outline-none [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[44rem] sm:max-w-[60rem] sm:rounded-2xl sm:border sm:shadow-2xl/40"
          >
            <header className="flex h-12 shrink-0 items-center border-b ps-5 pe-2">
              <span className="text-[13px] font-medium">{TABS.find((t) => t.id === tab)!.label}</span>
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
              <nav
                aria-label="Settings sections"
                className="bg-sidebar w-60 shrink-0 border-e p-2"
              >
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-current={tab === t.id ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-[13px]",
                      tab === t.id
                        ? "bg-foreground/8 text-foreground"
                        : "text-muted-foreground hover:bg-foreground/4 hover:text-foreground",
                    )}
                    onClick={() => setTab(t.id)}
                  >
                    <t.icon
                      className="size-4"
                      strokeWidth={1.75}
                    />
                    {t.label}
                  </button>
                ))}
              </nav>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-2xl px-5 py-5">
                  {prefs === null ? null : tab === "general" ? (
                    <GeneralPanel
                      prefs={prefs}
                      save={save}
                    />
                  ) : tab === "appearance" ? (
                    <AppearancePanel
                      prefs={prefs}
                      save={save}
                    />
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
