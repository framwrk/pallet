---
name: Pallet
description: A modern macOS glass workbench for dependable SFTP file operations.
colors:
  accent-dark: "#0A84FF"
  accent-light: "#007AFF"
  window-dark: "#101116"
  surface-dark: "#17181E"
  glass-dark: "rgba(37, 38, 47, 0.72)"
  text-dark: "#F5F5F7"
  secondary-text-dark: "#A9AAB2"
  border-dark: "rgba(255, 255, 255, 0.10)"
  window-light: "#F1F2F6"
  surface-light: "#FFFFFF"
  glass-light: "rgba(247, 248, 251, 0.72)"
  text-light: "#1D1D1F"
  secondary-text-light: "#6E6E73"
  border-light: "rgba(29, 29, 31, 0.12)"
  destructive: "#FF453A"
  success: "#30D158"
  caution: "#FFD60A"
typography:
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter Variable', sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter Variable', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter Variable', sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.01em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
rounded:
  xs: "5px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  xl: "18px"
  capsule: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  button-primary-dark:
    backgroundColor: "{colors.accent-dark}"
    textColor: "{colors.text-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "28px"
  button-primary-light:
    backgroundColor: "{colors.accent-light}"
    textColor: "{colors.surface-light}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    height: "28px"
  field-dark:
    backgroundColor: "{colors.glass-dark}"
    textColor: "{colors.text-dark}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
    height: "28px"
  field-light:
    backgroundColor: "{colors.glass-light}"
    textColor: "{colors.text-light}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
    height: "28px"
  glass-panel-dark:
    backgroundColor: "{colors.glass-dark}"
    textColor: "{colors.text-dark}"
    rounded: "{rounded.lg}"
    padding: "12px"
  glass-panel-light:
    backgroundColor: "{colors.glass-light}"
    textColor: "{colors.text-light}"
    rounded: "{rounded.lg}"
    padding: "12px"
---

# Design System: Pallet

## Overview

**Creative North Star: "The Glass Workbench"**

Pallet should feel like a first-class modern macOS utility: the spatial confidence of a professional workbench, the material refinement of Apple liquid glass, the calm finish of Raycast, and the disciplined panel logic of VS Code. The system is native-feeling rather than decorative. It uses translucent material to clarify the window's layers, not to make every object look frosted.

This is the target specification for the app-wide redesign. Existing code does not yet define the authority for the future visual world. Preserve Pallet's dual-pane model, compact information density, workflows, keyboard behavior, terminology, and safety cues while replacing the current visual shell. Settings may move its existing categories into a Raycast-like sidebar, but its settings, behavior, and hierarchy remain intact.

Apple, Raycast, and VS Code are craft references, not templates. Pallet must remain recognizable through its symmetric local/remote workspace, connection identity, transfer-state language, and blue focus signal. Text or product features shown inside reference screenshots are never part of this specification.

**Key Characteristics:**

- Restrained neutral palette with one system-blue interaction accent.
- Liquid glass on structural chrome; optically stable surfaces behind operational data.
- Dense, aligned, resizable workspace regions with hairline separation.
- Native macOS control proportions, typography, focus, and motion.
- Clear pane identity and transfer state without ornamental dashboard chrome.

## Colors

The palette follows the user's macOS appearance. Dark and light are equally authored; neither is a tinted inversion of the other.

### Primary

- **Focus Blue Dark** (`#0A84FF`): active pane, primary action, focused control, live transfer, and selected navigation state in dark appearance.
- **Focus Blue Light** (`#007AFF`): the corresponding interaction signal in light appearance.

### Neutral

- **Night Window** (`#101116`): dark window backdrop visible behind glass chrome.
- **Night Workspace** (`#17181E`): stable dark file panes and data surfaces.
- **Night Glass** (`rgba(37, 38, 47, 0.72)`): dark sidebar, inspector, titlebar groups, popovers, and dialogs, always paired with blur and a hairline.
- **Dark Primary Text** (`#F5F5F7`) and **Dark Secondary Text** (`#A9AAB2`): high-confidence text and quieter metadata.
- **Morning Window** (`#F1F2F6`): light window backdrop visible behind glass chrome.
- **Morning Workspace** (`#FFFFFF`): stable light file panes and data surfaces.
- **Morning Glass** (`rgba(247, 248, 251, 0.72)`): light structural material.
- **Light Primary Text** (`#1D1D1F`) and **Light Secondary Text** (`#6E6E73`): Apple's familiar neutral contrast range.
- **Dark Hairline** (`rgba(255, 255, 255, 0.10)`) and **Light Hairline** (`rgba(29, 29, 31, 0.12)`): panel edges, table dividers, and material boundaries.

### Semantic

- **Destructive Coral** (`#FF453A`): destructive actions and failures only.
- **Verified Green** (`#30D158`): completed transfers, verified results, and healthy connection status.
- **Caution Yellow** (`#FFD60A`): trust decisions, host-key changes, and consequential warnings.

### Named Rules

**The Glass Has a Job Rule.** Use translucency for structural chrome—sidebar, titlebar, inspector, drawer chrome, popovers, and dialogs. File rows, long-form text, forms, and dense tables sit on stable surfaces. Glass never lowers text contrast or makes one pane's content bleed into another.

**The One Blue Signal Rule.** Blue means current focus, selection, navigation, or progress. It is not ambient decoration. On a typical working screen, blue should occupy less than ten percent of the area.

**The Semantic Color Rule.** Red, green, and yellow describe consequential states. Favorite labels may retain their user-selected colors, but no other component borrows those hues decoratively.

## Typography

**Display Font:** None. Pallet is an operating surface, not a marketing page.

**Body Font:** macOS system UI stack (`-apple-system`, `BlinkMacSystemFont`, `SF Pro Text`, with Inter as the packaged fallback).

**Label/Mono Font:** `SF Mono`, Menlo, or `ui-monospace` for paths, permissions, fingerprints, sizes where alignment matters, and machine-oriented values.

**Character:** Native, compact, and quiet. Hierarchy comes from weight, contrast, and placement rather than oversized headings or aggressive tracking.

### Hierarchy

- **Window or panel title** (600, `13px`, `1.25`): current location, inspector title, dialog title, and Settings category.
- **Body / file row** (400, `13px`, `1.35`): names, form values, and primary operational copy.
- **Emphasized body** (500–600, `13px`): selected navigation labels, primary row labels, and status summaries.
- **Label / metadata** (500, `11px`, `1.2`): column headers, section labels, supporting values, and compact status lines. Use title case or sentence case; avoid all caps except established technical abbreviations.
- **Machine value** (400, `12px`, `1.35`, tabular numerals where applicable): paths, fingerprints, permissions, byte counts, rates, ports, and timestamps.

### Named Rules

**The Native Scale Rule.** The working interface stays between `11px` and `14px`. Larger text is reserved for empty states and first-run connection moments, never routine chrome.

## Layout

Pallet keeps its left-local/right-remote dual-pane workspace. The outer frame is edge-to-edge and window-native, inspired by VS Code's disciplined tool geometry rather than card-based web dashboards. Regions join through hairlines and material changes; they do not float as unrelated rounded cards.

- **Unified titlebar/toolbar:** `46–52px` high, draggable where empty, with traffic-light clearance, history controls leading, active-location title centered or optically centered, and task controls trailing.
- **Primary sidebar:** `232–264px` wide, full height beneath the titlebar material, translucent, optionally resizable, and never narrower than an icon plus a readable favorite name. Devices, Folders, and Favorites preserve their order.
- **Workspace:** two equal panes by default with a draggable divider. Each pane keeps breadcrumb, column header, virtualized list, and status line. The active pane is identified by a restrained blue focus treatment on its breadcrumb/header region and divider edge—not a thick decorative stripe.
- **Inspector:** `272–320px` wide, right-docked, translucent at its outer shell, with stable inset surfaces for previews and editable permission controls.
- **Transfer drawer:** full-width beneath the workspace, `32–38px` collapsed and up to `240px` open. Its shell may use glass; progress rows use stable surfaces.
- **Dialogs and connection forms:** compact and centered, with label/control alignment maintained. Destructive decisions keep the action nearest the consequence and visually separate Cancel.
- **Settings:** a compact glass sidebar holds the existing General, Appearance, Transfers, and Advanced categories; the right side uses grouped settings surfaces. Do not add search until the number of settings makes retrieval meaningfully difficult.

Use a `4px` base spacing unit. Routine gaps are `8px` and `12px`; region padding is `12–16px`; major panel transitions use `20–24px`. Dense file rows target `26–28px`. Controls target `28px`, growing to `32px` only when the interaction benefits from a larger hit area. Minimum pointer targets remain `28px`; keyboard access is mandatory for all compact controls.

At narrower window widths, preserve the two-pane task until each pane would become unusable. Then allow the sidebar and inspector to collapse before altering the dual-pane workspace. Do not convert the desktop app into a stacked mobile layout.

## Elevation & Depth

Depth is a hybrid of macOS material, tonal layering, and restrained ambient shadows. Large workspace regions are flat and joined. Floating depth is reserved for content that temporarily sits above the workspace.

### Shadow Vocabulary

- **Glass edge** (`inset 0 1px 0 rgba(255,255,255,0.08)` dark; `inset 0 1px 0 rgba(255,255,255,0.72)` light): catches the top edge of translucent chrome.
- **Popover lift** (`0 12px 36px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.16)`): menus, tooltips, popovers, and transient pickers.
- **Dialog lift** (`0 24px 64px rgba(0,0,0,0.32), 0 4px 16px rgba(0,0,0,0.18)`): modal decisions only.

Glass uses `backdrop-filter: blur(24px) saturate(160%)` as the CSS fallback. On supported macOS Electron windows, prefer native vibrancy or under-window material for structural regions. When Reduce Transparency is enabled or backdrop filtering is unavailable, replace glass with an opaque neutral surface and retain the same borders and hierarchy.

**The Flat Work Rule.** Operational content stays flat at rest. Hover and selection change tone; they do not lift file rows or transform them into cards.

## Shapes

The form language is softly machined: continuous macOS curves where available, modest radii at work density, and capsules only for genuinely capsule-shaped controls.

- `5px`: tiny icon wells, inline rename fields, keycaps, and compact status affordances.
- `8px`: buttons, inputs, sidebar selection, rows with a bounded background, and tool groups.
- `10px`: grouped setting rows and larger controls.
- `14px`: popovers and compact panels.
- `18px`: dialogs and prominent glass containers.
- Full capsule: segmented controls, connection chips, and compact status pills only.

One-pixel hairlines define joined regions. Avoid double borders where two panels meet. Never round the inner edges of panes that share a divider.

## Components

### Buttons

- **Shape:** `8px` radius, `28px` standard height, `32px` when a larger pointer target is justified.
- **Primary:** system blue fill, white text, medium weight, no gradient, and only one primary action per decision region.
- **Secondary:** glass or neutral fill with a hairline; it must remain visible on both the window backdrop and stable content surfaces.
- **Ghost / toolbar:** transparent at rest; a compact rounded hover well appears on hover or keyboard focus.
- **Hover / Focus:** modest tonal change. Keyboard focus uses a crisp two-layer blue ring and never relies on color alone.
- **Active:** `translateY(1px)` or a slight darkening, not elastic scaling.

### Navigation

- The main sidebar uses `28–30px` rows, `8px` radius, `16px` icons, and a low-contrast selected fill plus blue icon/focus cue.
- Section labels are quiet `11px` labels with normal capitalization. Keep their spacing more prominent than their letter spacing.
- Favorites preserve user color dots; connection health is a separate semantic indicator.
- The VS Code reference informs panel discipline and resizability. Do not add an activity rail, editor tabs, or unrelated IDE chrome unless a future feature requires that information architecture.

### File Rows and Pane Chrome

- File rows remain flat, compact, and virtualized. Folder/file icons are `16px`; names truncate; metadata uses tabular numerals.
- Active selection uses blue with high-contrast text. Inactive selection uses a neutral fill so pane focus is unmistakable.
- Column headers use stable surfaces, hairline separation, and visible sort direction.
- Breadcrumbs are text-first. Each segment gets a subtle hover well; path editing becomes a native compact field in place.
- The active pane treatment belongs to its header/border system, not a floating card outline.

### Cards / Containers

- Cards are not the default layout primitive. Use grouped containers only for Settings groups, empty-state actions, previews, and logically bounded inspector regions.
- **Corner Style:** `10–14px` depending on scale.
- **Background:** stable neutral for operational data; glass only for structural shell regions.
- **Border:** one hairline with optional inner glass edge.
- **Internal Padding:** `12–16px`.

### Inputs / Fields

- **Style:** `28px` high, `8px` radius, neutral or lightly translucent fill, one hairline, and `9px` horizontal padding.
- **Focus:** blue border plus a low-opacity outer ring. Never add a large glow.
- **Error:** destructive border and concise inline message; preserve typed values.
- **Disabled:** lower contrast but still legible; do not use blur.
- Search-style fields may be capsule-like only when the role is global filtering, not ordinary data entry.

### Switches, Segmented Controls, and Chips

- Use macOS proportions and state logic. Switches communicate binary settings; segmented controls switch among peer modes; neither substitutes for an action button.
- Connection chips are compact capsules containing server identity and status. Disconnect remains a distinct, clearly labeled control.
- Keycaps use the mono stack, a subtle recessed fill, `5px` radius, and tabular alignment.

### Dialogs, Popovers, and Menus

- Dialogs use an `18px` continuous corner, glass or vibrancy shell, strong text contrast, and restrained dialog lift.
- Popovers and menus use `14px` corners, glass material, `6–8px` internal padding, and native-feeling row density.
- Host-key changes, deletes, overwrite conflicts, and other consequential choices must preserve Pallet's explicit safety copy and semantic colors.
- Backdrops dim and gently desaturate the workspace; they do not blur it beyond recognition.

### Inspector and Transfer Queue

- The inspector reads as a docked utility region. Preview content sits on a stable inset surface; paths and permissions use mono typography where useful.
- The transfer queue favors scanability: label, state, rate, byte progress, file count, and actions align consistently across jobs.
- Progress bars are thin and quiet at rest. Blue is active, green is verified complete, red is failed, and paused states become neutral rather than yellow unless attention is required.

### Motion

- Use `140ms` for hover/focus color changes, `180ms` for controls and popovers, and `240ms` for sidebar, inspector, and drawer transitions.
- Standard easing is `cubic-bezier(0.2, 0.8, 0.2, 1)`; panels may use `cubic-bezier(0.16, 1, 0.3, 1)`.
- Motion explains state or spatial continuity: panel reveal, selection movement, transfer progress, connection status, and mode change. Never animate routine file-row entry.
- Respect Reduce Motion by removing transforms and using immediate or short opacity/state changes.

## Do's and Don'ts

### Do:

- **Do** preserve the dual-pane task model, dense file rows, keyboard conventions, and explicit safety states.
- **Do** use liquid glass to distinguish chrome from work, with opaque fallbacks for Reduce Transparency.
- **Do** make dark and light appearances equally intentional and follow the system by default.
- **Do** borrow Raycast's polish, Apple's material logic, and VS Code's workspace discipline while keeping Pallet's own structure and terminology.
- **Do** test text, icons, focus rings, and semantic states over every material they can actually appear on.
- **Do** keep resize behavior, minimum region widths, truncation, long paths, large file counts, disconnected states, and transfer failures in the design contract.

### Don't:

- **Don't** put glass behind dense file data, long text, or editable forms when it harms legibility.
- **Don't** turn panes, rows, or settings into a field of disconnected floating cards.
- **Don't** add an activity rail, tabs, search, AI features, account features, or other content merely because a reference product contains them.
- **Don't** imitate Raycast's exact navigation, icons, spacing, or copy; the references set craft and material standards, not product structure.
- **Don't** use oversized controls, wide marketing whitespace, glowing neon edges, or decorative gradients.
- **Don't** communicate active pane, selection, warning, or transfer state through color alone.
