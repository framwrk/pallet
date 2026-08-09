import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { answerConflict, useTransfers } from "@/store/transfer.store";
import { formatBytes, formatModified } from "@/lib/format.utils";
import { Button } from "@/components/ui/button";
import { FileWarning } from "lucide-react";
import { useState } from "react";

function Facts({ title, size, mtimeMs }: { title: string; size: number; mtimeMs: number }): React.JSX.Element {
  return (
    <div className="bg-muted rounded-md p-2">
      <div className="text-muted-foreground text-[11px] font-medium">{title}</div>
      <div className="text-xs">
        {formatBytes(size)} · {formatModified(mtimeMs)}
      </div>
    </div>
  );
}

/** Replace / Skip / Keep Both with apply-to-all (§2.1 Conflicts). */
export function ConflictDialog(): React.JSX.Element | null {
  const { prompts } = useTransfers();
  const prompt = prompts[0];
  const [applyToAll, setApplyToAll] = useState(false);
  if (!prompt) return null;

  const answer = (action: "replace" | "skip" | "keepBoth"): void => {
    answerConflict(action, applyToAll);
    setApplyToAll(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && answer("skip")}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileWarning className="size-5 text-amber-500" />
            An item named “{prompt.relPath.split("/").pop()}” already exists
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground text-xs">{prompt.relPath}</p>
          <div className="grid grid-cols-2 gap-2">
            <Facts
              title="Copying"
              size={prompt.source.size}
              mtimeMs={prompt.source.mtimeMs}
            />
            <Facts
              title="Existing"
              size={prompt.dest.size}
              mtimeMs={prompt.dest.mtimeMs}
            />
          </div>
          {prompt.remaining > 1 && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
              />
              Apply to all {prompt.remaining} remaining conflicts
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => answer("skip")}
            >
              Skip
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => answer("keepBoth")}
            >
              Keep Both
            </Button>
            <Button
              size="sm"
              onClick={() => answer("replace")}
            >
              Replace
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
