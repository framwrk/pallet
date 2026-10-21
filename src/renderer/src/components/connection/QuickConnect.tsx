import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EthernetPort, LoaderCircle, Server } from "lucide-react";
import { closeQuickConnect, useAppState } from "@/store/pane.store";
import { ConnectForm } from "./ConnectForm";
import type { Favorite } from "@shared/favorite/favorite.types";
import { connectFavorite } from "@/store/favorite.store";
import { useState } from "react";

/**
 * Opens over the workspace from Connect to Server, Command-K, or a favorite
 * that needs credentials. The current session remains visible until replaced.
 */
export function ConnectDialog(): React.JSX.Element {
  const app = useAppState();
  const prefill = app.quickConnectPrefill;
  const [busyFavorite, setBusyFavorite] = useState<string | null>(null);

  async function chooseFavorite(favorite: Favorite): Promise<void> {
    setBusyFavorite(favorite.id);
    try {
      await connectFavorite(favorite.id, app.quickConnectPane);
    } finally {
      setBusyFavorite(null);
    }
  }

  return (
    <Dialog
      open={app.quickConnectOpen}
      onOpenChange={(open) => {
        if (!open) closeQuickConnect();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto p-4 sm:max-w-lg">
        <DialogHeader className="pr-10">
          <div className="flex items-center gap-3">
            <div className="bg-primary/12 text-primary flex size-9 shrink-0 items-center justify-center rounded-[10px]">
              <EthernetPort className="size-4.5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-semibold tracking-[-0.01em]">Connect to a server</DialogTitle>
              <DialogDescription className="mt-0.5 text-[11px]">FTP, FTPS, or SFTP</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {app.favorites.length > 0 && (
          <section
            aria-labelledby="connect-favorites-title"
            className="flex flex-col gap-1.5"
          >
            <div
              id="connect-favorites-title"
              className="text-muted-foreground px-1 text-[11px] font-medium tracking-[0.01em]"
            >
              Favorites
            </div>
            <div className="border-border/70 flex max-h-44 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1">
              {app.favorites.map((favorite) => (
                <button
                  key={favorite.id}
                  type="button"
                  disabled={busyFavorite !== null}
                  aria-label={`Connect to ${favorite.name}`}
                  className="hover:bg-accent flex h-9 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-[13px] disabled:opacity-60"
                  onClick={() => void chooseFavorite(favorite)}
                >
                  <Server className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{favorite.name}</span>
                  <span className="text-muted-foreground max-w-[55%] truncate font-mono text-[10px]">
                    {favorite.username}@{favorite.host}
                  </span>
                  {busyFavorite === favorite.id && <LoaderCircle className="size-3.5 shrink-0 animate-spin" />}
                </button>
              ))}
            </div>
          </section>
        )}
        {/* Keyed so a favorite prefill reseeds the fields. */}
        <ConnectForm
          key={prefill?.id ?? "new"}
          editing={null}
          prefill={prefill}
          defaultConcurrency={app.defaultConcurrency}
          autoFocus
          onClose={closeQuickConnect}
          targetPane={app.quickConnectPane}
        />
      </DialogContent>
    </Dialog>
  );
}
