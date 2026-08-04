/**
 * TransferQueue (M5): full enumeration before the first byte, .pallet-part
 * staging with atomic rename (§3.4), conflict plan with apply-to-all,
 * pause/cancel/retry, and auto-pause while a session reconnects (§3.3).
 *
 * Electron-free so the Docker integration tests can drive it directly.
 */
import { pipeline } from "stream/promises";
import { Transform, type Readable, type Writable } from "stream";
import type {
  ConflictAction,
  ConflictPrompt,
  TransferError,
  TransferJobSnapshot,
  TransferRequest,
  TransferState,
} from "../../../shared/transfers";
import type { SessionStatusEvent } from "../../../shared/types";
import { keepBothName } from "../../../shared/keep-both";
import { makeEndpoint, joinPath, type TransferEndpoint } from "./endpoints";
import type { SessionManager } from "../session-manager";

const PART_SUFFIX = ".pallet-part";
/**
 * Backstop for the stream path, mirroring the endpoint's META_TIMEOUT_MS.
 *
 * A channel can be dead while the session still reports "connected" — ssh2
 * never calls back on one, so `client.sftp()` and the pipeline both wait
 * forever and the job sits in "running" with a `.pallet-part` on the server.
 * Nothing else catches that: keepalive (45s) only notices a dead *transport*.
 * Sitting above it keeps ordinary drops on the auto-pause path.
 */
const STALL_TIMEOUT_MS = 60_000;

interface PlanFile {
  relPath: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

interface Conflict {
  relPath: string;
  destSize: number;
  destMtimeMs: number;
  action: ConflictAction | null;
}

interface InFlight {
  relPath: string;
  src: Readable | null;
  dst: Writable | null;
  partPath: string | null;
  /** Force-fails the transfer promise; stream destroy alone can hang on a dead channel. */
  abort: ((err: Error) => void) | null;
}

export interface QueueHooks {
  onUpdate(snapshot: TransferJobSnapshot): void;
  onConflict(prompt: ConflictPrompt): void;
  record?(job: TransferJobSnapshot): void;
}

/** Seam for tests: swap in in-memory endpoints instead of disk/SFTP. */
export type EndpointFactory = (sessions: SessionManager, ref: TransferRequest["from"]) => TransferEndpoint;

class Job {
  state: TransferState = "enumerating";
  autoPaused = false;
  userPaused = false;
  canceled = false;
  planDirs: string[] = [];
  planFiles: PlanFile[] = [];
  skippedSymlinks = 0;
  conflicts = new Map<string, Conflict>();
  queue: PlanFile[] = [];
  inFlight = new Map<string, InFlight>();
  doneFiles = 0;
  skippedFiles = 0;
  doneBytes = 0;
  totalBytes = 0;
  errors: TransferError[] = [];
  /** Names already produced per destination directory (keep-both bookkeeping). */
  destNames = new Map<string, Set<string>>();
  samples: { t: number; bytes: number }[] = [];
  lastEmit = 0;
  resumeWaiters: (() => void)[] = [];
  conflictWaiter: (() => void) | null = null;
  from!: TransferEndpoint;
  to!: TransferEndpoint;

  constructor(
    public id: string,
    public request: TransferRequest,
  ) {}

  get label(): string {
    const n = this.request.names.length;
    return `${n} item${n === 1 ? "" : "s"} → ${this.request.destDir}`;
  }
}

export class TransferQueue {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private seq = 0;

  constructor(
    private sessions: SessionManager,
    private hooks: QueueHooks,
    /** Streams per job; capped so sftp meta ops always have a channel. */
    private concurrency = 3,
    private endpointFactory: EndpointFactory = makeEndpoint,
  ) {}

  snapshot(job: Job): TransferJobSnapshot {
    const now = Date.now();
    const windowStart = now - 3000;
    const recent = job.samples.filter((s) => s.t >= windowStart);
    const bytesPerSec =
      recent.length > 1
        ? ((recent[recent.length - 1].bytes - recent[0].bytes) / Math.max(1, recent[recent.length - 1].t - recent[0].t)) * 1000
        : 0;
    return {
      id: job.id,
      state: job.state,
      autoPaused: job.autoPaused,
      label: job.label,
      destDir: job.request.destDir,
      totalFiles: job.planFiles.length,
      doneFiles: job.doneFiles,
      skippedFiles: job.skippedFiles + job.skippedSymlinks,
      totalBytes: job.totalBytes,
      doneBytes: job.doneBytes,
      bytesPerSec,
      currentFiles: [...job.inFlight.keys()],
      errors: job.errors.slice(0, 20),
    };
  }

  snapshots(): TransferJobSnapshot[] {
    return this.order
      .map((id) => this.jobs.get(id))
      .filter((j): j is Job => !!j)
      .map((j) => this.snapshot(j));
  }

  private emit(job: Job, force = false): void {
    const now = Date.now();
    if (!force && now - job.lastEmit < 150) return;
    job.lastEmit = now;
    this.hooks.onUpdate(this.snapshot(job));
  }

  enqueue(request: TransferRequest): string {
    const job = new Job(`t${++this.seq}`, request);
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    void this.run(job);
    return job.id;
  }

  private async run(job: Job): Promise<void> {
    job.from = this.endpointFactory(this.sessions, job.request.from);
    job.to = this.endpointFactory(this.sessions, job.request.to);
    try {
      job.state = "enumerating";
      this.emit(job, true);
      await this.enumerate(job);
      if (job.canceled) return;

      await this.detectConflicts(job);
      if (job.canceled) return;

      if ([...job.conflicts.values()].some((c) => c.action === null)) {
        job.state = "waiting";
        this.emit(job, true);
        await this.promptConflicts(job);
        if (job.canceled) return;
      }

      job.state = "running";
      this.emit(job, true);
      await this.execute(job);

      if (job.canceled) return;
      job.state = job.errors.length > 0 ? "failed" : "completed";
      this.emit(job, true);
    } catch (err) {
      if (!job.canceled) {
        job.errors.push({ relPath: "", message: (err as Error).message });
        job.state = "failed";
        this.emit(job, true);
      }
    } finally {
      job.from.dispose();
      job.to.dispose();
      if (["completed", "failed", "canceled"].includes(job.state)) {
        this.hooks.record?.(this.snapshot(job));
      }
    }
  }

  /** §3.4: enumerate everything before moving a byte. */
  private async enumerate(job: Job): Promise<void> {
    const { sourceBase, names } = job.request;
    const walk = async (relPath: string): Promise<void> => {
      if (job.canceled) return;
      const abs = joinPath(sourceBase, relPath);
      const stat = await job.from.statOrNull(abs);
      if (!stat) throw new Error(`Source disappeared: ${relPath}`);
      if (stat.isSymlink) {
        // §6: symlinks are never followed during recursive operations.
        job.skippedSymlinks++;
        return;
      }
      if (stat.isDir) {
        job.planDirs.push(relPath);
        for (const child of await job.from.listEntries(abs)) {
          await walk(`${relPath}/${child.name}`);
        }
      } else {
        job.planFiles.push({
          relPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          mode: stat.mode,
        });
        job.totalBytes += stat.size;
        this.emit(job);
      }
    };
    for (const name of names) {
      await walk(name);
    }
  }

  /** One readdir per destination directory, then set-membership checks. */
  private async detectConflicts(job: Job): Promise<void> {
    const destDirs = new Set<string>([job.request.destDir]);
    for (const dir of job.planDirs) {
      destDirs.add(joinPath(job.request.destDir, dir));
    }
    const listings = new Map<string, Set<string>>();
    for (const dir of destDirs) {
      listings.set(dir, new Set(await job.to.listNames(dir)));
    }
    job.destNames = listings;
    for (const file of job.planFiles) {
      const slash = file.relPath.lastIndexOf("/");
      const dir = slash === -1 ? job.request.destDir : joinPath(job.request.destDir, file.relPath.slice(0, slash));
      const name = slash === -1 ? file.relPath : file.relPath.slice(slash + 1);
      if (listings.get(dir)?.has(name)) {
        const st = await job.to.statOrNull(joinPath(job.request.destDir, file.relPath));
        if (st?.isDir) {
          job.errors.push({ relPath: file.relPath, message: "A folder with this name exists" });
          job.conflicts.set(file.relPath, {
            relPath: file.relPath,
            destSize: 0,
            destMtimeMs: 0,
            action: "skip",
          });
        } else {
          job.conflicts.set(file.relPath, {
            relPath: file.relPath,
            destSize: st?.size ?? 0,
            destMtimeMs: st?.mtimeMs ?? 0,
            action: null,
          });
        }
      }
    }
  }

  /** Ask the renderer, one prompt at a time; apply-to-all answers the rest. */
  private async promptConflicts(job: Job): Promise<void> {
    for (;;) {
      if (job.canceled) return;
      const next = [...job.conflicts.values()].find((c) => c.action === null);
      if (!next) return;
      const remaining = [...job.conflicts.values()].filter((c) => c.action === null).length;
      const file = job.planFiles.find((f) => f.relPath === next.relPath);
      // Waiter must exist before the hook fires: a listener may respond
      // synchronously (the integration tests do).
      const answered = new Promise<void>((resolve) => {
        job.conflictWaiter = resolve;
      });
      this.hooks.onConflict({
        jobId: job.id,
        relPath: next.relPath,
        source: { size: file?.size ?? 0, mtimeMs: file?.mtimeMs ?? 0 },
        dest: { size: next.destSize, mtimeMs: next.destMtimeMs },
        remaining,
      });
      await answered;
    }
  }

  resolveConflict(jobId: string, action: ConflictAction, applyToAll: boolean): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const undecided = [...job.conflicts.values()].filter((c) => c.action === null);
    if (undecided.length === 0) return;
    undecided[0].action = action;
    if (applyToAll) {
      for (const c of undecided.slice(1)) c.action = action;
    }
    job.conflictWaiter?.();
    job.conflictWaiter = null;
  }

  private async execute(job: Job): Promise<void> {
    // Directories first, shallowest first, so parents exist.
    const dirs = [...job.planDirs].sort((a, b) => a.split("/").length - b.split("/").length);
    await job.to.mkdirp(job.request.destDir);
    for (const dir of dirs) {
      if (job.canceled) return;
      await job.to.mkdirp(joinPath(job.request.destDir, dir));
    }

    job.queue = [...job.planFiles];
    const workers = Array.from({ length: Math.min(this.concurrency, job.queue.length || 1) }, () => this.worker(job));
    await Promise.all(workers);
  }

  private async worker(job: Job): Promise<void> {
    for (;;) {
      if (job.canceled) return;
      if (job.userPaused || job.autoPaused) {
        await new Promise<void>((resolve) => job.resumeWaiters.push(resolve));
        continue;
      }
      const file = job.queue.shift();
      if (!file) return;
      await this.transferFile(job, file);
    }
  }

  private destPathsFor(job: Job, file: PlanFile): { finalPath: string; partPath: string } | "skip" {
    const conflict = job.conflicts.get(file.relPath);
    const slash = file.relPath.lastIndexOf("/");
    const dir = slash === -1 ? job.request.destDir : joinPath(job.request.destDir, file.relPath.slice(0, slash));
    let name = slash === -1 ? file.relPath : file.relPath.slice(slash + 1);

    if (conflict?.action === "skip") return "skip";
    if (conflict?.action === "keepBoth") {
      const names = job.destNames.get(dir) ?? new Set();
      name = keepBothName(names, name);
      names.add(name);
      job.destNames.set(dir, names);
    }
    const finalPath = joinPath(dir, name);
    return { finalPath, partPath: finalPath + PART_SUFFIX };
  }

  private async transferFile(job: Job, file: PlanFile): Promise<void> {
    const target = this.destPathsFor(job, file);
    if (target === "skip") {
      job.skippedFiles++;
      this.emit(job);
      return;
    }
    const { finalPath, partPath } = target;
    const flight: InFlight = { relPath: file.relPath, src: null, dst: null, partPath, abort: null };
    job.inFlight.set(file.relPath, flight);
    this.emit(job, true);

    const aborted = new Promise<never>((_, reject) => {
      flight.abort = reject;
    });

    // Fires only if this file makes no progress at all; every chunk re-arms it.
    let stalled = false;
    let stallTimer: NodeJS.Timeout | null = null;
    const armStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        flight.abort?.(new Error(`Transfer stalled: no progress for ${STALL_TIMEOUT_MS / 1000}s`));
      }, STALL_TIMEOUT_MS);
    };

    const startBytes = job.doneBytes;
    try {
      armStall();
      // Opening races the abort too: acquiring a channel is itself an
      // unbounded wait, and this is where `aborted` gets its first handler.
      const src = await Promise.race([job.from.createReadStream(joinPath(job.request.sourceBase, file.relPath)), aborted]);
      flight.src = src;
      const dst = await Promise.race([job.to.createWriteStream(partPath, file.mode), aborted]);
      flight.dst = dst;

      const counter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          armStall();
          job.doneBytes += chunk.length;
          job.samples.push({ t: Date.now(), bytes: job.doneBytes });
          if (job.samples.length > 200) job.samples.splice(0, 100);
          this.emit(job);
          cb(null, chunk);
        },
      });
      // Race an explicit abort: destroying an sftp stream on a dead
      // connection may never settle the pipeline on its own.
      await Promise.race([pipeline(src, counter, dst), aborted]);

      // §3.4: stamp metadata on the staged file, then atomic rename.
      await job.to.setMeta(partPath, { mtimeMs: file.mtimeMs, mode: file.mode });
      await job.to.renameReplacing(partPath, finalPath);

      // Verification (size; mtime was just set by us).
      const written = await job.to.statOrNull(finalPath);
      if (!written || written.size !== file.size) {
        await job.to.removeFile(finalPath);
        throw new Error(`Size mismatch after transfer of ${file.relPath}`);
      }
      job.doneFiles++;
    } catch (err) {
      // Clean the partial regardless of why we failed.
      await job.to.removeFile(partPath).catch(() => {});
      job.doneBytes = startBytes;

      if (job.canceled) return;
      if (this.isDisconnect(job, err)) {
        // Put the file back and let the session's reconnect revive us.
        job.queue.unshift(file);
        this.setAutoPaused(job, true);
      } else if (job.userPaused || job.autoPaused || stalled) {
        // A stall with the session still up means this channel is dead, not
        // the connection: retry the file on a fresh one rather than pausing
        // for a reconnect that is never going to be announced.
        job.queue.unshift(file);
      } else {
        job.errors.push({ relPath: file.relPath, message: (err as Error).message });
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      job.inFlight.delete(file.relPath);
      this.emit(job, true);
    }
  }

  private isDisconnect(job: Job, err: unknown): boolean {
    const refs = [job.request.from, job.request.to];
    const sftpRefs = refs.filter((r) => r.kind === "sftp");
    if (sftpRefs.length === 0) return false;
    const disconnected = sftpRefs.some((r) => {
      try {
        return this.sessions.status((r as { sessionId: string }).sessionId) !== "connected";
      } catch {
        return true;
      }
    });
    const msg = (err as Error).message ?? "";
    return disconnected || /ENOTCONN|not connected|no response|channel closed/i.test(msg);
  }

  private setAutoPaused(job: Job, value: boolean): void {
    if (job.autoPaused === value) return;
    job.autoPaused = value;
    if (job.state === "running" || job.state === "paused") {
      job.state = value || job.userPaused ? "paused" : "running";
    }
    if (value) {
      // Streams on the dead connection may never reject on their own —
      // destroy them so workers fall into the requeue path deterministically.
      this.abortInFlight(job);
    } else if (!job.userPaused) {
      const waiters = job.resumeWaiters.splice(0);
      for (const w of waiters) w();
    }
    this.emit(job, true);
  }

  /** §3.3: session drops pause affected jobs instead of failing every item. */
  handleSessionStatus(event: SessionStatusEvent): void {
    for (const job of this.jobs.values()) {
      if (!["running", "paused", "waiting", "enumerating"].includes(job.state)) continue;
      const uses = [job.request.from, job.request.to].some((r) => r.kind === "sftp" && r.sessionId === event.sessionId);
      if (!uses) continue;
      if (event.status === "connected") this.setAutoPaused(job, false);
      else if (event.status !== "connecting") this.setAutoPaused(job, true);
    }
  }

  pause(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "running") return;
    job.userPaused = true;
    job.state = "paused";
    this.abortInFlight(job);
    this.emit(job, true);
  }

  resume(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "paused") return;
    job.userPaused = false;
    if (!job.autoPaused) {
      job.state = "running";
      const waiters = job.resumeWaiters.splice(0);
      for (const w of waiters) w();
    }
    this.emit(job, true);
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || ["completed", "failed", "canceled"].includes(job.state)) return;
    job.canceled = true;
    job.state = "canceled";
    this.abortInFlight(job);
    // Unstick any waiters so workers can observe cancellation.
    job.conflictWaiter?.();
    const waiters = job.resumeWaiters.splice(0);
    for (const w of waiters) w();
    this.emit(job, true);
  }

  /** Re-run a failed/canceled job from scratch (restart-only resume, §3.4). */
  retry(jobId: string): void {
    const old = this.jobs.get(jobId);
    if (!old || !["failed", "canceled"].includes(old.state)) return;
    const job = new Job(jobId, old.request);
    this.jobs.set(jobId, job);
    void this.run(job);
  }

  remove(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && !["completed", "failed", "canceled"].includes(job.state)) this.cancel(jobId);
    this.jobs.delete(jobId);
    this.order = this.order.filter((id) => id !== jobId);
  }

  private abortInFlight(job: Job): void {
    for (const flight of job.inFlight.values()) {
      flight.src?.destroy();
      flight.dst?.destroy();
      flight.abort?.(new Error("Transfer interrupted"));
    }
  }
}
