/**
 * Renderer keybinding state: the effective bindings, a key → command lookup
 * for the dispatcher, and the recorder suspension flag.
 */
import type { CommandId, KeybindingsState } from "@shared/keybindings/keybinding.types";
import { KEYBINDING_COMMANDS, defaultBindings } from "@shared/keybindings/keybinding.constants";
import { pushToast } from "./pane.store";
import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();

let state: KeybindingsState = {
  effective: defaultBindings(),
  overrides: {},
  issues: [],
  syntaxError: null,
  path: "",
};
let lookup = new Map<string, CommandId>();
let recording = false;
let bound = false;

function rebuildLookup(effective: KeybindingsState["effective"]): void {
  lookup = new Map();
  for (const command of KEYBINDING_COMMANDS) {
    for (const key of effective[command.id]) {
      if (!lookup.has(key)) lookup.set(key, command.id);
    }
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function adopt(next: KeybindingsState): void {
  const previousError = state.syntaxError;
  state = next;
  rebuildLookup(next.effective);
  emit();
  if (next.syntaxError && next.syntaxError !== previousError) {
    pushToast("keybindings.json has a syntax error; using the last valid keybindings.");
  }
}

export function useKeybindings(): KeybindingsState {
  return useSyncExternalStore(subscribe, () => state);
}

export function getKeybindings(): KeybindingsState {
  return state;
}

export function getKeybindingLookup(): Map<string, CommandId> {
  return lookup;
}

export function isKeybindingRecorderOpen(): boolean {
  return recording;
}

/** Bind main-process keybinding events once, at app startup. */
export function initKeybindings(): void {
  if (bound) return;
  bound = true;
  rebuildLookup(state.effective);
  void window.pallet.keybindings.get().then(adopt);
  window.pallet.keybindings.onChange(adopt);
}

/** Tell main to suspend the customizable menu accelerators while recording. */
export function setKeybindingRecording(active: boolean): void {
  if (recording === active) return;
  recording = active;
  void window.pallet.keybindings.setRecording(active).catch(() => {
    // The menu suspension is best-effort; the recorder still captures the key.
  });
}
