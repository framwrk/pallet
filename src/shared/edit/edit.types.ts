/**
 * "Edit in external editor" notifications pushed to the renderer.
 *
 * This file must stay dependency-free: no Node imports, no Electron imports.
 */

export interface EditEventPayload {
  kind: "uploaded" | "error";
  remotePath: string;
  localPath: string;
  message?: string;
}
