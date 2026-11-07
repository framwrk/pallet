import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { dismissToast, useAppState } from "@/store/pane.store";
import { cn } from "@/lib/utils";

export function Toasts(): React.JSX.Element | null {
  const { toasts } = useAppState();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-3 bottom-10 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t, index) => (
        <div
          key={t.id}
          className={cn(
            "bg-popover flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg",
            // While exiting (connection completed, errored out, dismissed) the
            // row runs a 145ms outro — 20% shorter than the 180ms entrance
            // (DESIGN.md › Motion) — and is removed right after.
            t.exiting &&
              "animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-1 fill-mode-both ease-entrance pointer-events-none duration-[145ms]",
            // Entrance from below, staggered 30ms per existing toast so a
            // burst settles in sequence (DESIGN.md › Motion).
            !t.exiting &&
              "animate-in fade-in zoom-in-95 slide-in-from-bottom-1 fill-mode-both ease-entrance pointer-events-auto duration-[180ms]",
            t.kind === "error" ? "border-destructive/40" : "border-border",
          )}
          style={{ animationDelay: t.exiting ? undefined : `${Math.min(index, 12) * 30}ms` }}
        >
          {t.kind === "error" ? (
            <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
          ) : t.kind === "success" ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 [animation:pallet-confirm-pulse_320ms_var(--ease-onscreen)] text-green-600 dark:text-green-400" />
          ) : (
            <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 wrap-break-word">{t.message}</span>
          <button
            className="hover:bg-accent shrink-0 rounded p-0.5 transition-colors duration-[140ms]"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
