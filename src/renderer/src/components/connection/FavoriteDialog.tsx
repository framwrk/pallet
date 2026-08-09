import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setEditingFavorite, useAppState } from "@/store/pane.store";
import { ConnectForm } from "./ConnectForm";

/** Editing a saved favorite. New connections go through Quick Connect. */
export function FavoriteDialog(): React.JSX.Element {
  const app = useAppState();
  const editing = app.editingFavorite;

  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) setEditingFavorite(null);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Favorite</DialogTitle>
        </DialogHeader>
        {/* Content unmounts when closed, so per-open state seeds correctly. */}
        {editing && (
          <ConnectForm
            editing={editing}
            prefill={null}
            defaultConcurrency={app.defaultConcurrency}
            autoFocus
            onClose={() => setEditingFavorite(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
