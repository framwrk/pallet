import { closeQuickConnect, useAppState } from "@/store/pane.store";
import { ConnectForm } from "./ConnectForm";
import { EthernetPort } from "lucide-react";

/**
 * Fills the right pane whenever there is no server to browse: at launch, after
 * a disconnect, or when a favorite needs its password typed in.
 */
export function QuickConnect(): React.JSX.Element {
  const app = useAppState();
  const prefill = app.quickConnectPrefill;
  // Only offer a way out when there is a live session behind the form.
  const dismissable = app.panes.right.backend.kind === "sftp";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-10">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <EthernetPort className="size-10 text-emerald-500" />
          <h2 className="text-lg font-medium">Connect via SFTP</h2>
        </div>
        {/* Keyed so a favorite prefill reseeds the fields. */}
        <ConnectForm
          key={prefill?.id ?? "new"}
          editing={null}
          prefill={prefill}
          defaultConcurrency={app.defaultConcurrency}
          autoFocus={prefill !== null}
          onClose={dismissable ? closeQuickConnect : undefined}
        />
      </div>
    </div>
  );
}
