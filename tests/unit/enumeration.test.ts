/**
 * §8 unit: the recursive-enumeration planner. Runs the real TransferQueue
 * against in-memory endpoints, so the plan (file count, byte total, symlink
 * handling, ordering) is checked without a server or a disk.
 */
import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "stream";
import type { TransferJobSnapshot } from "../../src/shared/transfers";
import type { SessionManager } from "../../src/main/services/session-manager";
import type { EndpointStat, TransferEndpoint } from "../../src/main/services/transfer/endpoints";
import { TransferQueue } from "../../src/main/services/transfer/queue";

interface FakeNode {
  kind: "file" | "dir" | "symlink";
  size?: number;
  mtimeMs?: number;
  mode?: number;
}

/** Flat path → node map, e.g. { '/src': dir, '/src/a.txt': file }. */
type Tree = Record<string, FakeNode>;

function statOf(node: FakeNode): EndpointStat {
  return {
    size: node.size ?? 0,
    mtimeMs: node.mtimeMs ?? 1_700_000_000_000,
    mode: node.mode ?? 0o644,
    isDir: node.kind === "dir",
    isSymlink: node.kind === "symlink",
  };
}

class FakeEndpoint implements TransferEndpoint {
  kind = "local" as const;
  written: string[] = [];
  renamed: [string, string][] = [];
  madeDirs: string[] = [];

  constructor(private tree: Tree) {}

  async statOrNull(p: string): Promise<EndpointStat | null> {
    const node = this.tree[p];
    return node ? statOf(node) : null;
  }

  private childrenOf(dir: string): string[] {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    return Object.keys(this.tree).filter((p) => p.startsWith(prefix) && p !== dir && !p.slice(prefix.length).includes("/"));
  }

  async listNames(dir: string): Promise<string[]> {
    return this.childrenOf(dir).map((p) => p.slice(p.lastIndexOf("/") + 1));
  }

  async listEntries(dir: string): Promise<{ name: string; stat: EndpointStat }[]> {
    return this.childrenOf(dir).map((p) => ({
      name: p.slice(p.lastIndexOf("/") + 1),
      stat: statOf(this.tree[p]),
    }));
  }

  async mkdirp(p: string): Promise<void> {
    this.madeDirs.push(p);
    this.tree[p] = { kind: "dir" };
  }

  async createReadStream(p: string): Promise<PassThrough> {
    const stream = new PassThrough();
    stream.end(Buffer.alloc(this.tree[p]?.size ?? 0));
    return stream;
  }

  async createWriteStream(p: string): Promise<Writable> {
    this.written.push(p);
    let received = 0;
    return new Writable({
      write: (chunk: Buffer, _e, cb) => {
        received += chunk.length;
        // Record the real byte count: the queue verifies size after renaming,
        // and a fake that lies about it would mask a genuine regression.
        this.tree[p] = { kind: "file", size: received };
        cb();
      },
    });
  }

  async setMeta(): Promise<void> {
    // The planner tests don't assert on mtime/mode stamping.
  }

  async renameReplacing(from: string, to: string): Promise<void> {
    this.renamed.push([from, to]);
    this.tree[to] = this.tree[from] ?? { kind: "file", size: 0 };
  }

  async removeFile(p: string): Promise<void> {
    delete this.tree[p];
  }

  dispose(): void {
    // No resources to release.
  }
}

async function planFor(
  source: Tree,
  dest: Tree,
  names: string[],
): Promise<{ snapshot: TransferJobSnapshot; to: FakeEndpoint }> {
  const from = new FakeEndpoint(source);
  const to = new FakeEndpoint(dest);
  const queue = new TransferQueue(
    null as unknown as SessionManager,
    { onUpdate: () => {}, onConflict: () => {} },
    3,
    (_sessions, ref) => ((ref as { role?: string }).role === "to" ? to : from),
  );
  const id = queue.enqueue({
    // `role` rides along so the fake factory can tell the two sides apart.
    from: { kind: "local", role: "from" } as never,
    to: { kind: "local", role: "to" } as never,
    sourceBase: "/src",
    names,
    destDir: "/dst",
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    const snapshot = queue.snapshots().find((s) => s.id === id)!;
    if (["completed", "failed", "canceled"].includes(snapshot.state)) return { snapshot, to };
    if (Date.now() > deadline) throw new Error(`stuck in ${snapshot.state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("recursive enumeration planner", () => {
  test("counts every file and sums bytes before transferring", async () => {
    const { snapshot } = await planFor(
      {
        "/src": { kind: "dir" },
        "/src/tree": { kind: "dir" },
        "/src/tree/a.txt": { kind: "file", size: 100 },
        "/src/tree/deep": { kind: "dir" },
        "/src/tree/deep/b.txt": { kind: "file", size: 250 },
        "/src/tree/deep/c.txt": { kind: "file", size: 650 },
      },
      { "/dst": { kind: "dir" } },
      ["tree"],
    );
    expect(snapshot.state).toBe("completed");
    expect(snapshot.totalFiles).toBe(3);
    expect(snapshot.totalBytes).toBe(1000);
    expect(snapshot.doneFiles).toBe(3);
  });

  test("symlinks are counted as skipped, never followed", async () => {
    const { snapshot, to } = await planFor(
      {
        "/src": { kind: "dir" },
        "/src/tree": { kind: "dir" },
        "/src/tree/real.txt": { kind: "file", size: 10 },
        "/src/tree/link": { kind: "symlink" },
        "/src/tree/dirlink": { kind: "symlink" },
      },
      { "/dst": { kind: "dir" } },
      ["tree"],
    );
    expect(snapshot.totalFiles).toBe(1);
    expect(snapshot.skippedFiles).toBe(2);
    expect(to.written.some((p) => p.includes("link"))).toBe(false);
  });

  test("a single file needs no directory in the plan", async () => {
    const { snapshot, to } = await planFor(
      { "/src": { kind: "dir" }, "/src/solo.bin": { kind: "file", size: 42 } },
      { "/dst": { kind: "dir" } },
      ["solo.bin"],
    );
    expect(snapshot.totalFiles).toBe(1);
    expect(snapshot.totalBytes).toBe(42);
    expect(to.madeDirs).toEqual(["/dst"]);
  });

  test("every file stages to .pallet-part and is renamed into place", async () => {
    const { to } = await planFor(
      { "/src": { kind: "dir" }, "/src/x.txt": { kind: "file", size: 5 } },
      { "/dst": { kind: "dir" } },
      ["x.txt"],
    );
    expect(to.written).toEqual(["/dst/x.txt.pallet-part"]);
    expect(to.renamed).toEqual([["/dst/x.txt.pallet-part", "/dst/x.txt"]]);
  });

  test("parent directories are created before their children", async () => {
    const { to } = await planFor(
      {
        "/src": { kind: "dir" },
        "/src/t": { kind: "dir" },
        "/src/t/deep": { kind: "dir" },
        "/src/t/deep/deeper": { kind: "dir" },
        "/src/t/deep/deeper/f.txt": { kind: "file", size: 1 },
      },
      { "/dst": { kind: "dir" } },
      ["t"],
    );
    const depth = (p: string): number => p.split("/").length;
    for (let i = 1; i < to.madeDirs.length; i++) {
      expect(depth(to.madeDirs[i])).toBeGreaterThanOrEqual(depth(to.madeDirs[i - 1]));
    }
    expect(to.madeDirs).toContain("/dst/t/deep/deeper");
  });

  test("a vanished source fails the job instead of transferring a partial plan", async () => {
    const { snapshot } = await planFor({ "/src": { kind: "dir" } }, { "/dst": { kind: "dir" } }, ["ghost.txt"]);
    expect(snapshot.state).toBe("failed");
    expect(snapshot.errors[0].message).toContain("Source disappeared");
  });
});
