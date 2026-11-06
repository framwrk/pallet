import { type SpeedSample, downsampleSpeedHistory, speedStatsFromSamples } from "../src/main/services/transfer/transfer-speed";
import { describe, expect, test } from "bun:test";
import { SPEED_STATS_WINDOW_MS } from "../src/shared/transfer/transfer.constants";

/** Build one-second samples at the given bytes-per-second rates. */
function samplesFromRates(rates: readonly number[], startBytes = 0): SpeedSample[] {
  const samples: SpeedSample[] = [{ bytes: startBytes, activeMs: 0 }];
  let bytes = startBytes;
  for (const rate of rates) {
    bytes += rate;
    samples.push({ bytes, activeMs: 1_000 });
  }
  return samples;
}

describe("speedStatsFromSamples", () => {
  test("reports averages and medians for a steady transfer", () => {
    const stats = speedStatsFromSamples(samplesFromRates([1_000, 1_000, 1_000, 1_000]));
    expect(stats.averageBytesPerSec).toBe(1_000);
    expect(stats.medianBytesPerSec).toBe(1_000);
    expect(stats.recentAverageBytesPerSec).toBe(1_000);
    expect(stats.recentMedianBytesPerSec).toBe(1_000);
  });

  test("median ignores a burst that skews the average", () => {
    const stats = speedStatsFromSamples(samplesFromRates([1_000, 1_000, 1_000, 3_000]));
    expect(stats.averageBytesPerSec).toBe(1_500);
    expect(stats.medianBytesPerSec).toBe(1_000);
    expect(stats.recentAverageBytesPerSec).toBe(1_500);
    expect(stats.recentMedianBytesPerSec).toBe(1_000);
  });

  test("recent stats only cover the trailing window", () => {
    const windowSamples = SPEED_STATS_WINDOW_MS / 1_000;
    const rates = [...Array<number>(windowSamples).fill(1_000), ...Array<number>(windowSamples).fill(2_000)];
    const stats = speedStatsFromSamples(samplesFromRates(rates));
    expect(stats.averageBytesPerSec).toBe(1_500);
    expect(stats.medianBytesPerSec).toBe(1_500);
    expect(stats.recentAverageBytesPerSec).toBe(2_000);
    expect(stats.recentMedianBytesPerSec).toBe(2_000);
  });

  test("counts retried bytes instead of subtracting a rollback", () => {
    const stats = speedStatsFromSamples([
      { bytes: 1_000, activeMs: 0 },
      { bytes: 500, activeMs: 1_000 },
      { bytes: 1_500, activeMs: 1_000 },
      { bytes: 3_500, activeMs: 1_000 },
    ]);
    expect(stats.averageBytesPerSec).toBe(1_000);
    expect(stats.medianBytesPerSec).toBe(1_000);
  });

  test("does not mix pre-gap speeds into the recent window", () => {
    const stats = speedStatsFromSamples([
      { bytes: 0, activeMs: 0 },
      { bytes: 5_000, activeMs: 1_000 },
      { bytes: 10_000, activeMs: 1_000 },
      { bytes: 10_000, activeMs: 0 },
      { bytes: 11_000, activeMs: 1_000 },
    ]);
    expect(stats.averageBytesPerSec).toBeCloseTo(11_000 / 3);
    expect(stats.medianBytesPerSec).toBe(5_000);
    expect(stats.recentAverageBytesPerSec).toBe(1_000);
    expect(stats.recentMedianBytesPerSec).toBe(1_000);
  });

  test("returns zeros until there are two samples", () => {
    expect(speedStatsFromSamples([])).toEqual({
      averageBytesPerSec: 0,
      medianBytesPerSec: 0,
      recentAverageBytesPerSec: 0,
      recentMedianBytesPerSec: 0,
    });
    expect(speedStatsFromSamples([{ bytes: 5_000, activeMs: 0 }]).averageBytesPerSec).toBe(0);
  });
});

describe("downsampleSpeedHistory", () => {
  test("keeps every one-second point until the graph threshold", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ elapsedMs: i * 1_000, bytesPerSec: 1_000 }));
    expect(downsampleSpeedHistory(points, 10)).toEqual(points);
  });

  test("covers the whole transfer and preserves peaks", () => {
    const points = Array.from({ length: 1_000 }, (_, i) => ({
      elapsedMs: i * 1_000,
      bytesPerSec: i === 900 ? 9_000 : 1_000,
    }));
    const sampled = downsampleSpeedHistory(points, 10);

    expect(sampled).toHaveLength(10);
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled[sampled.length - 1]).toEqual(points[points.length - 1]);
    expect(sampled.some((point) => point.bytesPerSec === 9_000)).toBe(true);
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i].elapsedMs).toBeGreaterThan(sampled[i - 1].elapsedMs);
    }
  });
});
