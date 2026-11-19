import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setAddingFavorite, setEditingFavorite, useAppState } from "@/store/pane.store";
import { ConnectForm } from "./ConnectForm";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "@renderer/lib/utils";

/** Editing a saved favorite, and creating one from Settings → Favorites. */
export function FavoriteDialog(): React.JSX.Element {
  const app = useAppState();
  const editing = app.editingFavorite;
  const adding = app.addingFavorite;
  const open = editing !== null || adding;

  function close(): void {
    // Settings stays open behind this dialog, so closing only dismisses the form
    // and lands back on whichever surface opened it.
    setEditingFavorite(null);
    setAddingFavorite(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
      {/* Base UI omits a nested dialog's own backdrop, which would leave the
          Settings modal sharp behind this form. Force one so Settings dims and
          blurs exactly like the app behind Settings does. */}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          forceRender
          className={cn(
            "ease-entrance fixed inset-0 isolate z-50 transition-all duration-200 data-ending-style:opacity-0 data-ending-style:duration-[160ms] data-starting-style:opacity-0",
            app.settingsOpen
              ? "dialog-backdrop"
              : "bg-black/20 supports-backdrop-filter:backdrop-blur-[2px] supports-backdrop-filter:backdrop-saturate-75 dark:bg-black/35",
          )}
        />
      </DialogPrimitive.Portal>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Favorite" : "Add Favorite"}</DialogTitle>
        </DialogHeader>
        {/* Content unmounts when closed, so per-open state seeds correctly. */}
        {open && (
          <ConnectForm
            key={editing?.id ?? "new"}
            editing={editing}
            creating={adding}
            prefill={null}
            defaultConcurrency={app.defaultConcurrency}
            defaultKeepaliveSeconds={app.defaultKeepaliveSeconds}
            autoFocus
            onClose={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
