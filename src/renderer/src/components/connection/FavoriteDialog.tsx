import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setAddingFavorite, setEditingFavorite, setSettingsOpen, useAppState } from "@/store/pane.store";
import { ConnectForm } from "./ConnectForm";

/** Editing a saved favorite, and creating one from Settings → Favorites. */
export function FavoriteDialog(): React.JSX.Element {
  const app = useAppState();
  const editing = app.editingFavorite;
  const adding = app.addingFavorite;
  const open = editing !== null || adding;

  function close(): void {
    // Add starts from Settings, so step back into it rather than the browser.
    const fromSettings = adding;
    setEditingFavorite(null);
    setAddingFavorite(false);
    if (fromSettings) setSettingsOpen(true);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
    >
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
