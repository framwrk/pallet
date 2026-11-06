/**
 * Pure throughput statistics for the transfer drawer. The queue stores one
 * sample per second while a job runs; this module turns those samples into the
 * average/median figures shown when a row is expanded.
 */
import { SPEED_GRAPH_MAX_POINTS, SPEED_STATS_WINDOW_MS } from "@shared/transfer/transfer.constants";
import type { TransferSpeedPoint, TransferSpeedStats } from "@shared/transfer/transfer.types";

export interface SpeedSample {
  /** Confirmed progress bytes at this sample. */
  bytes: number;
  /** Active transfer time since the previous sample; 0 for the first. */
  activeMs: number;
}

export const ZERO_SPEED_STATS: TransferSpeedStats = {
  averageBytesPerSec: 0,
  medianBytesPerSec: 0,
  recentAverageBytesPerSec: 0,
  recentMedianBytesPerSec: 0,
};

/**
 * Keep a whole-transfer speed graph bounded without hiding bursts: each bucket
 * contributes its peak, so the overall shape and duration stay intact.
 */
export function downsampleSpeedHistory(
  points: readonly TransferSpeedPoint[],
  maxPoints = SPEED_GRAPH_MAX_POINTS,
): TransferSpeedPoint[] {
  if (points.length <= maxPoints) return [...points];
  if (maxPoints <= 2) return [points[0], points[points.length - 1]];

  const buckets = maxPoints - 2;
  const interior = points.slice(1, -1);
  const result: TransferSpeedPoint[] = [points[0]];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor((bucket * interior.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * interior.length) / buckets));
    let peak = interior[start];
    for (let i = start + 1; i < end; i++) {
      if (interior[i].bytesPerSec > peak.bytesPerSec) peak = interior[i];
    }
    result.push(peak);
  }
  result.push(points[points.length - 1]);
  return result;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function speedStatsFromSamples(samples: readonly SpeedSample[], windowMs = SPEED_STATS_WINDOW_MS): TransferSpeedStats {
  if (samples.length < 2) return ZERO_SPEED_STATS;

  const rates: number[] = [];
  let totalBytes = 0;
  let totalMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const activeMs = samples[i].activeMs;
    if (activeMs <= 0) continue;
    // A rollback can lower doneBytes between samples, so count progress rather
    // than a negative delta; retried bytes still count as throughput.
    const bytes = Math.max(0, samples[i].bytes - samples[i - 1].bytes);
    totalBytes += bytes;
    totalMs += activeMs;
    rates.push((bytes / activeMs) * 1000);
  }
  if (totalMs === 0) return ZERO_SPEED_STATS;

  let recentBytes = 0;
  let recentMs = 0;
  const recentRates: number[] = [];
  for (let i = samples.length - 1; i >= 1; i--) {
    const activeMs = samples[i].activeMs;
    // A zero-duration sample marks a pause or sampling gap; stop rather than
    // mixing pre-gap speeds into the trailing window.
    if (activeMs <= 0) break;
    // Always keep at least one interval, even when a caller shrinks the
    // window below the sampling cadence.
    if (recentMs > 0 && recentMs + activeMs > windowMs) break;
    const bytes = Math.max(0, samples[i].bytes - samples[i - 1].bytes);
    recentBytes += bytes;
    recentMs += activeMs;
    recentRates.push((bytes / activeMs) * 1000);
  }

  return {
    averageBytesPerSec: (totalBytes / totalMs) * 1000,
    medianBytesPerSec: median(rates),
    recentAverageBytesPerSec: recentMs > 0 ? (recentBytes / recentMs) * 1000 : 0,
    recentMedianBytesPerSec: median(recentRates),
  };
}
