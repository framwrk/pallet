/** Favorite colour labels: the palette's order, and the swatch class for each. */
import type { ColorLabel } from "./favorite.types";

/** Palette order, as the connect dialog lays the swatches out. */
export const COLOR_LABELS: readonly ColorLabel[] = ["none", "red", "orange", "yellow", "green", "blue", "purple", "gray"];

/**
 * `none` is the picker's empty swatch — an outline, not a colour. Nothing else
 * renders it: the sidebar dot is omitted entirely for an unlabelled favorite.
 */
export const LABEL_COLOR_CLASSES: Record<ColorLabel, string> = {
  none: "bg-transparent border border-border",
  red: "bg-red-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-400",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  gray: "bg-gray-400",
};
