import { type PaneBackend, sizeTarget, useAppState } from "@/store/panes";
import { useEffect, useState } from "react";
import type { Entry } from "@shared/types";

/**
 * How long the visible range must hold still before sizes are requested.
 * Without it a fast scroll would issue and cancel a request per folder per
 * frame; with it, only what you actually stopped on gets walked.
 */
const SETTLE_MS = 150;

const EMPTY: ReadonlyMap<string, number> = new Map();

/** Symlinks are excluded on purpose: sizing one would mean following it. */
export function isSizeable(entry: Entry): boolean {
  return entry.kind === "dir";
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * Totals for the folders at `paths`, keyed by path. A path is absent from the
 * map until its total is known, which is what keeps the column showing "--".
 * Requests stop when the preference is off, and anything still queued is
 * cancelled when the paths change or the component unmounts.
 */
export function useFolderSizes(paths: readonly string[], backend: PaneBackend): ReadonlyMap<string, number> {
  const app = useAppState();
  // Remote sizing is a second opt-in under the same switch, so a remote pane
  // needs both; a local pane needs only the first.
  const enabled = app.calculateFolderSizes && (backend.kind === "local" || app.calculateRemoteFolderSizes);
  // Totals are tagged with the backend they came from. A pane that switches
  // between local and a server keeps this state, and paths like /etc or /opt
  // exist on both — tagging means the old backend's totals are simply never
  // returned, with no reset to sequence.
  const [sizes, setSizes] = useState<{ backendKey: string; map: ReadonlyMap<string, number> }>({
    backendKey: "",
    map: EMPTY,
  });
  // A string so the effect compares by content; the array is rebuilt every
  // render, and on scroll that is every frame.
  const key = useDebounced(enabled ? paths.join("\n") : "", SETTLE_MS);
  const backendKey = backend.kind === "sftp" ? backend.sessionId : "local";

  useEffect(() => {
    if (key === "") return;
    const wanted = key.split("\n");
    const target = sizeTarget(backend);
    let stale = false;
    for (const path of wanted) {
      window.pallet.folderSize.get(target, path).then(
        (total) => {
          if (stale || total === null) return;
          setSizes((prev) => {
            const map = prev.backendKey === backendKey ? prev.map : EMPTY;
            if (map.get(path) === total) return prev;
            return { backendKey, map: new Map(map).set(path, total) };
          });
        },
        () => {
          // Disconnected mid-walk, or the folder went away: leave it at "--".
        },
      );
    }
    return () => {
      stale = true;
      for (const path of wanted) void window.pallet.folderSize.cancel(target, path);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- backendKey stands in for backend
  }, [key, backendKey]);

  // Turning either preference off has to put the column back to "--", and
  // totals already resolved would otherwise linger in state.
  return enabled && sizes.backendKey === backendKey ? sizes.map : EMPTY;
}
