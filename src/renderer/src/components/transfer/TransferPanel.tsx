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
import type {
  TransferItemSnapshot,
  TransferJobSnapshot,
  TransferSpeedPoint,
  TransferSpeedStats,
  TransferState,
  TransferVerificationProgress,
} from "@shared/transfer/transfer.types";
import { clearFinishedJobs, itemAction, jobAction, removeJob, setPanelExpanded, useTransfers } from "@/store/transfer.store";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TERMINAL_TRANSFER_STATES } from "@shared/transfer/transfer.constants";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format.utils";
import { useAppState } from "@/store/pane.store";

const LIST_ID = "transfer-panel-jobs";

/** CSS variable the toast stacks read to sit above a panel in their corner. */
export const TOAST_CLEARANCE_VAR = "--transfer-panel-clearance";
const PANEL_GAP_PX = 8;

const REMOVE_GUARD_MS = 400;

type RowState = TransferState;

function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "0 B/s";
}

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

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function iconTone(state: RowState): string {
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

const STATE_ICON_DEFS: { key: string; states: RowState[]; Icon: typeof CheckCircle2 }[] = [
  { key: "completed", states: ["completed"], Icon: CheckCircle2 },
  { key: "failed", states: ["failed"], Icon: AlertCircle },
  { key: "canceled", states: ["canceled"], Icon: XCircle },
  { key: "paused", states: ["paused"], Icon: Pause },
  { key: "waiting", states: ["waiting"], Icon: AlertCircle },
  { key: "enumerating", states: ["enumerating"], Icon: ScanSearch },
  { key: "running", states: ["running", "queued"], Icon: ArrowLeftRight },
];

function StateIcon({ state, compact = false }: { state: RowState; compact?: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-lg transition-colors duration-[140ms]",
        compact ? "size-6" : "size-8",
        iconTone(state),
      )}
      aria-hidden
    >
      {STATE_ICON_DEFS.map((def) => {
        const active = def.states.includes(state);
        const { Icon } = def;
        return (
          <span
            key={def.key}
            className="absolute inset-0 grid place-items-center"
          >
            <Icon
              className={cn(
                compact ? "size-3.5" : "size-4",
                "ease-entrance transition-[opacity,filter,transform] duration-[140ms]",
                active ? "blur-0 scale-100 opacity-100" : "scale-95 opacity-0 blur-[2px]",
                def.key === "completed" && active && "[animation:pallet-confirm-pulse_320ms_var(--ease-onscreen)]",
              )}
            />
          </span>
        );
      })}
    </span>
  );
}

function barTone(state: RowState): string {
  switch (state) {
    case "failed":
      return "bg-destructive";
    case "completed":
      return "bg-green-500";
    case "waiting":
      return "bg-caution";
    case "paused":
    case "canceled":
    case "queued":
      return "bg-muted-foreground/50";
    default:
      return "bg-primary";
  }
}

function verificationText(files: TransferVerificationProgress[] | undefined): string | null {
  if (!files?.length) return null;
  const checked = files.reduce((sum, file) => sum + file.checkedBytes, 0);
  const total = files.reduce((sum, file) => sum + file.totalBytes, 0);
  return `Verifying… ${formatBytes(checked)} of ${formatBytes(total)} checked · ${files.map((file) => file.relPath).join(", ")}`;
}

function jobSummary(job: TransferJobSnapshot): string {
  const bytes = job.totalBytes > 0 ? `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}` : null;
  switch (job.state) {
    case "queued":
      return "Queued";
    case "enumerating":
      return job.totalBytes > 0 ? `${formatBytes(job.totalBytes)} found` : "Preparing…";
    case "waiting":
      return "On hold";
    case "running":
      return (
        verificationText(job.verifyingFiles) ??
        [bytes, job.bytesPerSec > 0 ? formatSpeed(job.bytesPerSec) : null].filter(Boolean).join(" · ")
      );
    case "paused":
      return job.autoPaused ? "Connection lost" : (bytes ?? "Paused");
    case "completed":
      return job.doneBytes > 0 ? `${formatBytes(job.doneBytes)} moved` : "Completed";
    case "failed":
    case "canceled":
      return bytes ?? (job.state === "failed" ? "Failed" : "Canceled");
  }
}

function jobDetail(job: TransferJobSnapshot): { text: string; full: string; destructive: boolean } {
  if (job.state === "failed") {
    const error = job.errors[0]?.message;
    return { text: error ?? "Transfer failed", full: error ?? "Transfer failed", destructive: true };
  }
  const verifying = job.state === "running" ? verificationText(job.verifyingFiles) : null;
  if (verifying) return { text: verifying, full: verifying, destructive: false };
  if (job.state === "running" && job.currentFiles.length > 0) {
    const [first, ...rest] = job.currentFiles;
    return {
      text: rest.length > 0 ? `${first} +${rest.length} more` : first,
      full: job.currentFiles.join("\n"),
      destructive: false,
    };
  }
  switch (job.state) {
    case "queued":
      return { text: "Waiting to start", full: "Waiting to start", destructive: false };
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

function progressValueText(state: RowState, pct: number, sized: boolean): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "enumerating":
      return "Scanning";
    case "completed":
      return "Completed";
    case "waiting":
      return `On hold, ${pct}%`;
    case "paused":
      return `Paused, ${pct}%`;
    case "failed":
      return `Failed, ${pct}%`;
    case "canceled":
      return `Canceled, ${pct}%`;
    default:
      return sized ? `${pct}%` : "Preparing";
  }
}

function itemDisplayState(job: TransferJobSnapshot, item: TransferItemSnapshot): RowState {
  if (item.state === "running" && job.state === "paused") return "paused";
  if (item.state === "running" && job.state === "waiting") return "waiting";
  if (item.state === "pending") {
    if (job.state === "queued") return "queued";
    if (job.state === "enumerating") return "enumerating";
    if (job.state === "waiting") return "waiting";
    if (job.state === "paused") return "paused";
    return "queued";
  }
  if (item.state === "skipped") return "canceled";
  return item.state;
}

function itemSummary(item: TransferItemSnapshot, state: RowState, job: TransferJobSnapshot): string {
  const bytes = item.totalBytes > 0 ? `${formatBytes(item.doneBytes)} of ${formatBytes(item.totalBytes)}` : null;
  if (state === "enumerating") return item.totalBytes > 0 ? `${formatBytes(item.totalBytes)} found` : "Preparing…";
  if (state === "queued") return "Queued";
  if (state === "waiting") return "On hold";
  if (state === "running") {
    return (
      verificationText(item.verifyingFiles) ??
      [bytes, item.bytesPerSec > 0 ? formatSpeed(item.bytesPerSec) : null].filter(Boolean).join(" · ")
    );
  }
  if (state === "paused") return !item.paused && job.autoPaused ? "Connection lost" : (bytes ?? "Paused");
  if (state === "completed") return item.doneBytes > 0 ? `${formatBytes(item.doneBytes)} moved` : "Completed";
  if (state === "failed") return bytes ?? "Failed";
  return item.state === "skipped" ? "Skipped" : (bytes ?? "Canceled");
}

function itemDetail(
  job: TransferJobSnapshot,
  item: TransferItemSnapshot,
  state: RowState,
): { text: string; full: string; destructive: boolean } {
  if (item.error) return { text: item.error, full: item.error, destructive: true };
  if (state === "failed") {
    const error = job.errors.find((e) => e.relPath === "")?.message;
    return { text: error ?? "Transfer failed", full: error ?? "Transfer failed", destructive: true };
  }
  const verifying = state === "running" ? verificationText(item.verifyingFiles) : null;
  if (verifying) return { text: verifying, full: verifying, destructive: false };
  if (state === "running") {
    const current = job.currentFiles
      .filter((path) => path === item.name || path.startsWith(`${item.name}/`))
      .map((path) => (path === item.name ? path : path.slice(item.name.length + 1)));
    if (current.length > 0) {
      const [first, ...rest] = current;
      return {
        text: rest.length > 0 ? `${first} +${rest.length} more` : first,
        full: current.join("\n"),
        destructive: false,
      };
    }
  }
  switch (state) {
    case "queued":
      return { text: "Queued", full: "Queued", destructive: false };
    case "enumerating":
      return { text: "Scanning source…", full: "Scanning source", destructive: false };
    case "waiting":
      return { text: "Waiting for conflict decision", full: "Waiting for conflict decision", destructive: false };
    case "paused":
      return {
        text: !item.paused && job.autoPaused ? "Waiting for the connection to return" : "Paused",
        full: !item.paused && job.autoPaused ? "Waiting for the connection to return" : "Paused",
        destructive: false,
      };
    case "completed":
      return {
        text: item.skippedFiles > 0 ? `Completed · ${item.skippedFiles} skipped` : "Completed",
        full: item.skippedFiles > 0 ? `Completed with ${item.skippedFiles} skipped` : "Completed",
        destructive: false,
      };
    case "canceled":
      return {
        text: item.state === "skipped" ? "Skipped" : "Canceled before finishing",
        full: item.state === "skipped" ? "Skipped" : "Canceled before finishing",
        destructive: false,
      };
    default:
      return { text: "Starting…", full: "Starting", destructive: false };
  }
}

function SpeedGraph({ points }: { points: TransferSpeedPoint[] }): React.JSX.Element {
  const last = points[points.length - 1];
  if (points.length < 2 || !last) {
    return (
      <div className="text-muted-foreground bg-foreground/[0.03] mt-1 flex h-14 items-center justify-center rounded-md text-[10px]">
        Collecting speed samples…
      </div>
    );
  }

  const measured = points.filter((point) => point.elapsedMs > 0);
  const samples = measured.length > 0 ? measured : points;
  const peak = Math.max(...samples.map((point) => point.bytesPerSec), 0);
  const min = Math.min(...samples.map((point) => point.bytesPerSec));
  const top = Math.max(peak, 1);
  const start = points[0].elapsedMs;
  const span = Math.max(1, last.elapsedMs - start);
  const coords = points.map((point) => {
    const x = ((point.elapsedMs - start) / span) * 100;
    const y = 100 - 6 - (point.bytesPerSec / top) * 88;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${coords.join(" L")}`;
  const area = `${line} L100,100 L0,100 Z`;

  return (
    <figure className="mt-1">
      <div className="text-muted-foreground mb-1 flex items-baseline justify-between gap-3 text-[10px]">
        <span>Speed</span>
        <span className="font-mono tabular-nums">
          Min {formatSpeed(min)} · Peak {formatSpeed(peak)}
        </span>
      </div>
      <div className="bg-foreground/[0.03] h-14 overflow-hidden rounded-md">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Transfer speed, minimum ${formatSpeed(min)}, peaking at ${formatSpeed(peak)}`}
          className="text-primary h-full w-full"
        >
          <line
            x1="0"
            x2="100"
            y1="50"
            y2="50"
            className="stroke-border"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={area}
            fill="currentColor"
            fillOpacity="0.12"
          />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </figure>
  );
}

function StatRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground truncate">{label}</dt>
      <dd className="text-foreground shrink-0 font-mono text-[11px] tabular-nums">{value}</dd>
    </div>
  );
}

interface AdvancedStatsProps {
  id: string;
  state: RowState;
  speedStats: TransferSpeedStats;
  speedHistory: TransferSpeedPoint[];
  startedAt: number;
  finishedAt?: number;
  totalBytes: number;
  doneBytes: number;
  totalFiles: number;
  doneFiles: number;
  skippedFiles: number;
  verifying: boolean;
}

function AdvancedStats({
  id,
  state,
  speedStats,
  speedHistory,
  startedAt,
  finishedAt,
  totalBytes,
  doneBytes,
  totalFiles,
  doneFiles,
  skippedFiles,
  verifying,
}: AdvancedStatsProps): React.JSX.Element {
  const { speedStatsWindowSeconds } = useAppState();
  const recentSpeedLabel = `Last ${speedStatsWindowSeconds}s`;
  const now = useNow();
  const elapsedMs = Math.max(0, (finishedAt ?? now) - startedAt);
  const remainingBytes = Math.max(0, totalBytes - doneBytes);
  const estimateRate = speedStats.recentAverageBytesPerSec;
  const etaMs = state === "running" && remainingBytes > 0 && estimateRate > 0 ? (remainingBytes / estimateRate) * 1000 : null;
  const timeLeft =
    state === "completed"
      ? "Done"
      : state === "failed" || state === "canceled"
        ? "Stopped"
        : state === "queued"
          ? "Waiting"
          : state === "paused"
            ? "Paused"
            : state === "running" && remainingBytes === 0 && totalBytes > 0
              ? verifying
                ? "Verifying…"
                : "Finishing…"
              : etaMs === null
                ? "Estimating…"
                : etaMs < 1000
                  ? "Almost done"
                  : `~${formatDuration(etaMs)}`;
  const processedFiles = doneFiles + skippedFiles;
  const files =
    skippedFiles > 0 ? `${processedFiles} of ${totalFiles} · ${skippedFiles} skipped` : `${processedFiles} of ${totalFiles}`;

  return (
    <div
      id={id}
      className="bg-background/60 pallet-settle mt-2.5 rounded-lg border px-3 py-2.5 text-[11px]"
      data-settle=""
    >
      <SpeedGraph points={speedHistory} />
      <div className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <div>
          <h4 className="text-muted-foreground mb-1.5 text-[11px] font-medium">Throughput</h4>
          <dl className="space-y-1">
            <StatRow
              label="Average"
              value={formatStatSpeed(speedStats.averageBytesPerSec)}
            />
            <StatRow
              label="Median"
              value={formatStatSpeed(speedStats.medianBytesPerSec)}
            />
            <StatRow
              label={`${recentSpeedLabel} average`}
              value={formatStatSpeed(speedStats.recentAverageBytesPerSec)}
            />
            <StatRow
              label={`${recentSpeedLabel} median`}
              value={formatStatSpeed(speedStats.recentMedianBytesPerSec)}
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
              value={totalBytes > 0 ? `${formatBytes(doneBytes)} of ${formatBytes(totalBytes)}` : formatBytes(doneBytes)}
            />
            <StatRow
              label="Files"
              value={files}
            />
          </dl>
        </div>
      </div>
      <p className="text-muted-foreground/80 mt-2 border-t pt-1.5 text-[11px]">
        Rates are measured from bytes written to the destination.
      </p>
    </div>
  );
}

function focusJobPrimary(from: HTMLElement): void {
  from.closest("[data-job-row]")?.querySelector<HTMLElement>("[data-row-primary]")?.focus();
}

function RowAction({
  label,
  onClick,
  primary = false,
  children,
}: {
  label: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  primary?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring grid size-6 place-items-center rounded-md transition-colors duration-[140ms] focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
      title={label}
      aria-label={label}
      data-row-primary={primary || undefined}
      onKeyDown={(event) => {
        if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function AdvancedStatsToggle({
  expanded,
  controls,
  onClick,
}: {
  expanded: boolean;
  controls: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors duration-[140ms] focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
      aria-expanded={expanded}
      aria-controls={controls}
      title={expanded ? "Hide advanced stats" : "Show advanced stats"}
      onClick={onClick}
    >
      <ChartNoAxesColumn className="size-3" />
      Advanced stats
      <ChevronDown
        className={cn(
          "ease-onscreen size-3 transition-transform duration-[150ms] motion-reduce:transition-none",
          expanded && "rotate-180",
        )}
      />
    </button>
  );
}

function ItemRow({
  job,
  item,
  index,
}: {
  job: TransferJobSnapshot;
  item: TransferItemSnapshot;
  index: number;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const state = itemDisplayState(job, item);
  const canExpand = state !== "enumerating" && state !== "waiting" && state !== "queued";
  const detailsId = `transfer-item-stats-${job.id}-${index}`;
  const pct = item.totalBytes > 0 ? Math.min(100, Math.floor((item.doneBytes / item.totalBytes) * 100)) : 0;
  const barPct = item.state === "completed" || item.state === "skipped" ? 100 : pct;
  const summary = itemSummary(item, state, job);
  const detail = itemDetail(job, item, state);
  const processedFiles = item.doneFiles + item.skippedFiles;
  const filesLabel = item.state === "skipped" ? `${item.skippedFiles} skipped` : `${processedFiles}/${item.totalFiles} files`;
  const itemTerminal =
    item.state === "completed" || item.state === "skipped" || item.state === "failed" || item.state === "canceled";
  const jobActive = !TERMINAL_TRANSFER_STATES.includes(job.state);
  const canPauseItem = jobActive && job.state === "running" && !item.paused && !itemTerminal;
  const canResumeItem = jobActive && item.paused;
  const canCancelItem = jobActive && !itemTerminal;
  const indeterminate = state === "queued" || state === "enumerating" || (item.totalBytes === 0 && !itemTerminal);

  return (
    <div
      role="listitem"
      className="flex items-start gap-3 border-t px-3 py-2 pl-11"
    >
      <StateIcon
        state={state}
        compact
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span
            className="truncate text-[12px] font-medium"
            title={item.name}
          >
            {item.name}
          </span>
          <span className="text-muted-foreground ml-auto hidden shrink-0 text-[11px] tabular-nums sm:inline">{summary}</span>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <div
            className="bg-foreground/10 h-1.5 flex-1 overflow-hidden rounded-full"
            role="progressbar"
            aria-label={`${item.name} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : barPct}
            aria-valuetext={item.state === "skipped" ? "Skipped" : progressValueText(state, barPct, item.totalBytes > 0)}
          >
            <div
              className={cn(
                "h-full rounded-full",
                state === "running" && "transition-[width] duration-300 ease-linear motion-reduce:transition-none",
                barTone(state),
              )}
              style={{ width: `${barPct}%` }}
            />
          </div>
          <span
            className={cn(
              "w-9 shrink-0 text-right text-xs font-medium tabular-nums",
              state === "failed" && "text-destructive",
              (state === "canceled" || state === "queued") && "text-muted-foreground",
            )}
          >
            {state === "enumerating" || state === "queued" ? "—" : `${barPct}%`}
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
            <AdvancedStatsToggle
              expanded={expanded}
              controls={detailsId}
              onClick={() => setExpanded(!expanded)}
            />
          )}
        </div>
        {expanded && canExpand && (
          <AdvancedStats
            id={detailsId}
            state={state}
            speedStats={item.speedStats}
            speedHistory={item.speedHistory}
            startedAt={item.startedAt ?? job.startedAt}
            finishedAt={item.finishedAt}
            totalBytes={item.totalBytes}
            doneBytes={item.doneBytes}
            totalFiles={item.totalFiles}
            doneFiles={item.doneFiles}
            skippedFiles={item.skippedFiles}
            verifying={!!item.verifyingFiles?.length}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {(canPauseItem || canResumeItem) && (
          <RowAction
            key="pause-resume"
            label={`${canResumeItem ? "Resume" : "Pause"} ${item.name}`}
            onClick={() => itemAction(job.id, item.name, canResumeItem ? "resume" : "pause")}
          >
            {canResumeItem ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </RowAction>
        )}
        {canCancelItem && (
          <RowAction
            label={`Cancel ${item.name}`}
            onClick={(event) => {
              focusJobPrimary(event.currentTarget);
              itemAction(job.id, item.name, "cancel");
            }}
          >
            <X className="size-3.5" />
          </RowAction>
        )}
      </div>
    </div>
  );
}

function JobRow({ job, index }: { job: TransferJobSnapshot; index: number }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const canExpand = job.state !== "queued" && job.state !== "enumerating" && job.state !== "waiting";
  const showJobStats = canExpand && job.items.length > 1;
  const detailsId = `transfer-stats-${job.id}`;
  const processedFiles = job.doneFiles + job.skippedFiles;
  const terminal = TERMINAL_TRANSFER_STATES.includes(job.state);
  const summary = jobSummary(job);
  const detail = jobDetail(job);
  const filesLabel =
    job.state === "queued"
      ? "—"
      : job.state === "enumerating"
        ? `${job.totalFiles} found`
        : job.state === "waiting"
          ? `${job.totalFiles} files`
          : `${processedFiles}/${job.totalFiles} files`;

  return (
    <div
      role="listitem"
      data-job-row=""
      className="animate-in fade-in slide-in-from-top-1 fill-mode-both ease-entrance border-t duration-[200ms] first:border-t-0"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
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
            {showJobStats && (
              <AdvancedStatsToggle
                expanded={expanded}
                controls={detailsId}
                onClick={() => setExpanded(!expanded)}
              />
            )}
          </div>
          {expanded && showJobStats && (
            <AdvancedStats
              id={detailsId}
              state={job.state}
              speedStats={job.speedStats}
              speedHistory={job.speedHistory}
              startedAt={job.startedAt}
              finishedAt={job.finishedAt}
              totalBytes={job.totalBytes}
              doneBytes={job.doneBytes}
              totalFiles={job.totalFiles}
              doneFiles={job.doneFiles}
              skippedFiles={job.skippedFiles}
              verifying={!!job.verifyingFiles?.length}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {(job.state === "running" || (job.state === "paused" && !job.autoPaused)) && (
            <RowAction
              key="pause-resume"
              label={job.state === "paused" ? "Resume transfer" : "Pause transfer"}
              onClick={(event) => {
                if (event.detail > 1) return;
                jobAction(job.id, job.state === "paused" ? "resume" : "pause");
              }}
            >
              {job.state === "paused" ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </RowAction>
          )}
          {(job.state === "failed" || job.state === "canceled") && (
            <RowAction
              key="retry"
              label="Retry transfer"
              onClick={(event) => {
                focusJobPrimary(event.currentTarget);
                jobAction(job.id, "retry");
              }}
            >
              <RotateCcw className="size-3.5" />
            </RowAction>
          )}
          <RowAction
            key="cancel-remove"
            primary
            label={terminal ? "Remove transfer from list" : "Cancel transfer"}
            onClick={(event) => {
              if (!terminal) return jobAction(job.id, "cancel");
              if (event.detail > 1 || Date.now() - (job.finishedAt ?? 0) < REMOVE_GUARD_MS) return;
              removeJob(job.id);
            }}
          >
            {terminal ? <Trash2 className="size-3.5" /> : <X className="size-3.5" />}
          </RowAction>
        </div>
      </div>
      {job.items.length > 0 && (
        <div
          role="list"
          aria-label={`${job.label} items`}
          className="border-t"
        >
          {job.items.map((item, index) => (
            <ItemRow
              key={`${item.name}-${index}`}
              job={job}
              item={item}
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function useToastClearance(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!active || !el) return;
    const update = (): void => root.style.setProperty(TOAST_CLEARANCE_VAR, `${el.offsetHeight + PANEL_GAP_PX}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(TOAST_CLEARANCE_VAR);
    };
  }, [ref, active]);
}

/**
 * Floating transfer panel in a bottom corner of the workspace. It expands when
 * a transfer starts and collapses to a summary card that stays out of the way
 * while the panes remain usable underneath.
 */
export function TransferPanel(): React.JSX.Element | null {
  const { jobs, panelExpanded, announcement } = useTransfers();
  const { transferPanelSide } = useAppState();
  const panelRef = useRef<HTMLElement>(null);
  useToastClearance(panelRef, jobs.length > 0 && transferPanelSide === "right");
  if (jobs.length === 0) return null;

  const active = jobs.filter((j) => !TERMINAL_TRANSFER_STATES.includes(j.state));
  const failed = jobs.filter((j) => j.state === "failed");
  const finished = jobs.filter((j) => TERMINAL_TRANSFER_STATES.includes(j.state));
  const totalBytes = active.reduce((a, j) => a + j.totalBytes, 0);
  const doneBytes = active.reduce((a, j) => a + j.doneBytes, 0);
  const pct = totalBytes > 0 ? Math.min(100, Math.floor((doneBytes / totalBytes) * 100)) : null;
  const activeSpeed = active.reduce((a, j) => a + (j.state === "running" ? j.bytesPerSec : 0), 0);
  const activeItems = active.reduce((a, j) => {
    const remaining = j.items.filter(
      (item) => item.state === "pending" || item.state === "running" || item.state === "paused",
    ).length;
    return a + Math.max(1, remaining);
  }, 0);
  const summary =
    active.length > 0
      ? `${activeItems} item${activeItems === 1 ? "" : "s"} · ${active.some((job) => job.verifyingFiles?.length) ? "Verifying…" : `${pct ?? 0}%`}`
      : `${jobs.length} finished`;
  const toggleLabel = panelExpanded ? "Collapse transfers" : "Expand transfers";

  return (
    <section
      ref={panelRef}
      aria-label="Transfer queue"
      className={cn(
        "pallet-popover animate-in fade-in slide-in-from-bottom-2 ease-entrance absolute bottom-3 z-40 flex max-h-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[14px] border duration-[240ms]",
        "ease-onscreen transition-[width] motion-reduce:animate-none motion-reduce:transition-none",
        transferPanelSide === "left" ? "left-3" : "right-3",
        panelExpanded
          ? "w-[min(30rem,calc(100%-1.5rem))] duration-[240ms]"
          : "w-[min(22rem,calc(100%-1.5rem))] duration-[190ms]",
      )}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !panelExpanded) return;
        event.stopPropagation();
        setPanelExpanded(false);
      }}
    >
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
      >
        {announcement}
      </p>
      <div
        className={cn("flex h-10 shrink-0 items-center gap-2 pr-1.5 pl-3", !panelExpanded && "cursor-pointer")}
        onClick={panelExpanded ? undefined : () => setPanelExpanded(true)}
      >
        <ArrowLeftRight
          className={cn("size-3.5 shrink-0", active.length > 0 ? "text-primary" : "text-muted-foreground")}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 items-baseline gap-2 text-xs">
          <span className="text-foreground shrink-0 font-medium">Transfers</span>
          <span className="text-muted-foreground truncate">{summary}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {activeSpeed > 0 && (
            <span className="text-muted-foreground text-[11px] tabular-nums">{formatSpeed(activeSpeed)}</span>
          )}
          {failed.length > 0 && (
            <span className="text-destructive flex items-center gap-1 text-[11px]">
              <AlertCircle className="size-3" /> {failed.length} failed
            </span>
          )}
          {panelExpanded && finished.length > 0 && (
            <button
              type="button"
              className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring rounded px-1.5 py-0.5 text-[11px] transition-colors duration-[140ms] focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
              aria-label="Clear finished transfers"
              onClick={clearFinishedJobs}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring grid size-6 place-items-center rounded-md transition-colors duration-[140ms] focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none"
            aria-label={toggleLabel}
            title={toggleLabel}
            aria-expanded={panelExpanded}
            aria-controls={LIST_ID}
            onClick={(event) => {
              event.stopPropagation();
              setPanelExpanded(!panelExpanded);
            }}
          >
            {panelExpanded ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
        </div>
      </div>
      {active.length > 0 && (
        <div
          className="bg-foreground/10 h-0.5 shrink-0"
          role="progressbar"
          aria-label="Overall transfer progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct ?? undefined}
          aria-valuetext={summary}
        >
          <div
            className="bg-primary h-full transition-[width] duration-300 ease-linear motion-reduce:transition-none"
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      )}
      <div
        className={cn(
          "ease-onscreen min-h-0 overflow-hidden transition-[height] [interpolate-size:allow-keywords] motion-reduce:transition-none",
          panelExpanded ? "h-auto duration-[240ms]" : "h-0 duration-[190ms]",
        )}
      >
        <div
          id={LIST_ID}
          role="list"
          className="bg-popover max-h-[calc(100vh-11rem)] overflow-y-auto overscroll-contain border-t"
          aria-hidden={!panelExpanded || undefined}
          inert={!panelExpanded}
        >
          {jobs.map((job, index) => (
            <JobRow
              key={job.id}
              job={job}
              index={index}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
