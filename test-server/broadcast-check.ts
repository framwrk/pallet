import { Readable } from "node:stream";
import type { SessionManager } from "../src/main/services/sftp/session-manager";
import { TransferChannels } from "../src/shared/ipc/ipc.constants";
import type { TransferJobSnapshot } from "../src/shared/transfer/transfer.types";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import { tmpdir } from "node:os";

function window(send: (channel: string, payload: unknown) => void = () => {}): {
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: { destroyed: boolean; isDestroyed: () => boolean; send: typeof send };
} {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      send,
    },
  };
}

let windows: ReturnType<typeof window>[] = [];
mock.module("electron", () => ({ BrowserWindow: { getAllWindows: () => windows } }));
const { broadcast } = await import("../src/main/utils/broadcast");

const mode = process.argv[2];
if (mode === "destroyed" || mode === "send") {
  const payload = { id: "transfer" };
  const deliveries: unknown[][] = [];
  const skippedCalls: string[] = [];
  const failedSends: string[] = [];
  const healthy = window((...args) => deliveries.push(args));
  if (mode === "destroyed") {
    const destroyed = window();
    destroyed.destroyed = true;
    Object.defineProperty(destroyed, "webContents", {
      get: () => {
        skippedCalls.push("window");
        throw new Error("Object has been destroyed");
      },
    });
    const destroyedContents = window(() => skippedCalls.push("webContents"));
    destroyedContents.webContents.destroyed = true;
    windows = [destroyed, destroyedContents, healthy];
  } else {
    const failed = window(() => {
      failedSends.push("send failed");
      throw new Error("send failed");
    });
    const closing = window(() => {
      closing.destroyed = true;
      failedSends.push("window closed");
      throw new Error("Object has been destroyed");
    });
    windows = [failed, closing, healthy];
  }
  assert.doesNotThrow(() => broadcast(TransferChannels.update, payload));
  assert.deepEqual(skippedCalls, [], "destroyed recipients must be skipped before access or send");
  assert.deepEqual(failedSends, mode === "send" ? ["send failed", "window closed"] : []);
  assert.deepEqual(deliveries, [[TransferChannels.update, payload]]);
  assert.equal(deliveries[0][1], payload, "the payload must be forwarded unchanged");
  windows = [];
  assert.doesNotThrow(() => broadcast(TransferChannels.update, payload));
} else if (mode === "transfer") {
  const { TransferQueue } = await import("../src/main/services/transfer/transfer-queue");
  const { makeEndpoint } = await import("../src/main/services/transfer/transfer-endpoint");
  const root = await fs.mkdtemp(join(tmpdir(), "pallet-broadcast-"));
  const sessions = { status: () => "connected", transferConcurrency: () => 1 } as unknown as SessionManager;
  const local = makeEndpoint(sessions, { kind: "local" });
  const source = join(root, "source");
  const dest = join(root, "dest");
  const payload = Buffer.alloc(3 * 256 * 1024, 27);
  let phase = "open";
  let closedAtBytes = 0;
  let conflictSends = 0;
  const reopenedUpdates: TransferJobSnapshot[] = [];
  const completed = Promise.withResolvers<TransferJobSnapshot>();
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const original = window((channel, payload) => {
    if (channel === TransferChannels.conflict) {
      conflictSends++;
      throw new Error("conflict delivery failed");
    }
    const snapshot = payload as TransferJobSnapshot;
    if (snapshot.state === "running" && snapshot.doneBytes > 0) {
      original.destroyed = true;
      original.webContents.destroyed = true;
      windows = [];
      phase = "closing";
      closedAtBytes = snapshot.doneBytes;
      throw new Error("Object has been destroyed");
    }
  });
  windows = [original];

  const queue = new TransferQueue(
    sessions,
    {
      onUpdate: (snapshot) => {
        broadcast(TransferChannels.update, snapshot);
        if (phase === "closing") {
          phase = "closed";
          gates[0].resolve();
        } else if (phase === "closed" && snapshot.doneBytes > closedAtBytes) {
          assert.equal(snapshot.state, "running", "copying must continue with no windows open");
          windows = [window((_channel, payload) => reopenedUpdates.push(payload as TransferJobSnapshot))];
          phase = "reopened";
          gates[1].resolve();
        } else if (phase === "reopened" && reopenedUpdates.some((s) => s.state === "running")) {
          gates[2].resolve();
        }
      },
      onConflict: (prompt) => {
        broadcast(TransferChannels.conflict, prompt);
        queue.resolveConflict(prompt.jobId, "replace", true);
      },
      record: (snapshot) => completed.resolve(snapshot),
    },
    1,
    () => local,
  );

  // Hold each chunk until a progress event exercises the next
  // window state. This also covers broadcasts from the queue's progress ticker.
  const createReadStream = local.createReadStream.bind(local);
  local.createReadStream = async (path, options) => {
    const stream = await createReadStream(path, options);
    return Readable.from(
      (async function* () {
        let i = 0;
        for await (const chunk of stream) {
          for (let offset = 0; offset < chunk.length; offset += 256 * 1024) {
            yield chunk.subarray(offset, offset + 256 * 1024);
            await gates[i++].promise;
          }
        }
      })(),
    );
  };

  try {
    await fs.mkdir(source);
    await fs.mkdir(dest);
    await fs.writeFile(join(source, "file"), payload);
    await fs.writeFile(join(dest, "file"), "original destination");
    queue.enqueue({ from: { kind: "local" }, to: { kind: "local" }, sourceBase: source, destDir: dest, names: ["file"] });
    const result = await completed.promise;
    assert.equal(result.state, "completed", JSON.stringify(result.errors));
    assert.equal(phase, "reopened");
    assert.equal(conflictSends, 1);
    assert.equal(result.doneFiles, 1);
    assert.equal(result.doneBytes, payload.length);
    assert.deepEqual(result.errors, []);
    assert.ok(reopenedUpdates.some((s) => s.state === "running" && s.doneBytes > closedAtBytes));
    assert.equal(reopenedUpdates.at(-1)?.state, "completed");
    assert.deepEqual(await fs.readFile(join(dest, "file")), payload);
    assert.deepEqual(await fs.readdir(dest), ["file"], "no staging files may remain");
  } finally {
    for (const gate of gates) gate.resolve();
    await queue.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
} else {
  assert.fail(`unknown mode: ${mode}`);
}
