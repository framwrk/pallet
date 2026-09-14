import { ArrowDownToLine, X } from "lucide-react";
import type { UpdateDownloadState, UpdateInfo } from "@shared/update/update.types";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format.utils";
import { pushToast } from "@/store/pane.store";

/** §7: non-modal update notice, never a modal on launch. */
export function UpdateToast(): React.JSX.Element | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [download, setDownload] = useState<UpdateDownloadState | null>(null);

  useEffect(() => {
    const offState = window.pallet.app.onUpdateDownloadState((state) => {
      setDownload(state);
      // Failure surfaces as a regular toast; the notice returns to its idle state.
      if (state.status === "error") pushToast(`Update download failed: ${state.error}`, "error");
    });
    return () => {
      offState();
    };
  }, []);

  useEffect(() => {
    return window.pallet.app.onUpdateAvailable((update) => {
      setInfo(update);
      setDismissed(false);
    });
  }, []);

  if (!info || dismissed) return null;

  const pct = download && download.totalBytes > 0 ? download.receivedBytes / download.totalBytes : null;

  return (
    <div className="bg-popover fixed right-3 bottom-24 z-50 flex w-80 items-start gap-2 rounded-lg border p-3 text-sm shadow-lg">
      <ArrowDownToLine className="text-primary mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          Pallet {info.version} is available
          {info.prerelease ? " (beta)" : ""}
        </p>
        {download?.status === "downloading" ? (
          <div className="mt-2">
            <div className="bg-accent h-1 overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-[width] duration-150"
                style={{ width: `${pct === null ? 4 : Math.max(4, Math.round(pct * 100))}%` }}
              />
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {download.totalBytes > 0
                ? `${formatBytes(download.receivedBytes)} of ${formatBytes(download.totalBytes)}`
                : `${formatBytes(download.receivedBytes)}`}
            </p>
          </div>
        ) : download?.status === "done" ? (
          <p className="text-muted-foreground mt-2 text-xs">Saved to Downloads and opened — drag Pallet into Applications.</p>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            {info.dmgUrl ? (
              <Button
                size="xs"
                onClick={() => {
                  setDownload({ status: "downloading", version: info.version, receivedBytes: 0, totalBytes: 0 });
                  void window.pallet.app.downloadUpdate(info);
                }}
              >
                Download update
              </Button>
            ) : (
              <Button
                size="xs"
                onClick={() => void window.pallet.app.openExternal(info.url)}
              >
                View release
              </Button>
            )}
          </div>
        )}
      </div>
      <button
        className="hover:bg-accent shrink-0 rounded p-0.5"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
