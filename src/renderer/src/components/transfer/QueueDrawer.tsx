import {
  AlertCircle,
  ArrowLeftRight,
  ChartNoAxesColumn,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
  ScanSearch,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { SPEED_STATS_WINDOW_MS, TERMINAL_TRANSFER_STATES } from "@shared/transfer/transfer.constants";
import type { TransferJobSnapshot, TransferState } from "@shared/transfer/transfer.types";
import { clearFinishedJobs, jobAction, removeJob, setDrawerOpen, useTransfers } from "@/store/transfer.store";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format.utils";

const RECENT_SPEED_LABEL = `Last ${SPEED_STATS_WINDOW_MS / 1000}s`;
const LIST_ID = "transfer-drawer-jobs";

function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "0 B/s";
}

/** Stats start at zero until enough samples exist; an em dash is quieter than "0 B/s". */
function formatStatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? formatSpeed(bytesPerSec) : "—";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Ticks once a second while the stats panel is open, for live elapsed time. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function iconTone(state: TransferState): string {
  switch (state) {
    case "completed":
      return "bg-green-500/10 text-green-600 dark:text-green-400";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "waiting":
      return "bg-caution/15 text-amber-600 dark:text-caution";
    case "running":
    case "enumerating":
      return "bg-primary/10 text-primary";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function StateIcon({ state }: { state: TransferState }): React.JSX.Element {
  const Icon =
    state === "completed"
      ? CheckCircle2
      : state === "failed"
        ? AlertCircle
        : state === "canceled"
          ? XCircle
          : state === "paused"
            ? Pause
            : state === "waiting"
              ? AlertCircle
              : state === "enumerating"
                ? ScanSearch
                : ArrowLeftRight;
  return (
    <span
      className={cn("grid size-8 shrink-0 place-items-center rounded-lg", iconTone(state))}
      aria-hidden
    >
      <Icon className="size-4" />
    </span>
  );
}

/** Bytes and rate shown at the end of a row's title line. */
function jobSummary(job: TransferJobSnapshot): string {
  const bytes = job.totalBytes > 0 ? `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}` : null;
  switch (job.state) {
    case "enumerating":
      return job.totalBytes > 0 ? `${formatBytes(job.totalBytes)} found` : "Preparing…";
    case "waiting":
      return "On hold";
    case "running":
      return [bytes, job.bytesPerSec > 0 ? formatSpeed(job.bytesPerSec) : null].filter(Boolean).join(" · ");
    case "paused":
      return job.autoPaused ? "Connection lost" : (bytes ?? "Paused");
    case "completed":
      return job.doneBytes > 0 ? `${formatBytes(job.doneBytes)} moved` : "Completed";
    case "failed":
    case "canceled":
      return bytes ?? (job.state === "failed" ? "Failed" : "Canceled");
  }
}

/** Secondary line: the live file(s), or what the job is waiting on. */
function jobDetail(job: TransferJobSnapshot): { text: string; full: string; destructive: boolean } {
  if (job.state === "failed") {
    const error = job.errors[0]?.message;
    return { text: error ?? "Transfer failed", full: error ?? "Transfer failed", destructive: true };
  }
  if (job.state === "running" && job.currentFiles.length > 0) {
    const [first, ...rest] = job.currentFiles;
    return {
      text: rest.length > 0 ? `${first} +${rest.length} more` : first,
      full: job.currentFiles.join("\n"),
      destructive: false,
    };
  }
  switch (job.state) {
    case "enumerating":
      return { text: "Scanning source…", full: "Scanning source", destructive: false };
    case "waiting":
      return { text: "Waiting for conflict decision", full: "Waiting for conflict decision", destructive: false };
    case "paused":
      return {
        text: job.autoPaused ? "Waiting for the connection to return" : "Paused",
        full: job.autoPaused ? "Waiting for the connection to return" : "Paused",
        destructive: false,
      };
    case "completed":
      return {
        text: job.skippedFiles > 0 ? `Completed · ${job.skippedFiles} skipped` : "Completed",
        full: job.skippedFiles > 0 ? `Completed with ${job.skippedFiles} skipped` : "Completed",
        destructive: false,
      };
    case "canceled":
      return { text: "Canceled before finishing", full: "Canceled before finishing", destructive: false };
    default:
      return { text: "Starting…", full: "Starting", destructive: false };
  }
}

function StatRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground truncate">{label}</dt>
      <dd className="text-foreground shrink-0 font-mono text-[11px] tabular-nums">{value}</dd>
    </div>
  );
}

function AdvancedStats({ job, id }: { job: TransferJobSnapshot; id: string }): React.JSX.Element {
  const now = useNow();
  const elapsedMs = Math.max(0, (job.finishedAt ?? now) - job.startedAt);
  const remainingBytes = Math.max(0, job.totalBytes - job.doneBytes);
  // The trailing average smooths out per-second noise better than the live rate.
  const estimateRate = job.speedStats.recentAverageBytesPerSec || job.bytesPerSec;
  const etaMs =
    job.state === "running" && remainingBytes > 0 && estimateRate > 0 ? (remainingBytes / estimateRate) * 1000 : null;
  const timeLeft =
    job.state === "completed"
      ? "Done"
      : job.state === "failed" || job.state === "canceled"
        ? "Stopped"
        : job.state === "paused"
          ? "Paused"
          : etaMs === null
            ? "Estimating…"
            : etaMs < 1000
              ? "Almost done"
              : `~${formatDuration(etaMs)}`;
  const processedFiles = job.doneFiles + job.skippedFiles;
  const files =
    job.skippedFiles > 0
      ? `${processedFiles} of ${job.totalFiles} · ${job.skippedFiles} skipped`
      : `${processedFiles} of ${job.totalFiles}`;

  return (
    <div
      id={id}
      className="bg-background/60 mt-2.5 rounded-lg border px-3 py-2.5 text-[11px]"
    >
      <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <div>
          <h4 className="text-muted-foreground mb-1.5 text-[11px] font-medium">Throughput</h4>
          <dl className="space-y-1">
            <StatRow
              label="Average"
              value={formatStatSpeed(job.speedStats.averageBytesPerSec)}
            />
            <StatRow
              label="Median"
              value={formatStatSpeed(job.speedStats.medianBytesPerSec)}
            />
            <StatRow
              label={`${RECENT_SPEED_LABEL} average`}
              value={formatStatSpeed(job.speedStats.recentAverageBytesPerSec)}
            />
            <StatRow
              label={`${RECENT_SPEED_LABEL} median`}
              value={formatStatSpeed(job.speedStats.recentMedianBytesPerSec)}
            />
          </dl>
        </div>
        <div className="border-t pt-2.5 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8">
          <h4 className="text-muted-foreground mb-1.5 text-[11px] font-medium">Progress</h4>
          <dl className="space-y-1">
            <StatRow
              label="Elapsed"
              value={formatDuration(elapsedMs)}
            />
            <StatRow
              label="Time left"
              value={timeLeft}
            />
            <StatRow
              label="Moved"
              value={
                job.totalBytes > 0
                  ? `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}`
                  : formatBytes(job.doneBytes)
              }
            />
            <StatRow
              label="Files"
              value={files}
            />
          </dl>
        </div>
      </div>
      <p className="text-muted-foreground/80 mt-2 border-t pt-1.5 text-[11px]">
        Rates are measured from destination-confirmed progress.
      </p>
    </div>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring grid size-6 place-items-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function JobRow({ job }: { job: TransferJobSnapshot }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const canExpand = job.state !== "enumerating" && job.state !== "waiting";
  const detailsId = `transfer-stats-${job.id}`;
  const pct = job.totalBytes > 0 ? Math.min(100, Math.floor((job.doneBytes / job.totalBytes) * 100)) : 0;
  // A completed job is 100% of the work, even when some files were skipped.
  const barPct = job.state === "completed" ? 100 : pct;
  const terminal = TERMINAL_TRANSFER_STATES.includes(job.state);
  const summary = jobSummary(job);
  const detail = jobDetail(job);
  const processedFiles = job.doneFiles + job.skippedFiles;
  const filesLabel =
    job.state === "enumerating"
      ? `${job.totalFiles} found`
      : job.state === "waiting"
        ? `${job.totalFiles} files`
        : `${processedFiles}/${job.totalFiles} files`;

  return (
    <div
      role="listitem"
      className="flex items-start gap-3 border-t px-3 py-2.5 first:border-t-0"
    >
      <StateIcon state={job.state} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span
            className="truncate text-[13px] font-medium"
            title={job.label}
          >
            {job.label}
          </span>
          <span className="text-muted-foreground ml-auto hidden shrink-0 text-[11px] tabular-nums sm:inline">{summary}</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div
            className="bg-foreground/10 h-1.5 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label={`${job.label} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={barPct}
            aria-valuetext={job.totalBytes > 0 ? `${barPct}%` : "Preparing"}
          >
            <div
              className={cn(
                "h-full rounded-full",
                // Bridge the queue's 100 ms counter updates without easing to a stop between them.
                job.state === "running" && "transition-[width] duration-300 ease-linear motion-reduce:transition-none",
                job.state === "failed"
                  ? "bg-destructive"
                  : job.state === "completed"
                    ? "bg-green-500"
                    : job.state === "waiting"
                      ? "bg-caution"
                      : job.state === "paused" || job.state === "canceled"
                        ? "bg-muted-foreground/50"
                        : "bg-primary",
              )}
              style={{ width: `${barPct}%` }}
            />
          </div>
          <span
            className={cn(
              "w-9 shrink-0 text-right text-xs font-medium tabular-nums",
              job.state === "failed" && "text-destructive",
              job.state === "canceled" && "text-muted-foreground",
            )}
          >
            {job.state === "enumerating" ? "—" : `${barPct}%`}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[11px]",
              detail.destructive ? "text-destructive" : "text-muted-foreground font-file",
            )}
            title={detail.full}
          >
            {detail.text}
          </span>
          <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">{filesLabel}</span>
          {canExpand && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
              aria-expanded={expanded}
              aria-controls={detailsId}
              title={expanded ? "Hide advanced stats" : "Show advanced stats"}
              onClick={() => setExpanded(!expanded)}
            >
              <ChartNoAxesColumn className="size-3" />
              Advanced stats
              <ChevronDown
                className={cn("size-3 transition-transform motion-reduce:transition-none", expanded && "rotate-180")}
              />
            </button>
          )}
        </div>
        {expanded && canExpand && (
          <AdvancedStats
            job={job}
            id={detailsId}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {job.state === "running" && (
          <RowAction
            label="Pause transfer"
            onClick={() => jobAction(job.id, "pause")}
          >
            <Pause className="size-3.5" />
          </RowAction>
        )}
        {job.state === "paused" && !job.autoPaused && (
          <RowAction
            label="Resume transfer"
            onClick={() => jobAction(job.id, "resume")}
          >
            <Play className="size-3.5" />
          </RowAction>
        )}
        {(job.state === "failed" || job.state === "canceled") && (
          <RowAction
            label="Retry transfer"
            onClick={() => jobAction(job.id, "retry")}
          >
            <RotateCcw className="size-3.5" />
          </RowAction>
        )}
        {terminal ? (
          <RowAction
            label="Remove transfer from list"
            onClick={() => removeJob(job.id)}
          >
            <Trash2 className="size-3.5" />
          </RowAction>
        ) : (
          <RowAction
            label="Cancel transfer"
            onClick={() => jobAction(job.id, "cancel")}
          >
            <X className="size-3.5" />
          </RowAction>
        )}
      </div>
    </div>
  );
}

export function QueueDrawer(): React.JSX.Element | null {
  const { jobs, drawerOpen } = useTransfers();
  if (jobs.length === 0) return null;

  const active = jobs.filter((j) => !TERMINAL_TRANSFER_STATES.includes(j.state));
  const failed = jobs.filter((j) => j.state === "failed");
  const finished = jobs.filter((j) => TERMINAL_TRANSFER_STATES.includes(j.state));
  const totalBytes = active.reduce((a, j) => a + j.totalBytes, 0);
  const doneBytes = active.reduce((a, j) => a + j.doneBytes, 0);
  const pct = totalBytes > 0 ? Math.floor((doneBytes / totalBytes) * 100) : null;
  const activeSpeed = active.reduce((a, j) => a + (j.state === "running" ? j.bytesPerSec : 0), 0);
  const summary = active.length > 0 ? `${active.length} active${pct === null ? "" : ` · ${pct}%`}` : `${jobs.length} finished`;

  return (
    <section
      className="bg-sidebar shrink-0 border-t"
      aria-label="Transfer queue"
    >
      <div className="flex h-9 items-center gap-2 pr-2 pl-3">
        <button
          type="button"
          className="focus-visible:ring-ring flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left text-xs focus-visible:ring-2 focus-visible:outline-none"
          aria-expanded={drawerOpen}
          aria-controls={LIST_ID}
          onClick={() => setDrawerOpen(!drawerOpen)}
        >
          {drawerOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronUp className="size-3.5 shrink-0" />}
          <span className="text-foreground shrink-0 font-medium">Transfers</span>
          <span className="text-muted-foreground truncate">{summary}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {activeSpeed > 0 && (
            <span className="text-muted-foreground text-[11px] tabular-nums">{formatSpeed(activeSpeed)}</span>
          )}
          {failed.length > 0 && (
            <span className="text-destructive flex items-center gap-1 text-[11px]">
              <AlertCircle className="size-3" /> {failed.length} failed
            </span>
          )}
          {finished.length > 0 && (
            <button
              type="button"
              className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring rounded px-1.5 py-0.5 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
              onClick={clearFinishedJobs}
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {active.length > 0 && (
        <div
          className="bg-foreground/10 h-0.5"
          role="progressbar"
          aria-label="Overall transfer progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? 0}
        >
          <div
            className="bg-primary h-full transition-[width] duration-300 ease-linear motion-reduce:transition-none"
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      )}
      {drawerOpen && (
        <div
          id={LIST_ID}
          role="list"
          className="max-h-60 overflow-y-auto overscroll-contain"
        >
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
            />
          ))}
        </div>
      )}
    </section>
  );
}
