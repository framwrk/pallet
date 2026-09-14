import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getState, navigate, setGoToOpen, useAppState } from "@/store/pane.store";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { localPath } from "@shared/path/path.utils";

/** ⌘⇧G "Go to Folder" dialog, navigating the active pane. */
export function GoToDialog(): React.JSX.Element {
  const app = useAppState();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    const target = inputRef.current?.value.trim() ?? "";
    if (!target) {
      setGoToOpen(false);
      return;
    }
    setError(null);
    void navigate(app.active, localPath.normalize(target)).then((ok) => {
      if (ok) {
        setGoToOpen(false);
        return;
      }
      // Keep the dialog open with the typed path so it can be corrected or retried.
      setError(getState().panes[app.active].error?.message ?? "Couldn’t open that path");
    });
  }

  return (
    <Dialog
      open={app.goToOpen}
      onOpenChange={(open) => {
        setGoToOpen(open);
        if (open) setError(null);
      }}
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
            aria-invalid={error ? true : undefined}
          />
          {error && (
            <p
              className="text-destructive text-xs"
              role="alert"
            >
              {error}
            </p>
          )}
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
