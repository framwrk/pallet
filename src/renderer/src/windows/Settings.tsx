import type { Appearance, Preferences } from "@shared/prefs/prefs.types";
import { ArrowUpDown, ChevronDown, ChevronUp, ChevronsUpDown, Cog, Contrast, Settings2 } from "lucide-react";
import { MAX_CONCURRENCY, MIN_CONCURRENCY } from "@shared/prefs/prefs.constants";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import type { LucideIcon } from "lucide-react";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";

type TabId = "general" | "appearance" | "transfers" | "advanced";

/** Kept in sync with the toolbar's own height; the window sizes off it. */
const TOOLBAR_HEIGHT = 62;

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Contrast },
  { id: "transfers", label: "Transfers", icon: ArrowUpDown },
  { id: "advanced", label: "Advanced", icon: Cog },
];

const APPEARANCES: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

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
  htmlFor,
  children,
}: {
  label: string;
  indent?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("flex min-h-10 items-center justify-between gap-6 px-3 py-1.5", indent && "border-t pl-7")}>
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

export function Settings(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>("general");
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  // Held separately so a half-typed number doesn't fight the stored value.
  const [concurrencyText, setConcurrencyText] = useState("");
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [dbPathFailed, setDbPathFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLElement>(null);

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
    return window.pallet.prefs.onChange(adopt);
  }, []);

  // A macOS settings window fits itself to the tab you're on and takes its
  // title from that tab, so report both whenever either could have changed. A
  // layout effect rather than an effect because ResizeObserver alone misses it
  // while the window is occluded and its rAF callbacks are throttled; the
  // observer stays on top for reflows without a re-render, like a wrapping
  // footnote.
  const ready = prefs !== null;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el === null || !ready) return;
    const { label } = TABS.find((t) => t.id === tab)!;
    const report = (): void => {
      // Opening the theme menu takes the body out of flow for a frame, and a
      // zero measurement there would collapse the window to its toolbar.
      if (el.offsetHeight > 0) void window.pallet.settings.resize(TOOLBAR_HEIGHT + el.offsetHeight, label);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tab, ready]);

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

  function stepConcurrency(delta: number): void {
    if (prefs === null) return;
    const next = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, prefs.defaultConcurrency + delta));
    setConcurrencyText(String(next));
    save({ defaultConcurrency: next });
  }

  return (
    <div className="bg-muted dark:bg-background flex min-h-full flex-col select-none">
      <header
        className="flex shrink-0 items-end justify-center gap-1 border-b pb-1.5 [-webkit-app-region:drag]"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "flex w-18.5 flex-col items-center gap-1 rounded-md px-1 py-1.5 [-webkit-app-region:no-drag]",
              tab === t.id
                ? "bg-foreground/8 text-foreground"
                : "text-muted-foreground hover:bg-foreground/4 hover:text-foreground",
            )}
            onClick={() => setTab(t.id)}
          >
            <t.icon
              className="size-4.5"
              strokeWidth={1.75}
            />
            <span className="text-[11px] leading-none">{t.label}</span>
          </button>
        ))}
      </header>

      <main
        ref={bodyRef}
        className="px-5 py-5"
      >
        {prefs === null ? null : tab === "general" ? (
          <div className="flex flex-col gap-4">
            <Group
              footnote="Also toggled with ⇧⌘. in the file browser."
              footnoteId="note-show-hidden"
            >
              <Row
                label="Show hidden files"
                htmlFor="pref-show-hidden"
              >
                <Switch
                  id="pref-show-hidden"
                  aria-describedby="note-show-hidden"
                  checked={prefs.showHidden}
                  onCheckedChange={(checked) => save({ showHidden: checked })}
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
          </div>
        ) : tab === "appearance" ? (
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
                {/* An HTML popup can't escape the window the way an NSMenu can,
                    and this window is only as tall as its content — so let the
                    positioner flip and shrink to stay inside it. */}
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
        ) : tab === "transfers" ? (
          <Group
            footnote="Seeds the parallel transfer channels field when you connect to a server."
            footnoteId="note-concurrency"
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
                  aria-describedby="note-concurrency"
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
          </Group>
        ) : tab === "advanced" ? (
          <Group footnote="Favorites, known host keys, and transfer history live in this SQLite file — any SQLite client can open it. Quit Pallet before writing to it.">
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
        ) : null}
      </main>
    </div>
  );
}
