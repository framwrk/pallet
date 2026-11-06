/** Transfer constants shared by the queue, edit sessions, and the drawer UI. */
import type { TransferState } from "./transfer.types";

/** States a job never leaves on its own; reaching one means the job is done. */
export const TERMINAL_TRANSFER_STATES: readonly TransferState[] = ["completed", "failed", "canceled"];

/** Staging suffix for a partial write, renamed into place on success (§3.4). */
export const PART_SUFFIX = ".pallet-part";

/** Trailing window for the drawer's recent average and median speed. */
export const SPEED_STATS_WINDOW_MS = 30_000;

/**
 * Most points the expanded row's whole-transfer speed graph keeps before it
 * downsamples. One-second points stay exact until this threshold.
 */
export const SPEED_GRAPH_MAX_POINTS = 240;
