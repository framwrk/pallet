import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { dismissToast, useAppState } from "@/store/pane.store";
import { cn } from "@/lib/utils";

export function Toasts(): React.JSX.Element | null {
  const { toasts } = useAppState();
  // The live region stays mounted so screen readers announce toasts as they arrive.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-3 bottom-[calc(0.75rem+var(--transfer-panel-clearance,0px))] z-50 flex w-80 flex-col gap-2 transition-[bottom] duration-[240ms] motion-reduce:transition-none"
    >
      {toasts.map((t, index) => (
        <div
          key={t.id}
          className={cn(
            "bg-popover flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg",
            t.exiting &&
              "animate-out fade-out-0 zoom-out-95 slide-out-to-bottom-1 fill-mode-both ease-entrance pointer-events-none duration-[145ms]",
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
