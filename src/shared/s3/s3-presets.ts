/**
 * Provider presets on top of the generic S3 connection. A preset only derives
 * the endpoint from the region and relabels the credential fields; the saved
 * favorite still stores the derived endpoint, so connecting never needs it.
 */
export interface S3Preset {
  id: string;
  label: string;
  /** `{region}` is replaced with the entered region. */
  endpointTemplate: string;
  regionPlaceholder: string;
  keyIdLabel: string;
  secretLabel: string;
}

export const S3_PRESETS: readonly S3Preset[] = [
  {
    id: "b2",
    label: "Backblaze B2",
    endpointTemplate: "https://s3.{region}.backblazeb2.com",
    regionPlaceholder: "us-west-004",
    keyIdLabel: "Key ID",
    secretLabel: "Application key",
  },
];

export function findS3Preset(id: string | undefined): S3Preset | undefined {
  return id ? S3_PRESETS.find((preset) => preset.id === id) : undefined;
}

/** The lowercase region, or null when it is not one DNS label. */
export function normalizePresetRegion(region: string): string | null {
  const value = region.trim().toLowerCase();
  return value.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : null;
}

/** The preset's endpoint for a region, or null when the region is not one DNS label. */
export function presetEndpoint(preset: S3Preset, region: string): string | null {
  const value = normalizePresetRegion(region);
  return value ? preset.endpointTemplate.replace("{region}", value) : null;
}
