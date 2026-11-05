import { AlertCircle, ChevronDown, ChevronRight, ChevronUp, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { SPEED_STATS_WINDOW_MS, TERMINAL_TRANSFER_STATES } from "@shared/transfer/transfer.constants";
import { clearFinishedJobs, jobAction, removeJob, setDrawerOpen, useTransfers } from "@/store/transfer.store";
import type { TransferJobSnapshot } from "@shared/transfer/transfer.types";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format.utils";
import { useState } from "react";

const RECENT_SPEED_LABEL = `Last ${SPEED_STATS_WINDOW_MS / 1000}s`;

function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "0 B/s";
}

function JobRow({ job }: { job: TransferJobSnapshot }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const canExpand = job.state === "running" || job.state === "paused";
  const detailsId = `transfer-speed-${job.id}`;
  const pct = job.totalBytes > 0 ? Math.min(100, (job.doneBytes / job.totalBytes) * 100) : 0;
  const terminal = TERMINAL_TRANSFER_STATES.includes(job.state);
  const stateLabel =
    job.state === "running"
      ? `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)} · ${formatSpeed(job.bytesPerSec)}`
      : job.state === "paused"
        ? job.autoPaused
          ? "Paused — connection lost"
          : "Paused"
        : job.state === "enumerating"
          ? "Preparing…"
          : job.state === "waiting"
            ? "Waiting for conflict decision"
            : job.state === "completed"
              ? `Done · ${formatBytes(job.doneBytes)}${job.skippedFiles ? ` · ${job.skippedFiles} skipped` : ""}`
              : job.state === "failed"
                ? `Failed · ${job.errors[0]?.message ?? ""}`
                : job.totalBytes > 0
                  ? `Canceled · ${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}`
                  : "Canceled";

  return (
    <div className="flex items-center gap-3 border-t px-3 py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px]">{job.label}</span>
          <div className="flex shrink-0 items-center gap-1">
            <span className={cn("text-muted-foreground text-[11px]", job.state === "failed" && "text-destructive")}>
              {stateLabel}
            </span>
            {canExpand && (
              <button
                type="button"
                className="hover:bg-accent -mr-1 rounded p-0.5"
                title={expanded ? "Hide transfer details" : "Show transfer details"}
                aria-label={expanded ? "Hide transfer details" : "Show transfer details"}
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              </button>
            )}
          </div>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
            <div
              className={cn(
                "h-full rounded-full",
                // Bridge the queue's 100 ms counter updates without easing to a stop between them.
                job.state === "running" && "transition-[width] duration-300 ease-linear motion-reduce:transition-none",
                job.state === "failed"
                  ? "bg-destructive"
                  : job.state === "completed"
                    ? "bg-green-500"
                    : job.state === "canceled"
                      ? "bg-muted-foreground"
                      : "bg-primary",
              )}
              style={{ width: `${job.state === "failed" ? 100 : pct}%` }}
            />
          </div>
          <span className="text-muted-foreground w-24 shrink-0 text-right text-[11px] tabular-nums">
            {job.doneFiles + job.skippedFiles}/{job.totalFiles} files
          </span>
        </div>
        {job.currentFiles.length > 0 && (
          <div className="text-muted-foreground mt-0.5 truncate text-[11px]">{job.currentFiles.join(", ")}</div>
        )}
        {canExpand && expanded && (
          <dl
            id={detailsId}
            className="text-muted-foreground mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] tabular-nums"
          >
            <div className="flex items-baseline justify-between gap-2">
              <dt>Average</dt>
              <dd className="text-foreground">{formatSpeed(job.speedStats.averageBytesPerSec)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt>Median</dt>
              <dd className="text-foreground">{formatSpeed(job.speedStats.medianBytesPerSec)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt>{RECENT_SPEED_LABEL} average</dt>
              <dd className="text-foreground">{formatSpeed(job.speedStats.recentAverageBytesPerSec)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt>{RECENT_SPEED_LABEL} median</dt>
              <dd className="text-foreground">{formatSpeed(job.speedStats.recentMedianBytesPerSec)}</dd>
            </div>
          </dl>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {job.state === "running" && (
          <button
            className="hover:bg-accent rounded p-1"
            title="Pause"
            onClick={() => jobAction(job.id, "pause")}
          >
            <Pause className="size-3.5" />
          </button>
        )}
        {job.state === "paused" && !job.autoPaused && (
          <button
            className="hover:bg-accent rounded p-1"
            title="Resume"
            onClick={() => jobAction(job.id, "resume")}
          >
            <Play className="size-3.5" />
          </button>
        )}
        {(job.state === "failed" || job.state === "canceled") && (
          <button
            className="hover:bg-accent rounded p-1"
            title="Retry"
            onClick={() => jobAction(job.id, "retry")}
          >
            <RotateCcw className="size-3.5" />
          </button>
        )}
        {!terminal ? (
          <button
            className="hover:bg-accent rounded p-1"
            title="Cancel"
            onClick={() => jobAction(job.id, "cancel")}
          >
            <X className="size-3.5" />
          </button>
        ) : (
          <button
            className="hover:bg-accent rounded p-1"
            title="Remove from list"
            onClick={() => removeJob(job.id)}
          >
            <Trash2 className="size-3.5" />
          </button>
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
  const totalBytes = active.reduce((a, j) => a + j.totalBytes, 0);
  const doneBytes = active.reduce((a, j) => a + j.doneBytes, 0);
  const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0;

  return (
    <div className="bg-sidebar shrink-0 border-t">
      <button
        className="text-muted-foreground hover:bg-sidebar-accent flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
        onClick={() => setDrawerOpen(!drawerOpen)}
      >
        {drawerOpen ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        <span className="text-foreground font-medium">Transfers</span>
        {active.length > 0 ? (
          <span>
            {active.length} active · {pct}%
          </span>
        ) : (
          <span>{jobs.length} finished</span>
        )}
        {failed.length > 0 && (
          <span className="text-destructive flex items-center gap-1">
            <AlertCircle className="size-3.5" /> {failed.length} failed
          </span>
        )}
        {jobs.some((j) => TERMINAL_TRANSFER_STATES.includes(j.state)) && (
          <span
            role="button"
            tabIndex={0}
            className="hover:bg-accent ml-auto rounded px-1.5 py-0.5"
            onClick={(e) => {
              e.stopPropagation();
              clearFinishedJobs();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                clearFinishedJobs();
              }
            }}
          >
            Clear
          </span>
        )}
      </button>
      {drawerOpen && (
        <div className="max-h-48 overflow-y-auto">
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
            />
          ))}
        </div>
      )}
    </div>
  );
}
