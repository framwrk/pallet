# Keybindings

Pallet's shortcuts are data, not hard-coded key checks. The same registry drives the Settings →
Keybindings tab, the renderer dispatcher, and the menu accelerators, so a rebound key behaves the
same everywhere.

## Where things live

| Piece | File |
| --- | --- |
| Pure registry, reserved keys, key labels, parse/validate/resolve | `src/shared/keybindings/` |
| Main-owned file, validation, writes, watcher, menu suspension flag | `src/main/services/keybindings-store.ts` |
| IPC handlers | `src/main/ipc/keybindings.ts` |
| Renderer state and key → command lookup | `src/renderer/src/store/keybinding.store.ts` |
| Dispatcher | `handleKeyDown` in `src/renderer/src/windows/App.tsx` |
| Settings tab | `KeybindingsPanel` in `src/renderer/src/components/settings/SettingsDialog.tsx` |

`src/shared/keybindings/keybinding.constants.ts` is the source of truth. `KEYBINDING_COMMANDS`
holds each command's id, group, title, single default key, and runtime scope in registry order.
`LOCKED_KEYBINDINGS` lists the four fixed selection directions for display only.

Canonical keys are lowercase, `+`-joined, with modifiers in the fixed order `cmd`, `ctrl`, `alt`,
`shift`, then one key. Read aliases (`command`, `meta`, `control`, `option`, `return`, `esc`,
`arrowup`, …) are normalized and never written. Matching uses `KeyboardEvent.code`, so a binding
follows the physical key position rather than the character produced by the layout.

## Resolution

`resolveBindings` turns the JSON overrides into effective bindings:

1. Values must be a key string or `null`; bad shapes are reported and the command keeps its default.
2. The key is parsed and validated. Invalid keys are reported and the default stays in effect.
3. A present string replaces the command's default; `null` means unbound.
4. Commands are walked in registry order. The first command to claim a canonical key keeps it; a
   later command becomes unbound and is reported. Because both overrides exist before claims are
   checked, swapping two keys in the JSON works.

`findConflict` answers the recorder's question against the current effective map.

## Runtime scopes

- **files** — skipped while a modal is open, an editable target has focus, or the event was already
  handled. A binding with ⌘, ⌃, or ⌥ fires even when a button, link, menu, or checkbox has focus;
  a bare or ⇧-only binding yields to that widget. A terminal-view pane never receives file commands.
  Command-specific conditions stay: Rename needs exactly one selection and no ⌘.
- **pane-switch** — Switch Active Pane fires anywhere outside dialogs and text fields while a right
  pane exists and is not connecting; otherwise Tab falls through to native focus traversal.
- **menu** — The command's single binding is the Electron menu accelerator, which fires from any
  focus.
- **fixed** — ↑/↓ and ⇧↑/⇧↓ keep their original selection-movement code path.

Modifier-only events and unsupported codes never match. Lookup is an exact `Map<string, CommandId>`.

## The file and the watcher

`keybindings.json` lives in `app.getPath("userData")`, next to `pallet.db`, and stores overrides
only. Main reads it on startup, creates it on demand for **Open keybindings.json**, and rewrites it
atomically (temporary file plus rename) from the UI. Writes use registry order, 2-space JSON, and a
trailing newline; an entry equal to its default is omitted, and **Reset All to Defaults…** writes `{}`.

A directory watcher (not a file watcher, which an atomic rename would break) filters for
`keybindings.json` and debounces 100 ms. It skips content equal to main's own last write. On a JSON
syntax error or a non-object top level it keeps the last good effective bindings and stores the
error in `syntaxError`; the renderer shows a toast and the tab shows a banner. Deleting the file
falls back to all defaults. Every state change broadcasts one `KeybindingsState` to every window and
rebuilds the menu.

## Menu accelerators and recording

The Settings, Close Remote Pane, and Toggle Terminal menu items read their effective shortcut
through `toAccelerator`. An unbound command has no accelerator. While the Settings recorder is open,
main rebuilds the menu without those three accelerators so recording ⌘W, ⌘, or ⌃` cannot disconnect,
reopen Settings, or toggle a pane. Losing window focus or reloading clears the flag, and the
renderer clears it on recorder exit or unmount.


## Why there is no `watchWindowShortcuts` or stock View menu

`optimizer.watchWindowShortcuts` from `@electron-toolkit/utils` cancels ⌘R/⌃R, ⇧⌘R, ⌥⌘R, F12, ⌥⌘I,
⌃⇧I, ⌘-, and ⇧⌘= in `before-input-event`. The stock `viewMenu` role also owns Reload and the zoom
shortcuts. Together they meant the page never saw ⌘R, so Refresh was dead in packaged builds and
belonged to the View menu in development.

Pallet now installs a small dev-only filter (`src/main/services/dev-shortcuts.ts`) that keeps F12
for undocked DevTools and blocks nothing in production, and a custom View menu. Production contains
only Toggle Full Screen (⌃⌘F). Development adds Force Reload (⇧⌘R) and Toggle Developer Tools
(⌥⌘I) above it. There is no Reload or zoom item in either build. The reserved-key list still keeps
⇧⌘R and ⌥⌘I unbound in every build, so a binding cannot behave differently in development and a
packaged app.

## Adding a command

1. Add an entry to `KEYBINDING_COMMANDS` with a unique id, group, title, one canonical default key,
   and scope. Keep registry order meaningful: it is the claim order and the file order.
2. Implement the action in the renderer dispatcher's files switch, or give it a menu item and add
   it to the menu's accelerator lookup.
3. If it is a menu-accelerator command, include it in the menu accelerator suspension set.
4. Add the command to the keyboard reference in `FEATURES.md`; the Settings tab picks it up
   automatically.
5. Extend `test-server/keybindings.test.ts` when the change affects parsing, validation, or
   resolution. The keybindings UI is covered by the native Settings scenario in
   `docs/ui-regression.md`.
