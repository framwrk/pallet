import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { setConfirmDelete, useAppState } from "@/store/panes";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import { confirmedRemoteDelete } from "@/store/ops";

/** Remote deletes are permanent — always confirmed (§4). */
export function ConfirmDeleteDialog(): React.JSX.Element | null {
  const { confirmDelete } = useAppState();
  if (!confirmDelete) return null;
  const { paneId, names } = confirmDelete;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && setConfirmDelete(null)}
    >
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="text-destructive size-5" />
            Delete {names.length === 1 ? `“${names[0]}”` : `${names.length} items`}?
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">Remote items are deleted permanently — there is no Trash on the server.</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmDelete(null);
                void confirmedRemoteDelete(paneId, names);
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
