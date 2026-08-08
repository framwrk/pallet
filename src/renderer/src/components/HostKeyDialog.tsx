import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShieldAlert, ShieldQuestion } from "lucide-react";
import { shiftHostKeyPrompt, useAppState } from "@/store/panes";
import { Button } from "@/components/ui/button";

/**
 * TOFU verification (§2.1 Host keys): first contact shows the fingerprint;
 * a changed fingerprint is a blocking-but-overridable warning.
 */
export function HostKeyDialog(): React.JSX.Element | null {
  const { hostKeyPrompts } = useAppState();
  const prompt = hostKeyPrompts[0];
  if (!prompt) return null;

  const mismatch = prompt.status === "mismatch";

  function respond(trust: boolean): void {
    void window.pallet.hostKeys.respond(prompt.requestId, trust);
    shiftHostKeyPrompt();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && respond(false)}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mismatch ? (
              <ShieldAlert className="text-destructive size-5" />
            ) : (
              <ShieldQuestion className="size-5 text-amber-500" />
            )}
            {mismatch ? "Host Key Changed" : "Unknown Host"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          {mismatch ? (
            <p>
              The identity of{" "}
              <span className="font-semibold">
                {prompt.host}:{prompt.port}
              </span>{" "}
              has <span className="text-destructive font-semibold">changed</span>. This can mean the server was rebuilt — or
              that the connection is being intercepted. Only continue if you can explain the change.
            </p>
          ) : (
            <p>
              First connection to{" "}
              <span className="font-semibold">
                {prompt.host}:{prompt.port}
              </span>
              . Verify the fingerprint before trusting it.
            </p>
          )}
          <div className="bg-muted rounded-md p-2 font-mono text-xs break-all">
            <div className="text-muted-foreground">{prompt.keyType}</div>
            <div>{prompt.fingerprint}</div>
            {mismatch && prompt.knownFingerprint && (
              <div className="text-muted-foreground mt-1 line-through">{prompt.knownFingerprint}</div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => respond(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant={mismatch ? "destructive" : "default"}
              onClick={() => respond(true)}
            >
              {mismatch ? "Trust New Key" : "Trust"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
