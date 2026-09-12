/**
 * TransferQueue: bounded folder transfers, unique staging files verified before
 * replacement, checkpointed local/SFTP copies, and pause/cancel/retry recovery.
 *
 * Electron-free so the Docker integration tests can drive it directly.
 */
import type {
  ConflictAction,
  ConflictPrompt,
  TransferError,
  TransferJobSnapshot,
  TransferRequest,
  TransferState,
} from "@shared/transfer/transfer.types";
import { type EndpointStat, type TransferEndpoint, joinPath, makeEndpoint } from "./transfer-endpoint";
import { PART_SUFFIX, TERMINAL_TRANSFER_STATES } from "@shared/transfer/transfer.constants";
import { type Readable, Transform, type Writable } from "stream";
import type { SessionManager } from "../sftp/session-manager";
import type { SessionStatusEvent } from "@shared/sftp/sftp.types";
import { keepBothName } from "@shared/transfer/transfer.utils";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";

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
/** Guard against retrying one file forever when its channel keeps dying. */
const MAX_CHANNEL_RETRIES = 5;
/**
 * Live-progress cadence: the queue's own emits are throttled and bursty, so a
 * ticker re-broadcasts every running job at this interval with the true
 * counters — the bar tracks bytes actually transferred, not chunk bursts.
 */
const PROGRESS_TICK_MS = 100;
const CHUNK_SIZE = 8 * 1024 * 1024;
const CHUNK_THRESHOLD = 16 * 1024 * 1024;

interface PlanFile {
  relPath: string;
  size: number;
  mtimeMs: number;
  mode: number;
  checkpoint: number;
  versionCaptured?: boolean;
  target?: { finalPath: string; partPath: string };
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
  controller: AbortController;
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
  /** Per-file count of retries after a dead channel, capped so it can't spin. */
  retries = new Map<string, number>();
  samples: { t: number; bytes: number }[] = [];
  lastEmit = 0;
  resumeWaiters: (() => void)[] = [];
  conflictWaiter: (() => void) | null = null;
  settled: Promise<void> = Promise.resolve();
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
  private activeSessions = new Set<string>();
  private slotWaiters: (() => void)[] = [];
  /** Re-broadcasts running jobs at PROGRESS_TICK_MS; lives while any job is running. */
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    private sessions: SessionManager,
    private hooks: QueueHooks,
    /** Streams per job; capped so sftp meta ops always have a channel. */
    private concurrency = 7,
    private endpointFactory: EndpointFactory = makeEndpoint,
  ) {}

  /** Bytes/second over the trailing 3 s sample window. */
  private bytesPerSecOf(job: Job): number {
    const now = Date.now();
    const windowStart = now - 3000;
    const recent = job.samples.filter((s) => s.t >= windowStart);
    if (recent.length < 2) return 0;
    return (
      ((recent[recent.length - 1].bytes - recent[0].bytes) / Math.max(1, recent[recent.length - 1].t - recent[0].t)) * 1000
    );
  }

  snapshot(job: Job): TransferJobSnapshot {
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
      bytesPerSec: this.bytesPerSecOf(job),
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
    if (this.jobs.get(job.id) !== job) return;
    const now = Date.now();
    if (!force && now - job.lastEmit < 150) return;
    job.lastEmit = now;
    this.hooks.onUpdate(this.snapshot(job));
    if (job.state === "running") this.startProgressTicker();
    else this.maybeStopProgressTicker();
  }

  /**
   * Re-broadcast every running job at PROGRESS_TICK_MS with the true counters,
   * so the bar tracks bytes actually transferred instead of the chunk bursts
   * the throttled emits produce. No estimation: if 4 MB of 100 MB have been
   * written, the bar shows 4%.
   */
  private startProgressTicker(): void {
    if (this.ticker) return;
    const tick = (): void => {
      const running = [...this.jobs.values()].filter((j) => j.state === "running");
      for (const job of running) this.hooks.onUpdate(this.snapshot(job));
      if (running.length === 0) this.maybeStopProgressTicker();
    };
    this.ticker = setInterval(tick, PROGRESS_TICK_MS);
    this.ticker.unref?.();
  }

  /** Stop the ticker unless a state flip in this tick revived a running job. */
  private maybeStopProgressTicker(): void {
    if (!this.ticker || [...this.jobs.values()].some((j) => j.state === "running")) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  enqueue(request: TransferRequest): string {
    const job = new Job(`t${++this.seq}`, request);
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    job.settled = this.run(job);
    return job.id;
  }

  /** Reserve all sessions together so opposite-direction jobs cannot deadlock. */
  private async acquireJobSlot(job: Job): Promise<() => void> {
    const ids = [...new Set([job.request.from, job.request.to].flatMap((ref) => (ref.kind === "sftp" ? [ref.sessionId] : [])))];
    while (!job.canceled && ids.some((id) => this.activeSessions.has(id))) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    if (job.canceled) return () => {};
    for (const id of ids) this.activeSessions.add(id);
    return () => {
      for (const id of ids) this.activeSessions.delete(id);
      for (const wake of this.slotWaiters.splice(0)) wake();
    };
  }

  private async run(job: Job): Promise<void> {
    const release = await this.acquireJobSlot(job);
    try {
      if (job.canceled) return;
      job.from = this.endpointFactory(this.sessions, job.request.from);
      job.to = this.endpointFactory(this.sessions, job.request.to);
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
      job.state = job.autoPaused ? "paused" : "running";
      this.emit(job, true);
      await this.execute(job);
      if (!job.canceled) job.state = job.errors.length > 0 ? "failed" : "completed";
    } catch (err) {
      if (!job.canceled) {
        job.errors.push({ relPath: "", message: (err as Error).message });
        job.state = "failed";
      }
    } finally {
      // Cleanup only this job's unique staging files, after all writers stopped.
      if (job.to) {
        for (const file of job.planFiles) {
          if (file.target) await job.to.removeFile(file.target.partPath).catch(() => {});
        }
      }
      job.from?.dispose();
      job.to?.dispose();
      release();
      this.emit(job, true);
      if (TERMINAL_TRANSFER_STATES.includes(job.state)) this.hooks.record?.(this.snapshot(job));
    }
  }

  private async ready(job: Job): Promise<void> {
    while (!job.canceled) {
      if (this.sessionDown(job)) this.setAutoPaused(job, true);
      if (!job.userPaused && !job.autoPaused) return;
      await new Promise<void>((resolve) => job.resumeWaiters.push(resolve));
    }
    throw new Error("Transfer canceled");
  }

  /** Retry metadata too: outages during a large folder scan must not lose the job. */
  private async operation<T>(job: Job, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.ready(job);
      try {
        return await fn();
      } catch (err) {
        if (job.canceled) throw err;
        if (this.sessionDown(job)) {
          this.setAutoPaused(job, true);
          continue;
        }
        if (!this.isChannelError(err) || attempt >= MAX_CHANNEL_RETRIES) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 4000)));
      }
    }
  }

  /** §3.4: enumerate everything before moving a byte. */
  private async enumerate(job: Job): Promise<void> {
    const { sourceBase, names } = job.request;
    const walk = async (relPath: string, knownStat?: EndpointStat): Promise<void> => {
      if (job.canceled) return;
      const abs = joinPath(sourceBase, relPath);
      await this.ready(job);
      const stat = knownStat ?? (await this.operation(job, () => job.from.statOrNull(abs)));
      if (!stat) throw new Error(`Source disappeared: ${relPath}`);
      if (stat.isSymlink) {
        // §6: symlinks are never followed during recursive operations.
        job.skippedSymlinks++;
        return;
      }
      if (stat.isDir) {
        job.planDirs.push(relPath);
        for (const child of await this.operation(job, () => job.from.listEntries(abs))) {
          if (!child.name || child.name === "." || child.name === ".." || child.name.includes("/")) {
            throw new Error(`Invalid directory entry: ${child.name}`);
          }
          await walk(`${relPath}/${child.name}`, child.stat);
        }
      } else {
        job.planFiles.push({
          relPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          mode: stat.mode,
          checkpoint: 0,
        });
        job.totalBytes += stat.size;
        this.emit(job);
      }
    };
    for (const name of new Set(names)) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
        throw new Error("Invalid source name");
      await walk(name);
    }
  }

  /** One readdir per destination directory, then set-membership checks. */
  private async detectConflicts(job: Job): Promise<void> {
    await this.operation(job, () => job.to.mkdirp(job.request.destDir));
    const listings = new Map<string, Map<string, EndpointStat>>();
    const list = async (dir: string): Promise<Map<string, EndpointStat>> =>
      new Map((await this.operation(job, () => job.to.listEntries(dir))).map((entry) => [entry.name, entry.stat]));
    listings.set(job.request.destDir, await list(job.request.destDir));
    // Parents precede children. Absent directories need no remote listing.
    for (const rel of job.planDirs) {
      const dir = joinPath(job.request.destDir, rel);
      const slash = rel.lastIndexOf("/");
      const parent = slash < 0 ? job.request.destDir : joinPath(job.request.destDir, rel.slice(0, slash));
      const existing = listings.get(parent)?.get(rel.slice(slash + 1));
      if (existing && (!existing.isDir || existing.isSymlink)) throw new Error(`Destination is not a regular folder: ${rel}`);
      listings.set(dir, existing ? await list(dir) : new Map());
    }
    job.destNames = new Map([...listings].map(([dir, entries]) => [dir, new Set(entries.keys())]));
    for (const file of job.planFiles) {
      const slash = file.relPath.lastIndexOf("/");
      const dir = slash === -1 ? job.request.destDir : joinPath(job.request.destDir, file.relPath.slice(0, slash));
      const name = file.relPath.slice(slash + 1);
      const st = listings.get(dir)?.get(name);
      if (!st) continue;
      if (st.isDir) job.errors.push({ relPath: file.relPath, message: "A folder with this name exists" });
      job.conflicts.set(file.relPath, {
        relPath: file.relPath,
        destSize: st.size,
        destMtimeMs: st.mtimeMs,
        action: st.isDir ? "skip" : null,
      });
    }
    // Include planned names as well as existing names when allocating keep-both.
    for (const file of job.planFiles) {
      const slash = file.relPath.lastIndexOf("/");
      const dir = slash < 0 ? job.request.destDir : joinPath(job.request.destDir, file.relPath.slice(0, slash));
      const names = job.destNames.get(dir) ?? new Set<string>();
      names.add(file.relPath.slice(slash + 1));
      job.destNames.set(dir, names);
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
    await this.operation(job, () => job.to.mkdirp(job.request.destDir));
    for (const dir of dirs) {
      if (job.canceled) return;
      await this.operation(job, () => job.to.mkdirp(joinPath(job.request.destDir, dir)));
    }

    job.queue = [...job.planFiles];
    const refs = [job.request.from, job.request.to].filter((ref) => ref.kind === "sftp");
    let limit = Math.max(1, Math.floor(this.concurrency));
    for (const ref of refs) {
      const configured = this.sessions.transferConcurrency(ref.sessionId);
      const sameSession = refs.length === 2 && refs[0].sessionId === refs[1].sessionId;
      limit = Math.min(limit, sameSession ? Math.floor((configured + 1) / 2) : configured);
    }
    const workers = Array.from({ length: Math.min(limit, job.queue.length || 1) }, () => this.worker(job));
    await Promise.all(workers);
  }

  private async worker(job: Job): Promise<void> {
    for (;;) {
      if (job.canceled) return;
      try {
        await this.ready(job);
      } catch {
        return;
      }
      const file = job.queue.shift();
      if (!file) return;
      await this.transferFile(job, file);
    }
  }

  private destPathsFor(job: Job, file: PlanFile): { finalPath: string; partPath: string } | "skip" {
    if (file.target) return file.target;
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
    file.target = { finalPath, partPath: joinPath(dir, `.pallet-${randomUUID()}${PART_SUFFIX}`) };
    return file.target;
  }

  private async transferFile(job: Job, file: PlanFile): Promise<void> {
    const target = this.destPathsFor(job, file);
    if (target === "skip") {
      job.skippedFiles++;
      this.emit(job);
      return;
    }
    const { finalPath, partPath } = target;
    const controller = new AbortController();
    const flight: InFlight = { relPath: file.relPath, src: null, dst: null, partPath, abort: null, controller };
    job.inFlight.set(file.relPath, flight);
    this.emit(job);
    const aborted = new Promise<never>((_, reject) => {
      flight.abort = reject;
    });
    void aborted.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const armStall = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const error = Object.assign(new Error("Transfer stalled: no progress for 60s"), { code: "ETIMEDOUT" });
        flight.abort?.(error);
        controller.abort();
      }, STALL_TIMEOUT_MS);
    };
    const checkpointed = !!(job.from.supportsRanges && job.to.supportsRanges && file.size >= CHUNK_THRESHOLD);
    let credited = 0;
    let committing = false;
    const sourcePath = joinPath(job.request.sourceBase, file.relPath);
    const checkSource = async (): Promise<void> => {
      const current = job.from.fileVersion ? await job.from.fileVersion(sourcePath) : await job.from.statOrNull(sourcePath);
      // FTP LIST can omit timestamps or round to the minute. Capture MDTM
      // immediately before reading, then compare the same clock after copying.
      if (job.from.fileVersion && current && !file.versionCaptured) {
        file.mtimeMs = current.mtimeMs;
        file.versionCaptured = true;
      }
      if (
        !current ||
        ("isDir" in current && (current.isDir || ("isSymlink" in current && current.isSymlink))) ||
        current.size !== file.size ||
        current.mtimeMs !== file.mtimeMs
      ) {
        throw new Error(`Source changed during transfer: ${file.relPath}. Retry to copy the new version.`);
      }
    };
    try {
      await checkSource();
      if (file.checkpoint > 0) {
        const part = await job.to.statOrNull(partPath);
        if (!part || part.isDir || part.isSymlink || part.size < file.checkpoint || part.size > file.size) {
          job.doneBytes -= file.checkpoint;
          file.checkpoint = 0;
        }
      }
      let offset = file.checkpoint;
      // Empty files still need a real, successfully closed destination stream.
      let empty = file.size === 0;
      while (offset < file.size || empty) {
        empty = false;
        controller.signal.throwIfAborted();
        const end = checkpointed ? Math.min(file.size, offset + CHUNK_SIZE) : file.size;
        armStall();
        const src = await Promise.race([
          job.from
            .createReadStream(sourcePath, {
              ...(checkpointed ? { start: offset, end: end - 1 } : {}),
              signal: controller.signal,
            })
            .then((stream) => {
              stream.on("error", () => {});
              if (controller.signal.aborted) stream.destroy();
              return stream;
            }),
          aborted,
        ]);
        flight.src = src;
        const dst = await Promise.race([
          job.to
            .createWriteStream(partPath, file.mode, {
              start: offset,
              signal: controller.signal,
            })
            .then((stream) => {
              stream.on("error", () => {});
              if (controller.signal.aborted) stream.destroy();
              return stream;
            }),
          aborted,
        ]);
        flight.dst = dst;
        let bytes = 0;
        const counter = new Transform({
          transform: (chunk: Buffer, _enc, cb) => {
            armStall();
            bytes += chunk.length;
            if (bytes > end - offset) {
              cb(new Error(`Source grew during transfer: ${file.relPath}`));
              return;
            }
            credited += chunk.length;
            job.doneBytes += chunk.length;
            job.samples.push({ t: Date.now(), bytes: job.doneBytes });
            if (job.samples.length > 200) job.samples.splice(0, 100);
            this.emit(job);
            cb(null, chunk);
          },
        });
        await Promise.race([pipeline(src, counter, dst), aborted]);
        clearTimeout(timer);
        controller.signal.throwIfAborted();
        if (bytes !== end - offset) throw new Error(`Source ended early: ${file.relPath}`);
        // Checkpoint only bytes acknowledged by the destination and reflected in its size.
        if (checkpointed) {
          const part = await job.to.statOrNull(partPath);
          if (!part || part.size !== end) throw new Error(`Size mismatch in staged file: ${file.relPath}`);
          file.checkpoint = end;
          credited = 0;
        }
        offset = end;
        flight.src = null;
        flight.dst = null;
      }

      await checkSource();
      const writtenSize = job.to.fileSize ? await job.to.fileSize(partPath) : (await job.to.statOrNull(partPath))?.size;
      if (writtenSize !== file.size) {
        throw new Error(`Size mismatch in staged file: ${file.relPath}`);
      }
      controller.signal.throwIfAborted();
      await job.to.setMeta(partPath, { mtimeMs: file.mtimeMs, mode: file.mode });
      controller.signal.throwIfAborted();
      // Do not retry an ambiguous rename: the server may already have committed it.
      committing = true;
      await job.to.renameReplacing(partPath, finalPath);
      job.doneFiles++;
      file.target = undefined;
      file.checkpoint = 0;
      job.retries.delete(file.relPath);
    } catch (err) {
      controller.abort();
      flight.src?.destroy();
      flight.dst?.destroy();
      // Roll back only this attempt's bytes; other workers keep their progress.
      job.doneBytes -= credited;
      job.samples = [];
      let retry = false;
      if (!job.canceled && !committing) {
        if (this.sessionDown(job)) {
          this.setAutoPaused(job, true);
          retry = true;
        } else if (job.userPaused || job.autoPaused) retry = true;
        else if (this.isChannelError(err)) {
          const attempts = (job.retries.get(file.relPath) ?? 0) + 1;
          job.retries.set(file.relPath, attempts);
          if (attempts <= MAX_CHANNEL_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempts - 1), 4000)));
            retry = true;
          }
        }
      }
      if (retry && !job.canceled) job.queue.unshift(file);
      else {
        job.doneBytes -= file.checkpoint;
        file.checkpoint = 0;
        if (!job.canceled)
          job.errors.push({
            relPath: file.relPath,
            message: committing
              ? `Could not confirm replacement of ${file.relPath}; check the destination before retrying. ${(err as Error).message}`
              : (err as Error).message,
          });
      }
    } finally {
      clearTimeout(timer);
      job.inFlight.delete(file.relPath);
      this.emit(job);
    }
  }

  /** True while a session this job depends on is not usable. */
  private sessionDown(job: Job): boolean {
    const sftpRefs = [job.request.from, job.request.to].filter((r) => r.kind === "sftp");
    if (sftpRefs.length === 0) return false;
    return sftpRefs.some((r) => {
      try {
        return this.sessions.status((r as { sessionId: string }).sessionId) !== "connected";
      } catch {
        return true;
      }
    });
  }

  /** "The channel is gone", as opposed to "this file cannot be transferred". */
  private isChannelError(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException).code;
    return (
      ["ENOTCONN", "ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"].includes(code ?? "") ||
      [421, 425, 426, 450, 451].includes(Number(code)) ||
      /not connected|no response|channel closed|connection (lost|closed|replaced)|socket closed|timed? ?out/i.test(
        (err as Error).message ?? "",
      )
    );
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
      if (event.status === "connected" && !this.sessionDown(job)) this.setAutoPaused(job, false);
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
    if (!job || TERMINAL_TRANSFER_STATES.includes(job.state)) return;
    job.canceled = true;
    job.state = "canceled";
    this.abortInFlight(job);
    // Unstick any waiters so workers can observe cancellation.
    job.conflictWaiter?.();
    for (const wake of this.slotWaiters.splice(0)) wake();
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
    job.settled = old.settled.then(() => this.run(job));
  }

  remove(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && !TERMINAL_TRANSFER_STATES.includes(job.state)) this.cancel(jobId);
    this.jobs.delete(jobId);
    this.order = this.order.filter((id) => id !== jobId);
  }

  private abortInFlight(job: Job): void {
    for (const flight of job.inFlight.values()) {
      flight.abort?.(new Error("Transfer interrupted"));
      flight.controller.abort();
      flight.src?.destroy();
      flight.dst?.destroy();
    }
  }
}
