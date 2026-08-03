import { useEffect, useState } from "react";
import { ArrowDownToLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UpdateInfo {
  version: string;
  url: string;
  prerelease: boolean;
}

/** §7: non-modal update notice, never a modal on launch. */
export function UpdateToast(): React.JSX.Element | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return window.pallet.app.onUpdateAvailable((update) => {
      setInfo(update);
      setDismissed(false);
    });
  }, []);

  if (!info || dismissed) return null;
  return (
    <div className="bg-popover fixed right-3 bottom-24 z-50 flex w-80 items-start gap-2 rounded-lg border p-3 text-sm shadow-lg">
      <ArrowDownToLine className="text-primary mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          Pallet {info.version} is available
          {info.prerelease ? " (beta)" : ""}
        </p>
        <Button
          size="xs"
          className="mt-2"
          onClick={() => void window.pallet.app.openExternal(info.url)}
        >
          View release
        </Button>
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
