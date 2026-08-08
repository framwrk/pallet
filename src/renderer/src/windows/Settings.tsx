import type { Appearance, Preferences } from "@shared/preferences";
import { ArrowUpDown, ChevronDown, ChevronUp, ChevronsUpDown, Contrast, Settings2 } from "lucide-react";
import { MAX_CONCURRENCY, MIN_CONCURRENCY } from "@shared/preferences";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Input } from "@renderer/components/ui/input";
import type { LucideIcon } from "lucide-react";
import { Switch } from "@renderer/components/ui/switch";
import { cn } from "@renderer/lib/utils";

type TabId = "general" | "appearance" | "transfers";

/** Kept in sync with the toolbar's own height; the window sizes off it. */
const TOOLBAR_HEIGHT = 62;

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Contrast },
  { id: "transfers", label: "Transfers", icon: ArrowUpDown },
];

const APPEARANCES: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** One inset group of rows, with the footnote that explains them below it. */
function Group({ footnote, children }: { footnote: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="bg-card overflow-hidden rounded-lg border">{children}</div>
      <p className="text-muted-foreground mt-1.5 px-3 text-[11px] leading-snug">{footnote}</p>
    </div>
  );
}

/** Label leading, control trailing — the macOS grouped-form row. */
function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-10 items-center justify-between gap-6 px-3 py-1.5">
      <span className="text-[13px]">{label}</span>
      {children}
    </div>
  );
}

/** AppKit-style stepper: two stacked halves that clamp at the bounds. */
function Stepper({
  onStep,
  canDecrement,
  canIncrement,
}: {
  onStep: (delta: number) => void;
  canDecrement: boolean;
  canIncrement: boolean;
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
        aria-label="Increase"
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
        aria-label="Decrease"
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
  const bodyRef = useRef<HTMLElement>(null);

  useEffect(() => {
    function adopt(next: Preferences): void {
      setPrefs(next);
      setConcurrencyText(String(next.defaultConcurrency));
    }
    void window.pallet.prefs.get().then(adopt);
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
          <Group footnote="Also toggled with ⇧⌘. in the file browser.">
            <Row label="Show hidden files">
              <Switch
                checked={prefs.showHidden}
                onCheckedChange={(checked) => save({ showHidden: checked })}
              />
            </Row>
          </Group>
        ) : tab === "appearance" ? (
          <Group footnote="System follows the macOS appearance setting.">
            <Row label="Appearance">
              <Select
                items={APPEARANCES}
                value={prefs.appearance}
                onValueChange={(value) => save({ appearance: value as Appearance })}
              >
                {/* The size variant sets its own height, so the override has to
                    match that variant to win. */}
                <SelectTrigger className="w-32 rounded-sm py-0 pr-1.5 text-[13px] data-[size=default]:h-6 [&>svg]:hidden">
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
        ) : (
          <Group footnote="Seeds the parallel transfer channels field when you connect to a server.">
            <Row label="Default concurrency">
              <div className="flex items-center gap-1.5">
                <Input
                  inputMode="numeric"
                  className="h-6 w-12 rounded-sm px-2 text-center text-[13px] tabular-nums"
                  value={concurrencyText}
                  onChange={(e) => onConcurrencyChange(e.target.value)}
                  onBlur={() => setConcurrencyText(String(prefs.defaultConcurrency))}
                />
                <Stepper
                  onStep={stepConcurrency}
                  canDecrement={prefs.defaultConcurrency > MIN_CONCURRENCY}
                  canIncrement={prefs.defaultConcurrency < MAX_CONCURRENCY}
                />
              </div>
            </Row>
          </Group>
        )}
      </main>
    </div>
  );
}
