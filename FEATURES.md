# Pallet — Features

Everything Pallet v0.1.0 can do, and how to do it.

If you just want to get moving: launch the app, press **⌘K** to connect to a server, click a file,
press **F5** to send it to the other pane. The rest of this document is detail.

- [The window](#the-window)
- [Browsing](#browsing)
- [Selecting files](#selecting-files)
- [Local file management](#local-file-management)
- [Connecting to a server](#connecting-to-a-server)
- [Host key verification](#host-key-verification)
- [Favorites](#favorites)
- [Remote file management](#remote-file-management)
- [Transferring files](#transferring-files)
- [Conflicts](#conflicts)
- [The inspector](#the-inspector)
- [Editing remote files](#editing-remote-files)
- [Updates](#updates)
- [Logs and privacy](#logs-and-privacy)
- [Keyboard reference](#keyboard-reference)
- [What Pallet does not do yet](#what-pallet-does-not-do-yet)

---

## The window

Pallet is a dual-pane file manager. Both panes start as local file browsers, and either one can be
pointed at a remote server independently — so you can go local↔remote, local↔local, or
remote↔remote.

| Region           | What it is                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Toolbar**      | Back, Forward, Refresh, New Folder, Move to Trash, Get Info. Acts on the **active pane**.                          |
| **Sidebar**      | `Connect to Server…`, then DEVICES (mounted volumes), PLACES (Home, Desktop, Documents, Downloads), and FAVORITES. |
| **Panes**        | Two side-by-side file lists, each with its own breadcrumb bar and status line.                                     |
| **Queue drawer** | Collapsible transfer queue along the bottom. Appears when you start a transfer.                                    |
| **Inspector**    | Right-hand info panel. Toggle with **⌘I** or **Space**.                                                            |

**The active pane** is the one with the accent-colored top border. Every toolbar button and keyboard
shortcut applies to it. Click a pane or press **⇥** to switch. Keyboard focus and the active pane are
always the same thing — they never drift apart.

The window follows your system light/dark appearance automatically.

---

## Browsing

**Navigate into a folder:** double-click it, or select it and press **⌘↓** or **⌘O**.
**Go to the parent folder:** **⌘↑**. You land with the folder you just left selected, Finder-style.
**Back / Forward:** the toolbar arrows. Each pane keeps its own independent history.

**Breadcrumbs.** The bar above each list shows your path. Click any segment to jump there.
**Double-click the breadcrumb bar** to turn it into an editable text field — type a path and press
Return. Escape cancels.

**Go to Folder (⌘⇧G).** Opens a dialog for typing a path directly. Works on both local and remote
panes.

**Sorting.** Click the **Name**, **Size**, or **Date Modified** column header. Click again to
reverse. Folders always sort first regardless of the column, and names sort naturally — `file2`
comes before `file10`. Each pane sorts independently.

**Hidden files** are off by default. Toggle with **⌘⇧.** (Command-Shift-period).

**Status line.** Each pane's footer shows item count and free space (`19 items, 42.39 GB
available`). With a selection, it switches to `3 of 19 selected`.

**Large directories** are virtualized — only the visible rows are rendered. A 10,000-file directory
opens and scrolls without stalling.

**Symlinks** are shown with an arrow badge and are labeled with what they point at, so you know
whether descending will work. Pallet never follows them during a recursive copy or delete.

---

## Selecting files

| Action          | How                              |
| --------------- | -------------------------------- |
| Select one      | Click, or **↑** / **↓**          |
| Extend a range  | **⇧**-click, or **⇧↑** / **⇧↓**  |
| Add/remove one  | **⌘**-click                      |
| Select all      | **⌘A**                           |
| Clear selection | **Escape**, or click empty space |

Selection survives a refresh of the same directory — if you re-list a folder, whatever still exists
stays selected.

---

## Local file management

**New folder — ⌘⇧N.** Creates `untitled folder` (then `untitled folder 2`, and so on) and drops
straight into inline rename so you can type the real name.

**Rename — ↵ (Return).** Select exactly one item and press Return. This is the Finder convention,
chosen deliberately over ForkLift's "Return opens." Use **⌘↓** to open instead. Return commits,
Escape cancels.

**Move to Trash — ⌘⌫.** Goes to the macOS Trash, so it's recoverable in Finder. Remote deletes are
permanent and ask for confirmation first.

**Copy and paste — ⌘C / ⌘V.** Copy in one pane, paste in the other. Works in every direction,
including local→remote and remote→local: paste always routes through the transfer queue.

**Copy to the other pane — F5 or ⌘D.** **Move to the other pane — F6.**

**Undo — ⌘Z.** Undoes local renames and moves, up to 20 deep. Transfers and deletes are _not_
undoable; Trash is recoverable through Finder instead.

**Reveal in Finder** and **Open** are on the right-click menu. Open uses the file's default app.

**Right-click a file** (local): Open · Reveal in Finder · Rename · Copy · Move to Trash.
**Right-click empty space**: New Folder · Paste · Refresh.

---

## Connecting to a server

Press **⌘K**, or click **Connect to Server…** at the top of the sidebar.

| Field                               | Notes                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Protocol**                        | SFTP. It's the only one in this release.                                                                                          |
| **Server**                          | Hostname or IP.                                                                                                                   |
| **Port**                            | Defaults to 22.                                                                                                                   |
| **Username**                        |                                                                                                                                   |
| **Authenticate**                    | Toggle between **Password** and **Private Key**.                                                                                  |
| **Password** / **Key + Passphrase** | Key auth takes a path to your private key; the passphrase field appears with it.                                                  |
| **Remote Path**                     | Where to start browsing. Blank means your server-side home directory.                                                             |
| **Local Path**                      | Optional. Sets the _other_ pane to this folder when you connect, so a favorite can restore both sides of a working setup at once. |
| **Note**                            | Free text, shown when editing the favorite.                                                                                       |
| **Color Label**                     | A dot for spotting the connection in a long favorites list.                                                                       |

**Show Advanced** reveals three more:

- **Keepalive (s)** — how often to ping an idle connection. Default 15.
- **Concurrency** — parallel transfer channels, 1–7. Default 4. Raise it for many small files; lower
  it if your server limits sessions. (Values outside the range are clamped rather than rejected.)
- **Compression** — negotiates zlib. Worth turning on over a slow link, a waste of CPU on a fast one.

Click **Connect** to connect once, or **Add to Favorites** to save the settings for next time.

**If the connection drops** — Wi-Fi dies, the laptop sleeps, the server restarts — Pallet greys out
the pane, marks the session _reconnecting_, and retries with backoff (1, 2, 4, 8, 15 seconds). Any
running transfer auto-pauses and resumes on its own once the connection is back. You don't have to
do anything.

**Disconnect** by navigating the pane back to a local location, or closing the app.

---

## Host key verification

Pallet uses **trust-on-first-use**, the same model as ForkLift and Transmit.

**First time you connect to a host,** you get a dialog showing its key type and SHA-256 fingerprint.
Compare it against what your server actually has (`ssh-keyscan your-host` or your provider's console)
and click **Trust**. Pallet remembers it; you won't be asked again.

**If a host's fingerprint ever changes,** you get a much louder warning showing both the old and new
fingerprints. This means either the server was legitimately rebuilt, or someone is intercepting your
connection — and the fingerprint alone can't tell you which. The warning is overridable, but don't
override it unless you know why the key changed.

---

## Favorites

Saved connections live in the FAVORITES section of the sidebar, each with its color dot.

| Action   | How                                        |
| -------- | ------------------------------------------ |
| Save one | **Add to Favorites** in the connect dialog |
| Connect  | Click it in the sidebar                    |
| Edit     | Right-click → **Edit…**                    |
| Delete   | Right-click → **Delete**                   |
| Reorder  | Drag it up or down the list                |

Favorites are stored in SQLite on your machine. **Passwords and key passphrases never go in the
database** — they're encrypted through macOS Keychain via Electron's `safeStorage`, and the database
holds only which auth method you chose and whether a secret exists.

Favorites also track when you last used them.

---

## Remote file management

Once a pane is connected, most local operations work identically:

- **New folder** — ⌘⇧N
- **Rename** — ↵
- **Delete** — ⌘⌫ (permanent, with a confirmation dialog — there's no server-side Trash)
- **Change permissions** — via the inspector, see below

**Right-click a remote file**: Open · Edit in External Editor · Copy · Rename · Delete… · Refresh.

**One limitation:** remote→remote _move_ isn't supported. Copy the files, then delete the originals.
Pallet refuses the move with an explanation rather than silently doing copy-then-delete, because a
failure halfway through that sequence loses data.

---

## Transferring files

**Drag and drop** files from one pane to the other. Drop onto a folder to go inside it, or anywhere
else in the pane to drop at the current directory. The drop target highlights.

**Or use the keyboard:** **F5** / **⌘D** to copy to the other pane, **F6** to move (local only), or
**⌘C** / **⌘V**.

Everything goes through the **transfer queue** in the drawer at the bottom — even a 4 KB local copy —
so progress, conflicts, and error handling behave identically no matter what you're moving.

### How a transfer actually runs

1. **Enumerated first.** Pallet walks the entire source tree _before moving a single byte_, so the
   file count and total size are known up front. The progress bar isn't a guess.
2. **Staged, never in place.** Each file is written to `<name>.pallet-part`, has its modification
   time and permissions stamped, and is then **atomically renamed** into its real name. If anything
   goes wrong — crash, dropped Wi-Fi, closed lid — you're left with an obvious `.pallet-part` file,
   **never a truncated file wearing the real name.**
3. **Verified.** Size and modification time are checked after the rename.

### Queue controls

Each job shows progress, transfer rate, and bytes moved. Per job:

| Button               | What it does                     |
| -------------------- | -------------------------------- |
| **Pause**            | Stops after the current file     |
| **Resume**           | Picks back up                    |
| **Retry**            | Re-runs a failed job             |
| **Cancel**           | Stops and cleans up staged files |
| **Remove from list** | Clears a finished job            |

**Clear** removes all finished jobs at once. The drawer header shows aggregate progress across
everything running.

A job paused by a dropped connection shows **"Paused — connection lost"** and resumes automatically.
You can't manually resume that one; it's waiting on the network, not on you.

**If a transfer is interrupted,** the affected file restarts from the beginning on retry. Files that
already completed in the batch are not re-sent. (Resuming mid-file from a byte offset is post-beta.)

---

## Conflicts

When a destination file already exists, the transfer pauses and asks:

| Choice        | Result                                                  |
| ------------- | ------------------------------------------------------- |
| **Replace**   | Overwrite the destination                               |
| **Skip**      | Leave the destination alone, move on                    |
| **Keep Both** | Write alongside it as `file (2).txt`, `file (3).txt`, … |

Tick **"Apply to all N remaining conflicts"** to answer once for the rest of the batch. Because
conflicts are collected against the plan built during enumeration, a 400-file conflict is one
question, not four hundred.

No overwrite ever happens without you choosing it.

---

## The inspector

Toggle with **⌘I** or **Space**. Shows details for a single selected item:

- Name, kind, size, date modified, full path, extension
- **Permissions matrix** — a grid of R/W/X checkboxes across Owner / Group / Others, plus the octal
  value (`0644`) and the symbolic string (`-rw-r--r--`)
- **Inline preview** for images and text files under 1 MB

**On a remote file the permissions are editable.** Tick boxes or type an octal value; changes apply
to the server. Local permissions are shown read-only.

---

## Editing remote files

Right-click a remote file → **Edit in External Editor**.

Pallet downloads it to a temp location, opens it in your default app for that file type, and watches
it. **Every time you save, it re-uploads** — through the same `.pallet-part` staging as any other
transfer. A toast confirms each upload.

Keep the file open and keep saving; each save is another upload. Close the editor when you're done.

---

## Updates

Pallet checks GitHub Releases on launch and once a day. If there's a newer version you get a
dismissible toast with a link to the release page. Never a modal, never on the critical path.

Releases that GitHub marks as prereleases are included by default. Version numbers themselves are
always plain `MAJOR.MINOR.PATCH` — Pallet never ships a version like `0.1.0-beta.1`.

Updates are **not** installed automatically — that requires code signing, which isn't in place yet.
The toast takes you to the download.

---

## Logs and privacy

**Pallet has no telemetry.** No analytics, no crash reporting, no phone-home. The only outbound
request the app ever makes is the GitHub Releases version check. All your data stays on your machine.

Logs go to `~/Library/Logs/Pallet/pallet.log`, rotating at 5 MB. Reach them via **Help → Reveal Log
in Finder**.

Nothing logs credentials deliberately, and every line is additionally scrubbed on the way to disk —
inline URL passwords, `password:` / `token:` assignments, and private-key bodies are replaced with
`***`. It's safe to attach to a bug report, though a quick skim is still wise in case a file path
reveals something you'd rather not share.

---

## Keyboard reference

### Navigation

| Key         | Action                     |
| ----------- | -------------------------- |
| `↑` `↓`     | Move selection             |
| `⇧↑` `⇧↓`   | Extend selection           |
| `⌘↓` / `⌘O` | Open / descend into folder |
| `⌘↑`        | Go to parent folder        |
| `⇥`         | Switch active pane         |
| `⌘⇧G`       | Go to folder               |
| `⌘R`        | Refresh                    |
| `⌘A`        | Select all                 |
| `Escape`    | Clear selection            |
| `⌘⇧.`       | Show/hide hidden files     |

### Files

| Key   | Action                                                  |
| ----- | ------------------------------------------------------- |
| `↵`   | Rename                                                  |
| `⌘⇧N` | New folder                                              |
| `⌘⌫`  | Move to Trash (local) / delete (remote, confirms first) |
| `⌘Z`  | Undo rename or move                                     |

### Transfers

| Key         | Action                          |
| ----------- | ------------------------------- |
| `F5` / `⌘D` | Copy to other pane              |
| `F6`        | Move to other pane (local only) |
| `⌘C` / `⌘V` | Copy / paste across panes       |

### Panels

| Key            | Action            |
| -------------- | ----------------- |
| `⌘I` / `Space` | Toggle inspector  |
| `⌘K`           | Connect to server |

---

## What Pallet does not do yet

Deliberate omissions for the beta, not bugs:

- **SSH agent auth** — password and private key only. Agent support (which brings 1Password's SSH
  agent along for free) is the first thing after beta.
- **Remote→remote move** — copy, then delete.
- **Mid-file resume** — an interrupted file restarts rather than continuing from an offset.
- **Undo for transfers or deletes** — undo covers local rename and move only.
- **Search** — a good remote search needs server-side `find` with cancellation; a bad one is worse
  than none.
- **Directory tree sidebar, grid/column views, tabs, Finder tags**
- **FTP/FTPS, S3, SMB** — the transfer layer is written against two backends already, so a second
  protocol is a known quantity, just not this release.
- **Folder sync / mirror**
- **Archive preview**
- **Custom themes** — light and dark follow the system, and that's it.
- **Automatic updates** — blocked on code signing.
- **Intel Macs** — the beta ships arm64 only.

Each of these was deferred deliberately, to keep the beta focused on the core loop:
browse, select, transfer, verify.
