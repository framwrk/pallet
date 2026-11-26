import type {
  ConflictAction,
  ConflictPrompt,
  TransferError,
  TransferItemSnapshot,
  TransferItemState,
  TransferJobSnapshot,
  TransferRequest,
  TransferSpeedPoint,
  TransferSpeedStats,
  TransferState,
  TransferVerificationMode,
  TransferVerificationProgress,
} from "@shared/transfer/transfer.types";
import {
  type EndpointStat,
  type TransferEndpoint,
  type TransferWriteStream,
  joinPath,
  makeEndpoint,
} from "./transfer-endpoint";
import {
  PART_SUFFIX,
  SPEED_GRAPH_MAX_POINTS,
  SPEED_STATS_WINDOW_MS,
  TERMINAL_TRANSFER_STATES,
} from "@shared/transfer/transfer.constants";
import { type Readable, Transform } from "stream";
import { type SpeedSample, ZERO_SPEED_STATS, downsampleSpeedHistory, speedStatsFromSamples } from "./transfer-speed";
import { TransferIntegrityError, digestEndpoint } from "./transfer-verification";
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
const MAX_CHANNEL_RETRIES = 5;
const PROGRESS_TICK_MS = 100;
const SPEED_SAMPLE_MS = 1_000;
const SPEED_MIN_SAMPLE_MS = 100;
const CHUNK_THRESHOLD = 16 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 5_000;

interface PlanItem {
  name: string;
  totalFiles: number;
  doneFiles: number;
  skippedFiles: number;
  failedFiles: number;
  skippedSymlinks: number;
  totalBytes: number;
  doneBytes: number;
  excludedBytes: number;
  runningFiles: number;
  queue: PlanFile[];
  userPaused: boolean;
  canceled: boolean;
  errors: string[];
  startedAt?: number;
  finishedAt?: number;
  samples: { t: number; bytes: number }[];
  speedSamples: SpeedSample[];
  speedHistory: TransferSpeedPoint[];
  speedStartedAt: number;
  speedStats: TransferSpeedStats;
  lastSpeedSampleAt: number;
}

interface PlanFile {
  relPath: string;
  item: PlanItem;
  size: number;
  mtimeMs: number;
  scanMtimeMs: number;
  mode: number;
  checkpoint: number;
  versionCaptured?: boolean;
  versionToken?: string;
  target?: { finalPath: string; partPath: string };
  completed?: boolean;
  canceled?: boolean;
  excluded?: boolean;
  failed?: boolean;
}

interface SpeedTracked {
  speedSamples: SpeedSample[];
  speedHistory: TransferSpeedPoint[];
  speedStartedAt: number;
  speedStats: TransferSpeedStats;
  lastSpeedSampleAt: number;
}

interface Conflict {
  relPath: string;
  destSize: number;
  destMtimeMs: number;
  action: ConflictAction | null;
}

interface InFlight {
  verification?: TransferVerificationProgress;
  relPath: string;
  item: PlanItem;
  src: Readable | null;
  dst: TransferWriteStream | null;
  partPath: string | null;
  abort: ((err: Error) => void) | null;
  controller: AbortController;
  paused: boolean;
}

export interface QueueHooks {
  onUpdate(snapshot: TransferJobSnapshot): void;
  onConflict(prompt: ConflictPrompt): void;
  record?(job: TransferJobSnapshot, request: TransferRequest): void;
}

export interface TransferQueueOptions {
  verification?: TransferVerificationMode;
  /** Abort a file transfer after this long without progress. */
  stallTimeoutMs?: number;
  /** Per-file retries after a dead channel. */
  maxChannelRetries?: number;
  /** Trailing window for the expanded row's recent speed stats. */
  speedStatsWindowMs?: number;
}

/** Seam for tests: swap in in-memory endpoints instead of disk/SFTP. */
export type EndpointFactory = (sessions: SessionManager, ref: TransferRequest["from"]) => TransferEndpoint;

const LIVE_RATE_WINDOW_MS = 3000;
const LIVE_RATE_SAMPLE_MS = 100;
const LIVE_RATE_MIN_SPAN_MS = 250;

class Job {
  startedAt = Date.now();
  finishedAt?: number;
  state: TransferState = "queued";
  autoPaused = false;
  userPaused = false;
  canceled = false;
  planDirs: string[] = [];
  planFiles: PlanFile[] = [];
  items: PlanItem[] = [];
  skippedSymlinks = 0;
  conflicts = new Map<string, Conflict>();
  previousCompleted = new Map<string, { size: number; scanMtimeMs: number }>();
  alreadyDone = new Set<string>();
  inFlight = new Map<string, InFlight>();
  doneFiles = 0;
  skippedFiles = 0;
  doneBytes = 0;
  totalBytes = 0;
  excludedBytes = 0;
  errors: TransferError[] = [];
  destNames = new Map<string, Set<string>>();
  retries = new Map<string, number>();
  samples: { t: number; bytes: number }[] = [];
  speedSamples: SpeedSample[] = [];
  speedHistory: TransferSpeedPoint[] = [];
  speedStartedAt = 0;
  speedStats: TransferSpeedStats = ZERO_SPEED_STATS;
  lastSpeedSampleAt = 0;
  lastEmit = 0;
  resumeWaiters: (() => void)[] = [];
  itemWaiters: (() => void)[] = [];
  conflictWaiter: (() => void) | null = null;
  settled: Promise<void> = Promise.resolve();
  pipeline = true;
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
  private unsettled = new Set<Promise<void>>();
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    private sessions: SessionManager,
    private hooks: QueueHooks,
    private concurrency = 7,
    private endpointFactory: EndpointFactory = makeEndpoint,
    private getOptions: () => TransferQueueOptions = () => ({}),
  ) {}

  private get stallTimeoutMs(): number {
    return this.getOptions().stallTimeoutMs ?? STALL_TIMEOUT_MS;
  }

  private get maxChannelRetries(): number {
    return this.getOptions().maxChannelRetries ?? MAX_CHANNEL_RETRIES;
  }

  private get speedStatsWindowMs(): number {
    return this.getOptions().speedStatsWindowMs ?? SPEED_STATS_WINDOW_MS;
  }

  private makeItem(name: string): PlanItem {
    return {
      name,
      totalFiles: 0,
      doneFiles: 0,
      skippedFiles: 0,
      failedFiles: 0,
      skippedSymlinks: 0,
      totalBytes: 0,
      doneBytes: 0,
      excludedBytes: 0,
      runningFiles: 0,
      queue: [],
      userPaused: false,
      canceled: false,
      errors: [],
      samples: [],
      speedSamples: [],
      speedHistory: [],
      speedStartedAt: 0,
      speedStats: ZERO_SPEED_STATS,
      lastSpeedSampleAt: 0,
    };
  }

  private settleItem(item: PlanItem): void {
    if (item.finishedAt) return;
    const processed = item.doneFiles + item.skippedFiles + item.failedFiles;
    if (item.totalFiles > 0 && processed >= item.totalFiles) item.finishedAt = Date.now();
  }

  private itemState(job: Job, item: PlanItem): TransferItemState {
    if (item.canceled) return "canceled";
    if (item.errors.length > 0 && (item.finishedAt || TERMINAL_TRANSFER_STATES.includes(job.state))) return "failed";
    if (item.totalFiles > 0 && item.doneFiles + item.skippedFiles >= item.totalFiles) {
      return item.doneFiles > 0 ? "completed" : "skipped";
    }
    if (item.totalFiles === 0 && item.skippedSymlinks > 0) return "skipped";
    if (item.totalFiles === 0 && TERMINAL_TRANSFER_STATES.includes(job.state)) return "completed";
    if (item.userPaused) return "paused";
    if (job.state === "canceled") return "canceled";
    if (job.state === "failed") return "failed";
    if (item.runningFiles > 0 || item.doneFiles > 0 || item.doneBytes > 0) return "running";
    return "pending";
  }

  private itemSnapshot(job: Job, item: PlanItem): TransferItemSnapshot {
    return {
      name: item.name,
      state: this.itemState(job, item),
      paused: item.userPaused && !item.canceled,
      totalFiles: item.totalFiles,
      doneFiles: item.doneFiles,
      skippedFiles: item.skippedFiles + item.skippedSymlinks,
      totalBytes: item.canceled ? item.totalBytes : item.totalBytes - item.excludedBytes,
      doneBytes: item.doneBytes,
      bytesPerSec: this.bytesPerSecOfSamples(item.samples),
      speedStats: item.speedStats,
      speedHistory: item.speedHistory,
      verifyingFiles: [...job.inFlight.values()]
        .filter((flight) => flight.item === item && flight.verification)
        .map((flight) => ({ ...flight.verification! })),
      startedAt: item.startedAt,
      finishedAt: item.finishedAt ?? (TERMINAL_TRANSFER_STATES.includes(job.state) ? job.finishedAt : undefined),
      error: item.errors[0],
    };
  }

  private bytesPerSecOfSamples(samples: { t: number; bytes: number }[]): number {
    const now = Date.now();
    const windowStart = now - LIVE_RATE_WINDOW_MS;
    const recent = samples.filter((s) => s.t >= windowStart);
    if (recent.length < 2) return 0;
    const span = Math.max(LIVE_RATE_MIN_SPAN_MS, now - recent[0].t);
    return Math.max(0, ((recent[recent.length - 1].bytes - recent[0].bytes) / span) * 1000);
  }

  private keepRateThrough(job: Job, item: PlanItem, giveBack: () => void): void {
    const jobBefore = job.doneBytes;
    const itemBefore = item.doneBytes;
    giveBack();
    for (const sample of job.samples) sample.bytes -= jobBefore - job.doneBytes;
    for (const sample of item.samples) sample.bytes -= itemBefore - item.doneBytes;
  }

  private pushRateSample(samples: { t: number; bytes: number }[], now: number, bytes: number): void {
    const prev = samples[samples.length - 2];
    const last = samples[samples.length - 1];
    if (prev && last && now - prev.t < LIVE_RATE_SAMPLE_MS) {
      last.t = now;
      last.bytes = bytes;
    } else samples.push({ t: now, bytes });
    while (samples.length > 2 && samples[0].t < now - LIVE_RATE_WINDOW_MS) samples.shift();
  }

  snapshot(job: Job): TransferJobSnapshot {
    return {
      id: job.id,
      verification: job.request.verification,
      state: job.state,
      autoPaused: job.autoPaused,
      label: job.label,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      destDir: job.request.destDir,
      totalFiles: job.planFiles.length,
      doneFiles: job.doneFiles,
      skippedFiles: job.skippedFiles + job.skippedSymlinks,
      totalBytes: job.state === "canceled" ? job.totalBytes : job.totalBytes - job.excludedBytes,
      doneBytes: job.doneBytes,
      bytesPerSec: this.bytesPerSecOfSamples(job.samples),
      speedStats: job.speedStats,
      speedHistory: job.speedHistory,
      currentFiles: [...job.inFlight.keys()],
      verifyingFiles: [...job.inFlight.values()].flatMap((flight) => (flight.verification ? [{ ...flight.verification }] : [])),
      errors: job.errors.slice(0, 20),
      items: job.items.map((item) => this.itemSnapshot(job, item)),
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

  private startProgressTicker(): void {
    if (this.ticker) return;
    const tick = (): void => {
      const running = [...this.jobs.values()].filter((j) => j.state === "running");
      const now = Date.now();
      for (const job of running) {
        this.sampleSpeed(job, job.doneBytes, now);
        for (const item of job.items) {
          if (item.runningFiles > 0) this.sampleSpeed(item, item.doneBytes, now);
        }
        this.hooks.onUpdate(this.snapshot(job));
      }
      if (running.length === 0) this.maybeStopProgressTicker();
    };
    this.ticker = setInterval(tick, PROGRESS_TICK_MS);
    this.ticker.unref?.();
  }

  private maybeStopProgressTicker(): void {
    if (!this.ticker || [...this.jobs.values()].some((j) => j.state === "running")) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  private sampleSpeed(target: SpeedTracked, doneBytes: number, now: number): void {
    if (target.lastSpeedSampleAt === 0) {
      target.lastSpeedSampleAt = now;
      if (target.speedStartedAt === 0) {
        target.speedStartedAt = now;
        target.speedHistory.push({ elapsedMs: 0, bytesPerSec: 0 });
      }
      target.speedSamples.push({ bytes: doneBytes, activeMs: 0 });
      return;
    }
    const activeMs = now - target.lastSpeedSampleAt;
    if (activeMs < SPEED_SAMPLE_MS) return;
    target.lastSpeedSampleAt = now;
    if (activeMs > SPEED_SAMPLE_MS * 2) {
      target.speedSamples.push({ bytes: doneBytes, activeMs: 0 });
      return;
    }
    const previous = target.speedSamples[target.speedSamples.length - 1];
    target.speedSamples.push({ bytes: doneBytes, activeMs });
    this.recordSpeedPoint(target, doneBytes - (previous?.bytes ?? doneBytes), activeMs, now);
    target.speedStats = speedStatsFromSamples(target.speedSamples, this.speedStatsWindowMs);
  }

  private flushSpeedSample(target: SpeedTracked, doneBytes: number, now = Date.now()): void {
    if (target.lastSpeedSampleAt === 0) return;
    const activeMs = now - target.lastSpeedSampleAt;
    target.lastSpeedSampleAt = now;
    if (activeMs < SPEED_MIN_SAMPLE_MS || activeMs > SPEED_SAMPLE_MS * 2) return;
    const previous = target.speedSamples[target.speedSamples.length - 1];
    target.speedSamples.push({ bytes: doneBytes, activeMs });
    this.recordSpeedPoint(target, doneBytes - (previous?.bytes ?? doneBytes), activeMs, now);
    target.speedStats = speedStatsFromSamples(target.speedSamples, this.speedStatsWindowMs);
  }

  private recordSpeedPoint(target: SpeedTracked, bytes: number, activeMs: number, now: number): void {
    if (activeMs <= 0) return;
    target.speedHistory.push({
      elapsedMs: Math.max(0, now - target.speedStartedAt),
      bytesPerSec: (Math.max(0, bytes) / activeMs) * 1000,
    });
    if (target.speedHistory.length > SPEED_GRAPH_MAX_POINTS * 2) {
      target.speedHistory = downsampleSpeedHistory(target.speedHistory, SPEED_GRAPH_MAX_POINTS);
    }
  }

  private flushItemSpeeds(job: Job, reset: boolean): void {
    for (const item of job.items) {
      if (item.lastSpeedSampleAt === 0) continue;
      this.flushSpeedSample(item, item.doneBytes);
      if (reset) item.lastSpeedSampleAt = 0;
    }
  }

  enqueue(request: TransferRequest): string {
    const job = new Job(`t${++this.seq}`, {
      ...request,
      verification: request.verification ?? this.getOptions().verification ?? "metadata",
    });
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    job.settled = this.run(job);
    this.track(job.settled);
    return job.id;
  }

  private track(settled: Promise<void>): void {
    this.unsettled.add(settled);
    const done = (): void => void this.unsettled.delete(settled);
    void settled.then(done, done);
  }

  private async acquireJobSlot(job: Job): Promise<() => void> {
    const ids = [...new Set([job.request.from, job.request.to].flatMap((ref) => (ref.kind === "sftp" ? [ref.sessionId] : [])))];
    while (!job.canceled && ids.some((id) => this.activeSessions.has(id))) {
      this.emit(job, true);
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
      if (!job.canceled) {
        job.state =
          job.errors.length > 0
            ? "failed"
            : job.items.length > 0 && job.items.every((item) => item.canceled)
              ? "canceled"
              : "completed";
      }
    } catch (err) {
      if (!job.canceled) {
        job.errors.push({ relPath: "", message: (err as Error).message });
        job.state = "failed";
      }
    } finally {
      if (job.to) {
        await Promise.allSettled(
          job.planFiles.filter((file) => file.target).map((file) => job.to.removeFile(file.target!.partPath)),
        );
      }
      job.from?.dispose();
      job.to?.dispose();
      release();
      if (TERMINAL_TRANSFER_STATES.includes(job.state) && !job.finishedAt) job.finishedAt = Date.now();
      this.flushSpeedSample(job, job.doneBytes);
      this.flushItemSpeeds(job, false);
      this.emit(job, true);
      if (TERMINAL_TRANSFER_STATES.includes(job.state)) this.hooks.record?.(this.snapshot(job), job.request);
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
        if (!this.isChannelError(err) || attempt >= this.maxChannelRetries) throw err;
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 4000)));
      }
    }
  }

  private async enumerate(job: Job): Promise<void> {
    const { sourceBase, names } = job.request;
    const walk = async (item: PlanItem, relPath: string, knownStat?: EndpointStat): Promise<void> => {
      if (job.canceled || item.canceled) return;
      const abs = joinPath(sourceBase, relPath);
      await this.ready(job);
      const stat = knownStat ?? (await this.operation(job, () => job.from.statOrNull(abs)));
      if (item.canceled) return;
      if (!stat) throw new Error(`Source disappeared: ${relPath}`);
      if (stat.isSymlink) {
        job.skippedSymlinks++;
        item.skippedSymlinks++;
        return;
      }
      if (stat.isDir) {
        job.planDirs.push(relPath);
        for (const child of await this.operation(job, () => job.from.listEntries(abs))) {
          if (!child.name || child.name === "." || child.name === ".." || child.name.includes("/")) {
            throw new Error(`Invalid directory entry: ${child.name}`);
          }
          await walk(item, `${relPath}/${child.name}`, child.stat);
        }
      } else {
        job.planFiles.push({
          relPath,
          item,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          scanMtimeMs: stat.mtimeMs,
          mode: stat.mode,
          checkpoint: 0,
        });
        job.totalBytes += stat.size;
        item.totalFiles++;
        item.totalBytes += stat.size;
        this.emit(job);
      }
    };
    for (const name of new Set(names)) {
      if (job.canceled) return;
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
        throw new Error("Invalid source name");
      const item = this.makeItem(name);
      job.items.push(item);
      await walk(item, name);
    }
  }

  private async detectConflicts(job: Job): Promise<void> {
    await this.operation(job, () => job.to.mkdirp(job.request.destDir));
    const listings = new Map<string, Map<string, EndpointStat>>();
    const list = async (dir: string): Promise<Map<string, EndpointStat>> =>
      new Map((await this.operation(job, () => job.to.listEntries(dir))).map((entry) => [entry.name, entry.stat]));
    listings.set(job.request.destDir, await list(job.request.destDir));
    for (const rel of job.planDirs) {
      if (job.canceled) return;
      const dir = joinPath(job.request.destDir, rel);
      const slash = rel.lastIndexOf("/");
      const parent = slash < 0 ? job.request.destDir : joinPath(job.request.destDir, rel.slice(0, slash));
      const existing = listings.get(parent)?.get(rel.slice(slash + 1));
      if (existing && (!existing.isDir || existing.isSymlink)) throw new Error(`Destination is not a regular folder: ${rel}`);
      listings.set(dir, existing ? await list(dir) : new Map());
    }
    job.destNames = new Map([...listings].map(([dir, entries]) => [dir, new Set(entries.keys())]));
    for (const file of job.planFiles) {
      if (job.canceled) return;
      if (file.canceled || file.item.canceled) continue;
      const slash = file.relPath.lastIndexOf("/");
      const dir = slash === -1 ? job.request.destDir : joinPath(job.request.destDir, file.relPath.slice(0, slash));
      const name = file.relPath.slice(slash + 1);
      const st = listings.get(dir)?.get(name);
      const previous = job.previousCompleted.get(file.relPath);
      if (
        previous &&
        previous.size === file.size &&
        previous.scanMtimeMs === file.scanMtimeMs &&
        st &&
        !st.isDir &&
        !st.isSymlink &&
        st.size === file.size
      ) {
        job.alreadyDone.add(file.relPath);
        file.completed = true;
        job.doneFiles++;
        job.doneBytes += file.size;
        file.item.doneFiles++;
        file.item.doneBytes += file.size;
        this.settleItem(file.item);
        continue;
      }
      if (!st) continue;
      if (st.isDir) {
        const message = "A folder with this name exists";
        job.errors.push({ relPath: file.relPath, message });
        file.item.errors.push(message);
      }
      job.conflicts.set(file.relPath, {
        relPath: file.relPath,
        destSize: st.size,
        destMtimeMs: st.mtimeMs,
        action: st.isDir ? "skip" : null,
      });
    }
    for (const file of job.planFiles) {
      if (job.canceled) return;
      if (file.canceled || file.item.canceled) continue;
      const slash = file.relPath.lastIndexOf("/");
      const dir = slash < 0 ? job.request.destDir : joinPath(job.request.destDir, file.relPath.slice(0, slash));
      const names = job.destNames.get(dir) ?? new Set<string>();
      names.add(file.relPath.slice(slash + 1));
      job.destNames.set(dir, names);
    }
  }

  private async promptConflicts(job: Job): Promise<void> {
    for (;;) {
      if (job.canceled) return;
      const next = [...job.conflicts.values()].find((c) => c.action === null);
      if (!next) return;
      const remaining = [...job.conflicts.values()].filter((c) => c.action === null).length;
      const file = job.planFiles.find((f) => f.relPath === next.relPath);
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
    const dirs = [...job.planDirs].sort((a, b) => a.split("/").length - b.split("/").length);
    await this.operation(job, () => job.to.mkdirp(job.request.destDir));
    for (const dir of dirs) {
      if (job.canceled) return;
      await this.operation(job, () => job.to.mkdirp(joinPath(job.request.destDir, dir)));
    }
    if (job.canceled) return;

    for (const file of job.planFiles) {
      if (job.alreadyDone.has(file.relPath) || file.canceled || file.item.canceled) continue;
      file.item.queue.push(file);
    }
    const queued = job.items.reduce((total, item) => total + item.queue.length, 0);
    const refs = [job.request.from, job.request.to].filter((ref) => ref.kind === "sftp");
    const sameSession = refs.length === 2 && refs[0].sessionId === refs[1].sessionId;
    job.pipeline = !sameSession;
    let limit = Math.max(1, Math.floor(this.concurrency));
    for (const ref of refs) {
      const configured = this.sessions.transferConcurrency(ref.sessionId);
      limit = Math.min(limit, sameSession ? Math.floor((configured + 1) / 2) : configured);
    }
    const workers = Array.from({ length: Math.min(limit, queued || 1) }, () => this.worker(job));
    await Promise.all(workers);
  }

  private async worker(job: Job): Promise<void> {
    let inflight: Promise<void> | null = null;
    for (;;) {
      if (job.canceled) break;
      try {
        await this.ready(job);
      } catch {
        break;
      }
      const file = this.nextFile(job);
      if (!file) {
        if (!inflight) {
          if (this.hasQueuedFiles(job) && !job.canceled) {
            await this.waitForItem(job);
            continue;
          }
          break;
        }
        const settling = inflight;
        inflight = null;
        await settling;
        continue;
      }
      if (!job.pipeline) {
        await this.transferFile(job, file);
        continue;
      }
      const previous = inflight;
      inflight = this.transferFile(job, file);
      if (previous) await previous;
    }
    await inflight;
  }

  private nextFile(job: Job): PlanFile | undefined {
    for (const item of job.items) {
      if (item.userPaused || item.canceled) continue;
      const file = item.queue.shift();
      if (file) return file;
    }
    return undefined;
  }

  private hasQueuedFiles(job: Job): boolean {
    return job.items.some((item) => item.queue.length > 0);
  }

  private async waitForItem(job: Job): Promise<void> {
    if (job.canceled) return;
    await new Promise<void>((resolve) => job.itemWaiters.push(resolve));
  }

  private wakeItemWaiters(job: Job): void {
    for (const wake of job.itemWaiters.splice(0)) wake();
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

  private excludeFileBytes(job: Job, file: PlanFile): void {
    if (file.excluded) return;
    file.excluded = true;
    const bytes = Math.max(0, file.size - file.checkpoint);
    job.excludedBytes += bytes;
    file.item.excludedBytes += bytes;
  }

  private skipCanceledFile(job: Job, file: PlanFile): void {
    if (file.completed || file.canceled) return;
    file.canceled = true;
    job.skippedFiles++;
    file.item.skippedFiles++;
    this.excludeFileBytes(job, file);
    this.settleItem(file.item);
    this.emit(job);
  }

  private async transferFile(job: Job, file: PlanFile): Promise<void> {
    if (job.canceled) return;
    const item = file.item;
    if (item.canceled) {
      this.skipCanceledFile(job, file);
      return;
    }
    if (item.userPaused) {
      item.queue.unshift(file);
      return;
    }
    const target = this.destPathsFor(job, file);
    if (target === "skip") {
      job.skippedFiles++;
      file.item.skippedFiles++;
      this.excludeFileBytes(job, file);
      this.settleItem(file.item);
      this.emit(job);
      return;
    }
    item.runningFiles++;
    if (!item.startedAt) item.startedAt = Date.now();
    const { finalPath, partPath } = target;
    const controller = new AbortController();
    const flight: InFlight = {
      relPath: file.relPath,
      item,
      src: null,
      dst: null,
      partPath,
      abort: null,
      controller,
      paused: false,
    };
    job.inFlight.set(file.relPath, flight);
    this.emit(job);
    const aborted = new Promise<never>((_, reject) => {
      flight.abort = reject;
    });
    void aborted.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const armStall = (): void => {
      clearTimeout(timer);
      const stallTimeoutMs = this.stallTimeoutMs;
      timer = setTimeout(() => {
        const seconds = Math.round(stallTimeoutMs / 1000);
        const error = Object.assign(new Error(`Transfer stalled: no progress for ${seconds}s`), { code: "ETIMEDOUT" });
        flight.abort?.(error);
        controller.abort();
      }, stallTimeoutMs);
    };
    const checkpointed = !!(job.from.supportsRanges && job.to.supportsRanges && file.size >= CHUNK_THRESHOLD);
    const sourcePath = joinPath(job.request.sourceBase, file.relPath);
    let uncredited = 0;
    const credit = (bytes: number): void => {
      if (bytes <= 0) return;
      job.doneBytes += bytes;
      item.doneBytes += bytes;
      uncredited += bytes;
    };
    const confirm = (offset: number): void => {
      if (offset <= file.checkpoint) return;
      uncredited = Math.max(0, uncredited - (offset - file.checkpoint));
      file.checkpoint = offset;
    };
    const rollback = (): void => {
      if (uncredited > 0) {
        job.doneBytes -= uncredited;
        item.doneBytes -= uncredited;
      }
      uncredited = 0;
    };
    const discard = (): void => {
      rollback();
      job.doneBytes -= file.checkpoint;
      item.doneBytes -= file.checkpoint;
      file.checkpoint = 0;
    };
    let committing = false;
    const checkSource = async (): Promise<void> => {
      const current = job.from.fileVersion ? await job.from.fileVersion(sourcePath) : await job.from.statOrNull(sourcePath);
      // FTP LIST can omit timestamps or round to the minute. Capture MDTM
      // immediately before reading, then compare the same clock after copying.
      if (job.from.fileVersion && current && !file.versionCaptured) {
        file.mtimeMs = current.mtimeMs;
        file.versionCaptured = true;
        if ("etag" in current && current.etag) file.versionToken = current.etag;
      }
      const tokenChanged =
        file.versionToken !== undefined &&
        current !== null &&
        "etag" in current &&
        current.etag !== undefined &&
        current.etag !== file.versionToken;
      if (
        !current ||
        ("isDir" in current && (current.isDir || ("isSymlink" in current && current.isSymlink))) ||
        current.size !== file.size ||
        current.mtimeMs !== file.mtimeMs ||
        tokenChanged
      ) {
        throw new Error(`Source changed during transfer: ${file.relPath}. Retry to copy the new version.`);
      }
    };
    const verify = job.request.verification === "sha256";
    try {
      if (verify) armStall();
      await Promise.race([checkSource(), aborted]);
      if (file.checkpoint > 0) {
        const part = await Promise.race([job.to.statOrNull(partPath), aborted]);
        if (!part || part.isDir || part.isSymlink || part.size < file.checkpoint || part.size > file.size) {
          discard();
        }
      }
      const offset = file.checkpoint;
      controller.signal.throwIfAborted();
      armStall();
      let confirmedSize: number | undefined = offset === file.size && checkpointed ? file.size : undefined;
      if (offset < file.size || !checkpointed) {
        const src = await Promise.race([
          job.from
            .createReadStream(sourcePath, {
              ...(file.size > 0 ? { start: offset, end: file.size - 1 } : {}),
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
            .createWriteStream(partPath, verify ? 0o600 : file.mode, {
              start: offset,
              size: file.size - offset,
              signal: controller.signal,
              ...(job.to.writesMeta && !verify ? { meta: { mtimeMs: file.mtimeMs, mode: file.mode } } : {}),
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
            if (bytes + chunk.length > file.size - offset) {
              cb(new Error(`Source grew during transfer: ${file.relPath}`));
              return;
            }
            bytes += chunk.length;
            credit(chunk.length);
            if (checkpointed) confirm(dst.confirmedBytes?.() ?? offset);
            const now = Date.now();
            this.pushRateSample(job.samples, now, job.doneBytes);
            this.pushRateSample(item.samples, now, item.doneBytes);
            this.emit(job);
            cb(null, chunk);
          },
        });
        await Promise.race([pipeline(src, counter, dst), aborted]);
        if (verify) armStall();
        else clearTimeout(timer);
        controller.signal.throwIfAborted();
        if (bytes !== file.size - offset) throw new Error(`Source ended early: ${file.relPath}`);
        if (checkpointed) confirm(file.size);
        flight.src = null;
        flight.dst = null;
        confirmedSize = dst.confirmedBytes?.();
      }

      await Promise.race([checkSource(), aborted]);
      const writtenSize = await Promise.race([
        (async () =>
          confirmedSize === file.size
            ? file.size
            : job.to.fileSize
              ? await job.to.fileSize(partPath)
              : (await job.to.statOrNull(partPath))?.size)(),
        aborted,
      ]);
      if (writtenSize !== file.size) {
        throw new Error(`Size mismatch in staged file: ${file.relPath}`);
      }
      controller.signal.throwIfAborted();
      if (verify) {
        flight.verification = { relPath: file.relPath, checkedBytes: 0, totalBytes: file.size * 2 };
        this.emit(job, true);
        const progress = (bytes: number): void => {
          flight.verification!.checkedBytes += bytes;
          armStall();
          this.emit(job);
        };
        const sourceDigest = await Promise.race([
          digestEndpoint(job.from, sourcePath, file.size, controller.signal, progress),
          aborted,
        ]);
        await Promise.race([checkSource(), aborted]);
        const destinationDigest = await Promise.race([
          digestEndpoint(job.to, partPath, file.size, controller.signal, progress),
          aborted,
        ]);
        if (sourceDigest !== destinationDigest)
          throw new TransferIntegrityError(`SHA-256 mismatch: ${file.relPath}. Retry to copy fresh content.`);
        await Promise.race([checkSource(), aborted]);
      }
      controller.signal.throwIfAborted();
      if (!job.to.writesMeta || verify) {
        await Promise.race([job.to.setMeta(partPath, { mtimeMs: file.mtimeMs, mode: file.mode }), aborted]);
        controller.signal.throwIfAborted();
      }
      committing = true;
      await job.to.renameReplacing(partPath, finalPath);
      job.doneFiles++;
      item.doneFiles++;
      file.completed = true;
      file.target = undefined;
      file.checkpoint = 0;
      job.retries.delete(file.relPath);
    } catch (err) {
      controller.abort();
      flight.src?.destroy();
      flight.dst?.destroy();
      if (checkpointed) confirm(flight.dst?.confirmedBytes?.() ?? file.checkpoint);
      this.keepRateThrough(job, item, rollback);
      let retry = false;
      if (!job.canceled && !item.canceled && !committing && !(err instanceof TransferIntegrityError)) {
        if (this.sessionDown(job)) {
          this.setAutoPaused(job, true);
          retry = true;
        } else if (job.userPaused || job.autoPaused || item.userPaused || flight.paused) retry = true;
        else if (this.isChannelError(err)) {
          const attempts = (job.retries.get(file.relPath) ?? 0) + 1;
          job.retries.set(file.relPath, attempts);
          if (attempts <= this.maxChannelRetries) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempts - 1), 4000)));
            retry = true;
          }
        }
      }
      if (retry && !job.canceled && !item.canceled) item.queue.unshift(file);
      else {
        this.keepRateThrough(job, item, discard);
        if (item.canceled) this.skipCanceledFile(job, file);
        else if (!job.canceled) {
          const message = committing
            ? `Could not confirm replacement of ${file.relPath}; check the destination before retrying. ${(err as Error).message}`
            : (err as Error).message;
          job.errors.push({ relPath: file.relPath, message });
          item.errors.push(message);
          item.failedFiles++;
          file.failed = true;
        }
      }
    } finally {
      clearTimeout(timer);
      item.runningFiles = Math.max(0, item.runningFiles - 1);
      this.settleItem(item);
      if (item.runningFiles === 0) this.flushSpeedSample(item, item.doneBytes);
      job.inFlight.delete(file.relPath);
      this.emit(job);
    }
  }

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

  private isChannelError(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException).code;
    return (
      [
        "ENOTCONN",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ECONNABORTED",
        "EPIPE",
        "EHOSTUNREACH",
        "ENETUNREACH",
        "ERR_STREAM_PREMATURE_CLOSE",
      ].includes(code ?? "") ||
      [421, 425, 426, 450, 451].includes(Number(code)) ||
      /not connected|no response|channel closed|connection (lost|closed|replaced)|socket closed|server sent FIN packet unexpectedly|timed? ?out/i.test(
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
      this.flushSpeedSample(job, job.doneBytes);
      this.flushItemSpeeds(job, true);
      job.lastSpeedSampleAt = 0;
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
    this.flushSpeedSample(job, job.doneBytes);
    this.flushItemSpeeds(job, true);
    job.lastSpeedSampleAt = 0;
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

  pauseItem(jobId: string, name: string): void {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_TRANSFER_STATES.includes(job.state)) return;
    const item = job.items.find((candidate) => candidate.name === name);
    if (!item || item.canceled || item.userPaused) return;
    const processed = item.doneFiles + item.skippedFiles + item.failedFiles;
    if (item.totalFiles > 0 && processed >= item.totalFiles) return;
    item.userPaused = true;
    this.flushSpeedSample(item, item.doneBytes);
    item.lastSpeedSampleAt = 0;
    this.abortItemInFlight(job, item);
    this.emit(job, true);
  }

  resumeItem(jobId: string, name: string): void {
    const job = this.jobs.get(jobId);
    const item = job?.items.find((candidate) => candidate.name === name);
    if (!job || !item || !item.userPaused) return;
    item.userPaused = false;
    this.wakeItemWaiters(job);
    this.emit(job, true);
  }

  cancelItem(jobId: string, name: string): void {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_TRANSFER_STATES.includes(job.state)) return;
    const item = job.items.find((candidate) => candidate.name === name);
    if (!item || item.canceled) return;
    item.canceled = true;
    item.userPaused = false;
    item.finishedAt ??= Date.now();
    for (const file of job.planFiles) {
      if (
        file.item !== item ||
        file.completed ||
        file.canceled ||
        file.excluded ||
        file.failed ||
        job.inFlight.has(file.relPath)
      ) {
        continue;
      }
      file.canceled = true;
      job.skippedFiles++;
      item.skippedFiles++;
      this.excludeFileBytes(job, file);
    }
    item.queue = [];
    for (const conflict of job.conflicts.values()) {
      if (conflict.action !== null) continue;
      const file = job.planFiles.find((candidate) => candidate.relPath === conflict.relPath);
      if (file?.item === item) conflict.action = "skip";
    }
    this.settleItem(item);
    this.abortItemInFlight(job, item);
    job.conflictWaiter?.();
    this.wakeItemWaiters(job);
    this.emit(job, true);
  }

  cancel(jobId: string, { silent = false }: { silent?: boolean } = {}): void {
    const job = this.jobs.get(jobId);
    if (!job || TERMINAL_TRANSFER_STATES.includes(job.state)) return;
    job.canceled = true;
    job.state = "canceled";
    job.finishedAt ??= Date.now();
    this.abortInFlight(job);
    job.conflictWaiter?.();
    for (const wake of this.slotWaiters.splice(0)) wake();
    const waiters = job.resumeWaiters.splice(0);
    for (const w of waiters) w();
    this.wakeItemWaiters(job);
    if (!silent) this.emit(job, true);
  }

  /** True while a job is still running or cleaning up its staging files. */
  hasActiveTransfers(): boolean {
    return this.unsettled.size > 0;
  }

  /**
   * Cancel every unfinished job, abort its streams, and wait for the run
   * cleanup that removes `.pallet-part` files. Bounded: a dead destination can
   * stall a remove, so callers log the timeout and continue quitting rather
   * than block the process forever.
   */
  async shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<{ timedOut: boolean; remaining: number }> {
    for (const job of this.jobs.values()) {
      if (!TERMINAL_TRANSFER_STATES.includes(job.state)) this.cancel(job.id);
    }
    const pending = [...this.unsettled];
    if (pending.length === 0) return { timedOut: false, remaining: 0 };
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(pending).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return { timedOut, remaining: this.unsettled.size };
  }

  /**
   * Re-run a failed/canceled job (restart-only resume, §3.4): the scan repeats
   * so a changed source is picked up, but files the old attempt committed are
   * kept when the source still matches, so a retry never copies them twice.
   */
  retry(jobId: string): void {
    const old = this.jobs.get(jobId);
    if (!old || !["failed", "canceled"].includes(old.state)) return;
    const job = new Job(jobId, old.request);
    this.jobs.set(jobId, job);
    this.emit(job, true);
    job.settled = old.settled.then(() => {
      for (const file of old.planFiles) {
        if (file.completed) job.previousCompleted.set(file.relPath, { size: file.size, scanMtimeMs: file.scanMtimeMs });
      }
      return this.run(job);
    });
    this.track(job.settled);
  }

  remove(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && !TERMINAL_TRANSFER_STATES.includes(job.state)) this.cancel(jobId, { silent: true });
    this.jobs.delete(jobId);
    this.order = this.order.filter((id) => id !== jobId);
  }

  private abortInFlight(job: Job): void {
    for (const flight of job.inFlight.values()) {
      flight.paused = true;
      flight.abort?.(new Error("Transfer interrupted"));
      flight.controller.abort();
      flight.src?.destroy();
      flight.dst?.destroy();
    }
  }

  private abortItemInFlight(job: Job, item: PlanItem): void {
    for (const flight of job.inFlight.values()) {
      if (flight.item !== item) continue;
      flight.paused = true;
      flight.abort?.(new Error("Transfer interrupted"));
      flight.controller.abort();
      flight.src?.destroy();
      flight.dst?.destroy();
    }
  }
}
