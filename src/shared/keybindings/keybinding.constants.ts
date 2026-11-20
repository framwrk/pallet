import type { CommandBindings, CommandGroup, KeybindingCommand, LockedKeybinding } from "./keybinding.types";

/** Registry order is the file order and the claim order for conflicts. */
export const KEYBINDING_COMMANDS: readonly KeybindingCommand[] = [
  {
    id: "navigation.open",
    group: "Navigation",
    title: "Open",
    defaultKey: "cmd+down",
    scope: "files",
  },
  {
    id: "navigation.goUp",
    group: "Navigation",
    title: "Go to Parent Folder",
    defaultKey: "cmd+up",
    scope: "files",
  },
  {
    id: "navigation.switchPane",
    group: "Navigation",
    title: "Switch Active Pane",
    defaultKey: "tab",
    scope: "pane-switch",
  },
  {
    id: "navigation.goToFolder",
    group: "Navigation",
    title: "Go to Folder",
    defaultKey: "cmd+shift+g",
    scope: "files",
  },
  {
    id: "navigation.refresh",
    group: "Navigation",
    title: "Refresh",
    defaultKey: "cmd+r",
    scope: "files",
  },
  {
    id: "navigation.selectAll",
    group: "Navigation",
    title: "Select All",
    defaultKey: "cmd+a",
    scope: "files",
  },
  {
    id: "navigation.clearSelection",
    group: "Navigation",
    title: "Clear Selection",
    defaultKey: "escape",
    scope: "files",
  },
  {
    id: "navigation.toggleHidden",
    group: "Navigation",
    title: "Show/Hide Hidden Files",
    defaultKey: "cmd+shift+.",
    scope: "files",
  },
  {
    id: "files.rename",
    group: "Files",
    title: "Rename",
    defaultKey: "enter",
    scope: "files",
  },
  {
    id: "files.newFolder",
    group: "Files",
    title: "New Folder",
    defaultKey: "cmd+shift+n",
    scope: "files",
  },
  {
    id: "files.trash",
    group: "Files",
    title: "Move to Trash / Delete",
    defaultKey: "cmd+backspace",
    scope: "files",
  },
  {
    id: "files.undo",
    group: "Files",
    title: "Undo Rename or Move",
    defaultKey: "cmd+z",
    scope: "files",
  },
  {
    id: "transfers.copyToOther",
    group: "Transfers",
    title: "Copy to Other Pane",
    defaultKey: "f5",
    scope: "files",
  },
  {
    id: "transfers.moveToOther",
    group: "Transfers",
    title: "Move to Other Pane",
    defaultKey: "f6",
    scope: "files",
  },
  {
    id: "transfers.copy",
    group: "Transfers",
    title: "Copy",
    defaultKey: "cmd+c",
    scope: "files",
  },
  {
    id: "transfers.paste",
    group: "Transfers",
    title: "Paste",
    defaultKey: "cmd+v",
    scope: "files",
  },
  {
    id: "panels.toggleInspector",
    group: "Panels",
    title: "Toggle Inspector",
    defaultKey: "cmd+i",
    scope: "files",
  },
  {
    id: "panels.connect",
    group: "Panels",
    title: "Connect to Server",
    defaultKey: "cmd+k",
    scope: "files",
  },
  {
    id: "panels.toggleTerminal",
    group: "Panels",
    title: "Toggle Terminal",
    defaultKey: "ctrl+`",
    scope: "menu",
  },
  {
    id: "panels.closeRemotePane",
    group: "Panels",
    title: "Close Remote Pane",
    defaultKey: "cmd+w",
    scope: "menu",
  },
  {
    id: "panels.settings",
    group: "Panels",
    title: "Settings",
    defaultKey: "cmd+,",
    scope: "menu",
  },
];

export const KEYBINDING_GROUPS: readonly CommandGroup[] = ["Navigation", "Files", "Transfers", "Panels"];

/** Listed beside the registry but fixed in place: selection movement. */
export const LOCKED_KEYBINDINGS: readonly LockedKeybinding[] = [
  { group: "Navigation", title: "Move Selection Up", key: "up" },
  { group: "Navigation", title: "Move Selection Down", key: "down" },
  { group: "Navigation", title: "Extend Selection Up", key: "shift+up" },
  { group: "Navigation", title: "Extend Selection Down", key: "shift+down" },
];

export const COMMAND_BY_ID = new Map(KEYBINDING_COMMANDS.map((command) => [command.id, command]));

export const COMMAND_TITLES = new Map(KEYBINDING_COMMANDS.map((command) => [command.id, command.title]));

export function defaultBindings(): CommandBindings {
  return Object.fromEntries(KEYBINDING_COMMANDS.map((command) => [command.id, command.defaultKey])) as CommandBindings;
}

/** Keys the grammar can represent, without modifiers. */
export const SUPPORTED_KEYS = new Set([
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(i)),
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  "enter",
  "escape",
  "space",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  ".",
  ",",
  "/",
  ";",
  "'",
  "[",
  "]",
  "\\",
  "-",
  "=",
  "`",
]);

/** Special keys may be bare; every other key needs ⌘, ⌃, or ⌥. */
export const SPECIAL_KEYS = new Set([
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  "enter",
  "escape",
  "space",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
]);

/** Selection movement stays fixed; the UI shows these rows with a lock. */
export const LOCKED_KEYS = new Set(["up", "down", "shift+up", "shift+down"]);

/** Combinations macOS or a retained menu item owns, so Pallet must not bind them. */
export const RESERVED_KEYS = new Set([
  "cmd+q",
  "cmd+h",
  "cmd+alt+h",
  "cmd+m",
  "cmd+tab",
  "cmd+space",
  "cmd+`",
  "cmd+ctrl+q",
  "cmd+shift+3",
  "cmd+shift+4",
  "cmd+shift+5",
  "cmd+x",
  "cmd+shift+z",
  "cmd+ctrl+space",
  "cmd+ctrl+f",
  "cmd+shift+r",
  "cmd+alt+i",
]);

export const MODIFIER_LABELS: Record<string, string> = {
  cmd: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

export const KEY_LABELS: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  space: "Space",
  tab: "⇥",
  backspace: "⌫",
  delete: "⌦",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/** Physical `KeyboardEvent.code` to the canonical key token. */
export const CODE_KEYS: Record<string, string> = {
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [`Key${String.fromCharCode(65 + i)}`, String.fromCharCode(97 + i)]),
  ),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i}`, String(i)])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `f${i + 1}`])),
  Enter: "enter",
  NumpadEnter: "enter",
  Escape: "escape",
  Space: "space",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Period: ".",
  Comma: ",",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** Read aliases normalized away; never written back. */
export const MODIFIER_ALIASES: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

export const KEY_ALIASES: Record<string, string> = {
  return: "enter",
  esc: "escape",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};
