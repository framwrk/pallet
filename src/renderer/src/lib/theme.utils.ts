import type { Appearance } from "@shared/prefs/prefs.types";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let appearance: Appearance = "system";

function apply(): void {
  const dark = appearance === "dark" || (appearance === "system" && darkQuery.matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Applies the stored appearance and keeps this window following it — both the
 * system setting and changes made in the settings window.
 */
export function initTheme(): void {
  apply();
  darkQuery.addEventListener("change", apply);
  window.pallet.prefs.onChange((prefs) => {
    appearance = prefs.appearance;
    apply();
  });
  void window.pallet.prefs.get().then((prefs) => {
    appearance = prefs.appearance;
    apply();
  });
}
