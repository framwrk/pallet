import { BrowserWindow, Menu, type IpcMainInvokeEvent } from "electron";
import type { ContextMenuItem } from "../../shared/types";

/** Show a native context menu; resolves with the clicked item id, or null. */
export function popupContextMenu(event: IpcMainInvokeEvent, items: ContextMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (id: string | null): void => {
      if (!resolved) {
        resolved = true;
        resolve(id);
      }
    };
    const menu = Menu.buildFromTemplate(
      items.map((it) =>
        it.type === "separator"
          ? { type: "separator" as const }
          : {
              label: it.label ?? "",
              enabled: it.enabled !== false,
              click: () => done(it.id ?? null),
            },
      ),
    );
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    menu.popup({
      window,
      // Menu closed without a click: give a pending click handler one tick.
      callback: () => setTimeout(() => done(null), 0),
    });
  });
}
