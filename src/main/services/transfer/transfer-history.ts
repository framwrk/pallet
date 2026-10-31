/**
 * Diagnostic transfer history. Rows are written once a job reaches a terminal
 * state; the Settings Advanced tab points users at the database rather than
 * rendering this table in the app.
 */
import type { EndpointRef, TransferJobSnapshot, TransferRequest } from "@shared/transfer/transfer.types";
import { getDb } from "../database";

export type TransferDirection = "upload" | "download" | "remote-to-remote" | "local";

export function transferDirection(from: EndpointRef, to: EndpointRef): TransferDirection {
  if (from.kind === "local") return to.kind === "local" ? "local" : "upload";
  return to.kind === "local" ? "download" : "remote-to-remote";
}

function endpointRef(ref: EndpointRef, path: string): string {
  return JSON.stringify(ref.kind === "sftp" ? { kind: ref.kind, sessionId: ref.sessionId, path } : { kind: ref.kind, path });
}

export function recordTransferHistory(job: TransferJobSnapshot, request: TransferRequest): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO transfer_history (direction, source, dest, bytes, status, error, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transferDirection(request.from, request.to),
        endpointRef(request.from, request.sourceBase),
        endpointRef(request.to, request.destDir),
        job.doneBytes,
        job.state,
        job.errors[0]?.message ?? null,
        job.startedAt,
        Date.now(),
      );
  } catch {
    // History is best-effort; never fail a transfer over it.
  }
}
