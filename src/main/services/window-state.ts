import { type BrowserWindow, type Rectangle, screen } from "electron";
import { getPreferenceRow, setPreferenceRow } from "./prefs-store";

interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

const WINDOW_STATE_KEY = "window.state";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readWindowState(): WindowState | null {
  const raw = getPreferenceRow(WINDOW_STATE_KEY);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { bounds, maximized } = value as Record<string, unknown>;
    if (typeof bounds !== "object" || bounds === null) return null;
    const { x, y, width, height } = bounds as Record<string, unknown>;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { bounds: { x, y, width, height }, maximized: maximized === true };
  } catch {
    return null;
  }
}

function clampToDisplay(bounds: Rectangle): Rectangle {
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

/** The frame to open with, or an empty placement on first launch. */
export function restoreWindowState(): { bounds: Partial<Rectangle>; maximized: boolean } {
  const saved = readWindowState();
  if (saved === null) return { bounds: {}, maximized: false };
  return { bounds: clampToDisplay(saved.bounds), maximized: saved.maximized };
}

/** Persists the frame on move and resize, and one last time on close. */
export function trackWindowState(win: BrowserWindow): void {
  const save = (): void => {
    if (win.isDestroyed()) return;
    const bounds = win.getNormalBounds();
    // Fullscreen can report an empty normal frame; keep the previous state.
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const state: WindowState = { bounds, maximized: win.isMaximized() };
    try {
      setPreferenceRow(WINDOW_STATE_KEY, JSON.stringify(state));
    } catch {
      // A failed write costs the next launch only its remembered frame.
    }
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      save();
    }, 300);
  };

  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("close", () => {
    if (timer !== null) clearTimeout(timer);
    save();
  });
}
