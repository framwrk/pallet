import { useEffect, useState } from "react";
import type { Appearance, Preferences } from "@shared/preferences";
import { MAX_CONCURRENCY, MIN_CONCURRENCY } from "@shared/preferences";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { Checkbox } from "@renderer/components/ui/checkbox";

type TabId = "general" | "appearance" | "transfers";

const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "transfers", label: "Transfers" },
];

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-center gap-4">
      <span className="text-muted-foreground pt-1 text-right text-xs">{label}</span>
      <div className="flex flex-col gap-1">
        {children}
        {hint && <span className="text-muted-foreground text-[11px]">{hint}</span>}
      </div>
    </div>
  );
}

export function Settings(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>("general");
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  // Held separately so a half-typed number doesn't fight the stored value.
  const [concurrencyText, setConcurrencyText] = useState("");

  useEffect(() => {
    function adopt(next: Preferences): void {
      setPrefs(next);
      setConcurrencyText(String(next.defaultConcurrency));
    }
    void window.pallet.prefs.get().then(adopt);
    return window.pallet.prefs.onChange(adopt);
  }, []);

  function save(patch: Partial<Preferences>): void {
    void window.pallet.prefs.set(patch).then(setPrefs);
  }

  function onConcurrencyChange(value: string): void {
    setConcurrencyText(value);
    const n = Number.parseInt(value, 10);
    if (Number.isInteger(n) && n >= MIN_CONCURRENCY && n <= MAX_CONCURRENCY) save({ defaultConcurrency: n });
  }

  return (
    <div className="flex h-full flex-col select-none">
      <header className="bg-sidebar flex h-11 shrink-0 items-center gap-1 border-b pr-3 pl-20 [-webkit-app-region:drag]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={cn(
              "rounded-md px-2.5 py-1 text-[13px] [-webkit-app-region:no-drag]",
              tab === t.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </header>

      <main className="flex-1 overflow-y-auto p-5">
        {prefs === null ? null : tab === "general" ? (
          <Row label="Hidden files">
            <label className="flex items-center gap-2 text-[13px]">
              <Checkbox
                checked={prefs.showHidden}
                onCheckedChange={(checked) => save({ showHidden: checked })}
              />
              <span>Show hidden files</span>
            </label>
            {/* <span className="text-muted-foreground text-[11px]">Also toggled with ⇧⌘. in the file browser.</span> */}
          </Row>
        ) : tab === "appearance" ? (
          <Row label="Theme">
            <div className="flex items-center gap-1.5">
              <Select>
                <SelectTrigger className="w-36 border-none">
                  <SelectValue
                    placeholder="Select a theme"
                    className="capitalize"
                  />
                </SelectTrigger>
                <SelectContent className="w-36">
                  {APPEARANCES.map((a) => (
                    <SelectItem
                      key={a.value}
                      value={a.value}
                      onClick={() => save({ appearance: a.value })}
                      className={cn("cursor-pointer rounded-none")}
                    >
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* {APPEARANCES.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  className={cn(
                    "rounded-md border px-3 py-1 text-[13px]",
                    prefs.appearance === a.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-muted",
                  )}
                  onClick={() => save({ appearance: a.value })}
                >
                  {a.label}
                </button>
              ))} */}
            </div>
          </Row>
        ) : (
          <Row
            label="Default concurrency"
            hint={`Parallel transfer channels for new connections (${MIN_CONCURRENCY}–${MAX_CONCURRENCY}).`}
          >
            <Input
              type="number"
              min={MIN_CONCURRENCY}
              max={MAX_CONCURRENCY}
              className="h-7 w-24 text-[13px]"
              value={concurrencyText}
              onChange={(e) => onConcurrencyChange(e.target.value)}
              onBlur={() => setConcurrencyText(String(prefs.defaultConcurrency))}
            />
          </Row>
        )}
      </main>
    </div>
  );
}
