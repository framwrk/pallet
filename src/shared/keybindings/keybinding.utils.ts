import {
  CODE_KEYS,
  COMMAND_BY_ID,
  COMMAND_TITLES,
  KEYBINDING_COMMANDS,
  KEY_ALIASES,
  KEY_LABELS,
  LOCKED_KEYS,
  MODIFIER_ALIASES,
  MODIFIER_LABELS,
  RESERVED_KEYS,
  SPECIAL_KEYS,
  SUPPORTED_KEYS,
  defaultBindings,
} from "./keybinding.constants";
import type { CommandBindings, CommandId, KeyIssue, KeybindingIssue } from "./keybinding.types";

const MODIFIER_ORDER = ["cmd", "ctrl", "alt", "shift"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function titleOf(id: CommandId): string {
  return COMMAND_TITLES.get(id) ?? id;
}

/** Normalize aliases, modifier order, and case. Null when unparseable. */
export function parseKey(input: string): string | null {
  if (typeof input !== "string") return null;
  const tokens = input
    .trim()
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  if (tokens.length === 0 || tokens[tokens.length - 1] === "") return null;

  const modifiers = new Set<string>();
  for (const token of tokens.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[token];
    if (!modifier || modifiers.has(modifier)) return null;
    modifiers.add(modifier);
  }

  const rawKey = tokens[tokens.length - 1];
  const key = KEY_ALIASES[rawKey] ?? rawKey;
  if (!SUPPORTED_KEYS.has(key)) return null;

  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

export function displayParts(key: string): string[] {
  const parts = key.split("+");
  return parts.map((part) => MODIFIER_LABELS[part] ?? KEY_LABELS[part] ?? part.toUpperCase());
}

export function formatKey(key: string): string {
  return displayParts(key).join("");
}

/** Why one key cannot be used, or null when it can. */
export function validateKey(key: string, options: { allowEscape: boolean }): KeyIssue | null {
  const canonical = parseKey(key);
  if (canonical === null) {
    return { code: "unsupported", message: "That key isn’t supported" };
  }
  const parts = canonical.split("+");
  const base = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  if (base === "escape" && !options.allowEscape) {
    return { code: "escapeReserved", message: "Escape cancels recording; set it in keybindings.json" };
  }
  if (LOCKED_KEYS.has(canonical)) {
    return { code: "locked", message: "This key is fixed by Pallet" };
  }
  if (RESERVED_KEYS.has(canonical)) {
    return { code: "reserved", message: `${formatKey(canonical)} is reserved` };
  }
  if (
    !SPECIAL_KEYS.has(base) &&
    !modifiers.some((modifier) => modifier === "cmd" || modifier === "ctrl" || modifier === "alt")
  ) {
    return { code: "needsModifier", message: "Add ⌘, ⌃, or ⌥ to letter keys" };
  }
  return null;
}

/**
 * Turn the JSON file's overrides into the effective bindings. Bad entries are
 * skipped and reported; each key belongs to the first command that claims it
 * in registry order.
 */
export function resolveBindings(overrides: unknown): {
  effective: CommandBindings;
  overrides: Partial<CommandBindings>;
  issues: KeybindingIssue[];
} {
  const issues: KeybindingIssue[] = [];
  const source = isPlainObject(overrides) ? overrides : {};
  if (overrides !== undefined && overrides !== null && !isPlainObject(overrides)) {
    issues.push({ code: "shape", message: "keybindings.json must contain a JSON object" });
  }

  for (const id of Object.keys(source)) {
    if (!COMMAND_BY_ID.has(id as CommandId)) {
      issues.push({ code: "unknownCommand", command: id, message: `Unknown command “${id}”` });
    }
  }

  const sanitized: Partial<CommandBindings> = {};
  for (const command of KEYBINDING_COMMANDS) {
    if (!Object.prototype.hasOwnProperty.call(source, command.id)) continue;
    const value = source[command.id];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      issues.push({ code: "notArray", command: command.id, message: `${command.id} must be an array of key strings` });
      continue;
    }

    const keys: string[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
      const parsed = parseKey(raw);
      if (parsed === null) {
        issues.push({ code: "invalidKey", command: command.id, message: `${raw}: that key isn’t supported` });
        continue;
      }
      const issue = validateKey(parsed, { allowEscape: true });
      if (issue !== null) {
        issues.push({ code: "invalidKey", command: command.id, key: parsed, message: `${raw}: ${issue.message}` });
        continue;
      }
      if (seen.has(parsed)) {
        issues.push({
          code: "duplicate",
          command: command.id,
          key: parsed,
          message: `${command.title}: ${parsed} appears more than once`,
        });
        continue;
      }
      seen.add(parsed);
      keys.push(parsed);
    }
    sanitized[command.id] = keys;
  }

  const effective = defaultBindings();
  for (const command of KEYBINDING_COMMANDS) {
    if (Object.prototype.hasOwnProperty.call(sanitized, command.id)) {
      effective[command.id] = sanitized[command.id]!;
    }
  }

  const claimed = new Map<string, CommandId>();
  for (const command of KEYBINDING_COMMANDS) {
    const kept: string[] = [];
    for (const key of effective[command.id]) {
      const owner = claimed.get(key);
      if (owner) {
        issues.push({
          code: "conflict",
          command: command.id,
          key,
          message: `${key} is already used by ${titleOf(owner)}`,
        });
        continue;
      }
      claimed.set(key, command.id);
      kept.push(key);
    }
    effective[command.id] = kept;
  }

  return { effective, overrides: sanitized, issues };
}

/** The command that already owns `key`, or null. */
export function findConflict(effective: CommandBindings, commandId: CommandId, key: string): CommandId | null {
  for (const command of KEYBINDING_COMMANDS) {
    if (command.id === commandId) continue;
    if (effective[command.id].includes(key)) return command.id;
  }
  return null;
}

/** Canonical key for a keyboard event, or null for modifiers/unsupported codes. */
export function eventToKey(event: {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const key = CODE_KEYS[event.code];
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("cmd");
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  return [...modifiers, key].join("+");
}

const ACCELERATOR_KEYS: Record<string, string> = {
  enter: "Return",
  escape: "Escape",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

const ACCELERATOR_MODIFIERS: Record<string, string> = {
  cmd: "Cmd",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

/** Electron accelerator string for a canonical key. */
export function toAccelerator(key: string): string {
  return key
    .split("+")
    .map((part) => {
      if (ACCELERATOR_MODIFIERS[part]) return ACCELERATOR_MODIFIERS[part];
      if (ACCELERATOR_KEYS[part]) return ACCELERATOR_KEYS[part];
      if (part.length === 1) return part.toUpperCase();
      return part.toUpperCase();
    })
    .join("+");
}

/** The whole keybindings.json file: registry order, 2-space JSON, trailing newline. */
export function serializeOverrides(overrides: Partial<CommandBindings>): string {
  const ordered: Partial<CommandBindings> = {};
  for (const command of KEYBINDING_COMMANDS) {
    const keys = overrides[command.id];
    if (keys === undefined) continue;
    if (keys.length === command.defaults.length && keys.every((key, index) => key === command.defaults[index])) continue;
    ordered[command.id] = keys;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
