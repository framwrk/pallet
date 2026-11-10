import { expect, test } from "bun:test";
import { FolderSizes } from "../src/main/services/folder-size.service";
import type { SessionManager } from "../src/main/services/sftp/session-manager";

test("remote folder totals exclude directory metadata and never follow symlinks", async () => {
  const visited: string[] = [];
  const sessions = {
    protocol: () => "sftp",
    duApparentBytes: () => undefined,
    setDuApparentBytes: () => {},
    exec: async () => ({ stdout: "8206\t/tree\n" }),
    acquireTransferChannel: async () => ({
      sftp: {
        readdir: (path: string, callback: (error: Error | null, entries: object[]) => void) => {
          visited.push(path);
          callback(
            null,
            path === "/tree"
              ? [
                  { filename: "child.txt", attrs: { size: 14, mode: 0o100644 } },
                  { filename: "empty", attrs: { size: 4096, mode: 0o040755 } },
                  { filename: "link", attrs: { size: 7, mode: 0o120777 } },
                ]
              : [],
          );
        },
      },
      release: () => {},
    }),
  } as unknown as SessionManager;
  const sizes = new FolderSizes(sessions);
  expect(await sizes.get({ kind: "sftp", sessionId: "test" }, "/tree")).toBe(21);
  expect(visited).toEqual(["/tree", "/tree/empty"]);
});
