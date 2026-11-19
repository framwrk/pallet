/**
 * Pure keybinding types. No Electron or DOM imports, so the main process, the
 * renderer, and the offline tests can share one registry.
 */

export type CommandGroup = "Navigation" | "Files" | "Transfers" | "Panels";

export type CommandId =
  | "navigation.open"
  | "navigation.goUp"
  | "navigation.switchPane"
  | "navigation.goToFolder"
  | "navigation.refresh"
  | "navigation.selectAll"
  | "navigation.clearSelection"
  | "navigation.toggleHidden"
  | "files.rename"
  | "files.newFolder"
  | "files.trash"
  | "files.undo"
  | "transfers.copyToOther"
  | "transfers.moveToOther"
  | "transfers.copy"
  | "transfers.paste"
  | "panels.toggleInspector"
  | "panels.connect"
  | "panels.toggleTerminal"
  | "panels.closeRemotePane"
  | "panels.settings";

export type CommandScope = "files" | "pane-switch" | "menu" | "fixed";

export interface KeybindingCommand {
  id: CommandId;
  group: CommandGroup;
  title: string;
  defaults: string[];
  scope: Exclude<CommandScope, "fixed">;
}

/** A listed but non-rebindable command (Selection movement). */
export interface LockedKeybinding {
  group: CommandGroup;
  title: string;
  keys: string[];
}

export type KeyIssueCode = "unsupported" | "needsModifier" | "reserved" | "locked" | "escapeReserved";

/** Why one canonical key cannot be bound. */
export interface KeyIssue {
  code: KeyIssueCode;
  message: string;
}

export type KeybindingIssueCode = "shape" | "unknownCommand" | "notArray" | "invalidKey" | "duplicate" | "conflict";

/** One skipped entry in keybindings.json, shown in the Settings banner. */
export interface KeybindingIssue {
  code: KeybindingIssueCode;
  /** Registry id when the issue belongs to one command. */
  command?: string;
  /** Canonical key when the issue belongs to one shortcut. */
  key?: string;
  message: string;
}

export type CommandBindings = Record<CommandId, string[]>;

export interface KeybindingsState {
  effective: CommandBindings;
  overrides: Partial<CommandBindings>;
  issues: KeybindingIssue[];
  syntaxError: string | null;
  path: string;
}
