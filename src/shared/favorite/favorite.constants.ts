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
  red: "bg-favorite-label-red",
  orange: "bg-favorite-label-orange",
  yellow: "bg-favorite-label-yellow",
  green: "bg-favorite-label-green",
  blue: "bg-favorite-label-blue",
  purple: "bg-favorite-label-purple",
  gray: "bg-favorite-label-gray",
};
