import { AlertCircle, ChevronDown, ChevronUp, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import type { TransferJobSnapshot } from "@shared/transfers";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { clearFinishedJobs, jobAction, removeJob, setDrawerOpen, useTransfers } from "@/store/transfers";

const TERMINAL = ["completed", "failed", "canceled"];

function JobRow({ job }: { job: TransferJobSnapshot }): React.JSX.Element {
  const pct = job.totalBytes > 0 ? Math.min(100, (job.doneBytes / job.totalBytes) * 100) : 0;
  const terminal = TERMINAL.includes(job.state);
  const stateLabel =
    job.state === "running"
      ? `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)} · ${formatBytes(job.bytesPerSec)}/s`
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
                : "Canceled";

  return (
    <div className="flex items-center gap-3 border-t px-3 py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px]">{job.label}</span>
          <span className={cn("text-muted-foreground shrink-0 text-[11px]", job.state === "failed" && "text-destructive")}>
            {stateLabel}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-200",
                job.state === "failed" ? "bg-destructive" : job.state === "completed" ? "bg-green-500" : "bg-primary",
              )}
              style={{ width: `${terminal && job.state !== "completed" ? 100 : pct}%` }}
            />
          </div>
          <span className="text-muted-foreground w-24 shrink-0 text-right text-[11px] tabular-nums">
            {job.doneFiles + job.skippedFiles}/{job.totalFiles} files
          </span>
        </div>
        {job.currentFiles.length > 0 && (
          <div className="text-muted-foreground mt-0.5 truncate text-[11px]">{job.currentFiles.join(", ")}</div>
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

  const active = jobs.filter((j) => !TERMINAL.includes(j.state));
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
        {jobs.some((j) => TERMINAL.includes(j.state)) && (
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
