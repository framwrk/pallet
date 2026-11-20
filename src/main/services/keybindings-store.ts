import { COMMAND_BY_ID, COMMAND_TITLES, defaultBindings } from "@shared/keybindings/keybinding.constants";
import type { CommandId, KeybindingsState } from "@shared/keybindings/keybinding.types";
import { type FSWatcher, existsSync, readFileSync, renameSync, watch, writeFileSync } from "fs";
import { app, shell } from "electron";
import { dirname, join } from "path";
import {
  findConflict,
  formatKey,
  parseKey,
  resolveBindings,
  serializeOverrides,
  validateKey,
} from "@shared/keybindings/keybinding.utils";
import { log } from "./logger";

const FILE_NAME = "keybindings.json";
const WATCH_DEBOUNCE_MS = 100;

type StateListener = (state: KeybindingsState) => void;
type RecordingListener = (recording: boolean) => void;

const stateListeners = new Set<StateListener>();
const recordingListeners = new Set<RecordingListener>();

function keybindingsPath(): string {
  return join(app.getPath("userData"), FILE_NAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function buildState(overrides: unknown, syntaxError: string | null): KeybindingsState {
  const resolved = resolveBindings(overrides);
  return {
    effective: resolved.effective,
    overrides: resolved.overrides,
    issues: resolved.issues,
    syntaxError,
    path: keybindingsPath(),
  };
}

let state: KeybindingsState = {
  effective: defaultBindings(),
  overrides: {},
  issues: [],
  syntaxError: null,
  path: "",
};
let loaded = false;
let watcher: FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let lastApplied: string | null = null;
let recording = false;

function emit(): void {
  for (const listener of stateListeners) listener(state);
}

function publish(next: KeybindingsState): void {
  state = next;
  emit();
}

function keybindingError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = "EKEYBINDING";
  return error;
}

function writeOverrides(next: Partial<Record<CommandId, string | null>>): void {
  const text = serializeOverrides(next);
  const target = keybindingsPath();
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, target);
  lastApplied = text;
  publish(buildState(JSON.parse(text), null));
}

function reload(initial: boolean): void {
  const previous = state;
  let raw: string;
  try {
    raw = readFileSync(keybindingsPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      lastApplied = null;
      publish(buildState({}, null));
      return;
    }
    publish({ ...previous, syntaxError: (err as Error).message });
    return;
  }
  // The watcher sees Pallet's own atomic write too. Content the current state
  // already reflects is a no-op; suppress it, but never suppress the same text
  // after an intermediate edit or while a syntax error still needs clearing.
  if (raw === lastApplied && previous.syntaxError === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    publish({ ...previous, syntaxError: (err as Error).message });
    return;
  }
  if (!isPlainObject(parsed)) {
    publish({ ...previous, syntaxError: "keybindings.json must contain a JSON object" });
    return;
  }
  lastApplied = raw;
  publish(buildState(parsed, null));
  if (!initial) log("keybindings reloaded");
}

export function loadKeybindings(): void {
  if (loaded) return;
  loaded = true;
  reload(true);
}

export function getKeybindingsState(): KeybindingsState {
  if (!loaded) loadKeybindings();
  return state;
}

export function onKeybindingsChange(listener: StateListener): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function isKeybindingRecording(): boolean {
  return recording;
}

export function onKeybindingRecordingChange(listener: RecordingListener): () => void {
  recordingListeners.add(listener);
  return () => recordingListeners.delete(listener);
}

export function setKeybindingRecording(active: boolean): void {
  if (recording === active) return;
  recording = active;
  for (const listener of recordingListeners) listener(recording);
}

/** Validate and persist one command's shortcut; main never trusts the renderer. */
export function setCommandKey(id: CommandId, key: unknown): void {
  const command = COMMAND_BY_ID.get(id);
  if (!command) throw keybindingError(`Unknown command: ${String(id)}`);
  if (key === null) {
    writeOverrides({ ...state.overrides, [id]: null });
    return;
  }
  if (typeof key !== "string") throw keybindingError("A shortcut must be a key string or null");

  const parsed = parseKey(key);
  if (parsed === null) throw keybindingError(`That key isn’t supported: ${key}`);
  const issue = validateKey(parsed, { allowEscape: false });
  if (issue !== null) throw keybindingError(issue.message);
  const conflict = findConflict(state.effective, id, parsed);
  if (conflict) {
    throw keybindingError(`${formatKey(parsed)} is already used by ${COMMAND_TITLES.get(conflict) ?? conflict}`);
  }

  writeOverrides({ ...state.overrides, [id]: parsed });
}

export function resetCommand(id: CommandId): void {
  if (!Object.prototype.hasOwnProperty.call(state.overrides, id)) return;
  const next = { ...state.overrides };
  delete next[id];
  writeOverrides(next);
}

export function resetAll(): void {
  writeOverrides({});
}

/** Open the overrides file, creating it empty when it does not exist yet. */
export async function openKeybindingsFile(): Promise<void> {
  const target = keybindingsPath();
  if (!existsSync(target)) {
    const text = "{}\n";
    writeFileSync(target, text);
  }
  const error = await shell.openPath(target);
  if (error) {
    shell.showItemInFolder(target);
    throw keybindingError(error);
  }
}

/** Watch userData (not the file, which an atomic rename replaces) for edits. */
export function watchKeybindings(): void {
  if (watcher) return;
  const target = keybindingsPath();
  watcher = watch(dirname(target), (_event, filename) => {
    if (filename && filename !== FILE_NAME) return;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = null;
      reload(false);
    }, WATCH_DEBOUNCE_MS);
  });
}

export function stopWatchingKeybindings(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  watcher?.close();
  watcher = null;
}
