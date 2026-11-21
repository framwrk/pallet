import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { closeQuickConnect, useAppState } from "@/store/pane.store";
import { ConnectForm } from "./ConnectForm";
import { EthernetPort } from "lucide-react";

/**
 * Opens over the workspace from Connect to Server, Command-K, or a favorite
 * that needs credentials. The current session remains visible until replaced.
 */
export function ConnectDialog(): React.JSX.Element {
  const app = useAppState();
  const prefill = app.quickConnectPrefill;

  return (
    <Dialog
      open={app.quickConnectOpen}
      onOpenChange={(open) => {
        if (!open) closeQuickConnect();
      }}
    >
      <DialogContent className="max-h-[85vh] gap-4 overflow-y-auto p-4 sm:max-w-lg">
        <DialogHeader className="pr-10">
          <div className="flex items-center gap-2.5">
            <div className="bg-primary/10 text-primary ring-primary/15 flex size-8 shrink-0 items-center justify-center rounded-[9px] ring-1">
              <EthernetPort className="size-4" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-[13px] font-semibold tracking-[-0.01em]">Connect to a server</DialogTitle>
              <DialogDescription className="mt-0.5 text-[11px]">FTP, FTPS, SFTP, S3, or SMB</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <ConnectForm
          key={prefill?.id ?? "new"}
          editing={null}
          prefill={prefill}
          defaultConcurrency={app.defaultConcurrency}
          defaultKeepaliveSeconds={app.defaultKeepaliveSeconds}
          autoFocus
          onClose={closeQuickConnect}
          targetPane={app.quickConnectPane}
        />
      </DialogContent>
    </Dialog>
  );
}
