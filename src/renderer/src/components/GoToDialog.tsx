import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { navigate, setGoToOpen, useAppState } from "@/store/panes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localPath } from "@shared/paths";
import { useRef } from "react";

/** ⌘⇧G "Go to Folder" dialog, navigating the active pane. */
export function GoToDialog(): React.JSX.Element {
  const app = useAppState();
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(): void {
    const target = inputRef.current?.value.trim() ?? "";
    setGoToOpen(false);
    if (target) void navigate(app.active, localPath.normalize(target));
  }

  return (
    <Dialog
      open={app.goToOpen}
      onOpenChange={setGoToOpen}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Go to Folder</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {/* Dialog content unmounts when closed, so defaultValue re-seeds per open. */}
          <Input
            ref={inputRef}
            autoFocus
            defaultValue={app.panes[app.active].cwd}
            placeholder="/Users/…"
            spellCheck={false}
            className="font-mono text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setGoToOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit">Go</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
