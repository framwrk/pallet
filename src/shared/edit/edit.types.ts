export interface EditEventPayload {
  kind: "uploaded" | "error";
  remotePath: string;
  localPath: string;
  message?: string;
}
