/** Transfer constants shared by the queue, edit sessions, and the drawer UI. */
import type { TransferState } from "./transfer.types";

/** States a job never leaves on its own; reaching one means the job is done. */
export const TERMINAL_TRANSFER_STATES: readonly TransferState[] = ["completed", "failed", "canceled"];

/** Staging suffix for a partial write, renamed into place on success (§3.4). */
export const PART_SUFFIX = ".pallet-part";
