import { Readable } from "node:stream";
import type { TransferEndpoint } from "../src/main/services/transfer/transfer-endpoint";
import assert from "node:assert/strict";
import { digestEndpoint } from "../src/main/services/transfer/transfer-verification";
import { test } from "node:test";

for (const [bytes, expected] of [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
]) {
  test(`streamed SHA-256 known digest: ${bytes || "empty"}`, async () => {
    const endpoint = { createReadStream: async () => Readable.from([Buffer.from(bytes)]) } as unknown as TransferEndpoint;
    let checked = 0;
    assert.equal(
      await digestEndpoint(endpoint, "/file", bytes.length, new AbortController().signal, (n) => (checked += n)),
      expected,
    );
    assert.equal(checked, bytes.length);
  });
}

test("canceling a pending digest acquisition destroys a late stream", async () => {
  let release!: (stream: Readable) => void;
  const endpoint = {
    createReadStream: () => new Promise<Readable>((resolve) => (release = resolve)),
  } as unknown as TransferEndpoint;
  const controller = new AbortController();
  const pending = digestEndpoint(endpoint, "/file", 3, controller.signal, () => {});
  controller.abort(new Error("Canceled digest"));
  await assert.rejects(pending, /Canceled digest/);
  const late = new Readable({
    read() {
      /* Late acquisition must be destroyed without reading. */
    },
  });
  release(late);
  await new Promise((resolve) => setImmediate(resolve));
  assert(late.destroyed);
});
