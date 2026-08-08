import { AlertCircle, Info, X } from "lucide-react";
import { dismissToast, useAppState } from "@/store/panes";
import { cn } from "@/lib/utils";

export function Toasts(): React.JSX.Element | null {
  const { toasts } = useAppState();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-3 bottom-10 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "bg-popover pointer-events-auto flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg",
            t.kind === "error" ? "border-destructive/40" : "border-border",
          )}
        >
          {t.kind === "error" ? (
            <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" />
          ) : (
            <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 wrap-break-word">{t.message}</span>
          <button
            className="hover:bg-accent shrink-0 rounded p-0.5"
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
