/** Transfer queue types shared between main and renderer (M5). */

export type EndpointRef = { kind: "local" } | { kind: "sftp"; sessionId: string };

export interface TransferRequest {
  from: EndpointRef;
  to: EndpointRef;
  /** Directory containing the selected items. */
  sourceBase: string;
  /** Selected item names within sourceBase. */
  names: string[];
  destDir: string;
}

export type TransferState = "enumerating" | "waiting" | "running" | "paused" | "completed" | "failed" | "canceled";

export interface TransferError {
  relPath: string;
  message: string;
}

/** Throughput stats in bytes per second, shown when a transfer row is expanded. */
export interface TransferSpeedStats {
  /** Mean throughput while running. */
  averageBytesPerSec: number;
  /** Median of the one-second throughput samples. */
  medianBytesPerSec: number;
  /** Mean throughput over the trailing speed window. */
  recentAverageBytesPerSec: number;
  /** Median throughput over the trailing speed window. */
  recentMedianBytesPerSec: number;
}

/** State of one selected item (file or folder) inside a transfer job. */
export type TransferItemState = "pending" | "running" | "completed" | "skipped" | "failed" | "canceled";

/** Per-item progress so the drawer can show a row, bar, and stats per selection. */
export interface TransferItemSnapshot {
  /** Top-level selected name, relative to the job's source base. */
  name: string;
  state: TransferItemState;
  totalFiles: number;
  doneFiles: number;
  skippedFiles: number;
  totalBytes: number;
  doneBytes: number;
  bytesPerSec: number;
  speedStats: TransferSpeedStats;
  startedAt?: number;
  finishedAt?: number;
  /** First error for this item, if it failed. */
  error?: string;
}

export interface TransferJobSnapshot {
  id: string;
  state: TransferState;
  /** True when paused by a connection drop rather than the user. */
  autoPaused: boolean;
  label: string;
  /** When the job was enqueued, in epoch milliseconds. */
  startedAt: number;
  /** When the job reached a terminal state, so elapsed time stays fixed. */
  finishedAt?: number;
  destDir: string;
  totalFiles: number;
  doneFiles: number;
  skippedFiles: number;
  totalBytes: number;
  doneBytes: number;
  bytesPerSec: number;
  speedStats: TransferSpeedStats;
  /** Relative paths currently in flight. */
  currentFiles: string[];
  errors: TransferError[];
  /** One entry per selected item, in selection order. */
  items: TransferItemSnapshot[];
}

export type ConflictAction = "replace" | "skip" | "keepBoth";

export interface ConflictPrompt {
  jobId: string;
  relPath: string;
  source: { size: number; mtimeMs: number };
  dest: { size: number; mtimeMs: number };
  /** Undecided conflicts left in this job, including this one. */
  remaining: number;
}
