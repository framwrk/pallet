import { type ConnectionAttempt, useAppState } from "@/store/pane.store";
import { LoaderCircle, Server } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { ROW_HEIGHTS } from "@shared/prefs/prefs.constants";
import { cn } from "@/lib/utils";

/** Deterministic name-length variety so the placeholder reads as a listing. */
const NAME_WIDTHS = [72, 54, 88, 63, 79, 45, 95, 58, 70, 84, 50, 67, 91, 61, 77, 56];

/**
 * The right pane's slot while a remote session is opening, before any listing
 * exists (plans/05). Rows fill the measured viewport rather than a fixed count,
 * and pulse in a travelling wave so the real listing settles in without a
 * visible count jump. When the listing arrives, `leaving` fades the placeholder
 * out over the real pane so the handoff is a reveal, not a swap.
 */
export function PendingPane({
  attempt,
  isActive,
  leaving,
}: {
  attempt: ConnectionAttempt;
  isActive: boolean;
  leaving: boolean;
}): React.JSX.Element {
  const { rowDensity } = useAppState();
  const rowHeight = ROW_HEIGHTS[rowDensity];
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(0);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = (): void => setBodyHeight(body.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.max(1, Math.ceil(bodyHeight / rowHeight));

  return (
    <section
      className={cn(
        "bg-background absolute inset-0 z-10 flex flex-col overflow-hidden transition-opacity duration-[190ms] ease-[var(--ease-entrance)]",
        leaving ? "pointer-events-none opacity-0" : "opacity-100",
        isActive &&
          "after:bg-primary after:pointer-events-none after:absolute after:top-0 after:right-2 after:left-2 after:h-1 after:rounded-full",
      )}
      role="status"
      aria-label={`Connecting to ${attempt.label}`}
      aria-hidden={leaving ? true : undefined}
    >
      <span className="sr-only">Connecting to {attempt.label}…</span>
      <div
        className="mt-1 flex h-8 items-center gap-1 border-b px-2"
        aria-hidden="true"
      >
        <span className="bg-primary/10 text-primary flex shrink-0 items-center gap-1 rounded-full py-0.5 pr-2 pl-2 text-[11px] font-medium">
          <Server className="size-3" />
          <span className="max-w-56 truncate">{attempt.host}</span>
        </span>
        <div className="flex min-w-0 flex-1 items-center pl-1">
          <span className="bg-muted h-2.5 w-28 rounded-sm" />
        </div>
        <LoaderCircle className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
      </div>

      <div
        className="text-muted-foreground grid grid-cols-[minmax(0,1fr)_5.5rem_12rem] gap-4 border-b px-3 py-1 text-xs font-medium"
        aria-hidden="true"
      >
        <span className="px-1">Name</span>
        <span className="px-1 text-right">Size</span>
        <span className="px-1 text-right">Date Modified</span>
      </div>

      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-hidden"
        aria-hidden="true"
      >
        {Array.from({ length: rowCount }, (_, index) => (
          <div
            key={index}
            className="font-file grid grid-cols-[minmax(0,1fr)_5.5rem_12rem] items-center gap-4 px-3"
            style={{ height: rowHeight }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="pallet-skeleton-bar size-4 shrink-0"
                style={{ animationDelay: `${-index * 90}ms` }}
              />
              <span
                className="pallet-skeleton-bar h-3 max-w-full"
                style={{
                  width: `${NAME_WIDTHS[index % NAME_WIDTHS.length]}%`,
                  animationDelay: `${-index * 90}ms`,
                }}
              />
            </span>
            <span
              className="pallet-skeleton-bar ml-auto h-2.5 w-10"
              style={{ animationDelay: `${-index * 90}ms` }}
            />
            <span
              className="pallet-skeleton-bar ml-auto h-2.5 w-24"
              style={{ animationDelay: `${-index * 90}ms` }}
            />
          </div>
        ))}
      </div>

      <div
        className="border-t px-3 py-1"
        aria-hidden="true"
      >
        <span className="bg-muted mx-auto block h-2.5 w-24 rounded-sm" />
      </div>
    </section>
  );
}
