# Pallet features

What Pallet can do, and how to do it.

To move a file, launch the app, press **⌘K** to connect to a server, click a file, and press **F5**
to send it to the other pane. The rest of this document covers the details.

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
- [Settings](#settings)
- [Updates](#updates)
- [Logs and privacy](#logs-and-privacy)
- [Keyboard reference](#keyboard-reference)
- [Known limitations](#known-limitations)

---

## The window

Pallet is a dual-pane file manager with a fixed layout: the left pane is your Mac, and the right
pane is the server. Until you connect a server, the right pane shows
[Quick Connect](#connecting-to-a-server) instead of a file list.

| Region           | What it is                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Toolbar**      | Back, Forward, Refresh, New Folder, Move to Trash, Get Info. Acts on the **active pane**.                                                   |
| **Sidebar**      | `Connect to Server`, then Devices (mounted volumes), Folders (Home, Desktop, Documents, Downloads, Movies, Music, Pictures), and Favorites. |
| **Panes**        | Local on the left, server on the right, each with its own breadcrumb bar and status line.                                                   |
| **Queue drawer** | Collapsible transfer queue along the bottom. Appears when you start a transfer.                                                             |
| **Inspector**    | Right-hand info panel. Toggle with **⌘I** or **Space**.                                                                                     |

**The active pane** is the pane with the accent-colored top border. Every toolbar button and
keyboard shortcut applies to it. Click a pane or press **⇥** to switch. Keyboard focus and the
active pane are the same thing.

The window follows your system light or dark appearance by default, and you can pin it to light or
dark in [Settings](#settings).

---

## Browsing

**Navigate into a folder:** double-click it, or select it and press **⌘↓** or **⌘O**.
**Go to the parent folder:** **⌘↑**. You land in the parent folder with the folder you left
selected, as in Finder. **Back** and **Forward:** the toolbar arrows. Each pane keeps its own
independent history.

**Breadcrumbs.** The bar above each list shows your path. Click any segment to jump there.
**Double-click the breadcrumb bar** to turn it into an editable text field: type a path and press
Return. Escape cancels.

**Go to Folder (⌘⇧G).** Opens a dialog for typing a path directly, in either pane.

**Sorting.** Click the **Name**, **Size**, or **Date Modified** column header. Click again to
reverse the order. Folders sort before files in every column, and names use natural order, so
`file2` comes before `file10`. Each pane sorts independently. When you sort by Size, folders sort
by name among themselves, even while Pallet calculates folder sizes.

**Hidden files** are off by default. Toggle with **⌘⇧.** (Command-Shift-period). Pallet remembers
the setting across launches, and it is the same setting as the one in [Settings](#settings).

**Status line.** Each pane's footer shows item count and free space (`19 items, 42.39 GB
available`). With a selection, it switches to `3 of 19 selected`.

**Large directories** are virtualized: Pallet renders only the visible rows, so a 10,000-file
directory opens and scrolls without stalling.

**Symlinks** appear with an arrow badge and show their target, so you know whether descending into
them works. Pallet does not follow symlinks during a recursive copy or delete.

### Folder sizes

Folders show `--` in the Size column. Turn on **Calculate folder sizes** in
[Settings](#settings), and Pallet walks each folder and shows the total instead, in both the file
list and the inspector.

The setting is off by default, and off for remote panes even when it is on, because the cost
differs by location:

- **Locally:** Pallet sizes only the rows on screen, and only after scrolling pauses, so scrolling
  through a large directory does not start calculations for rows you scroll past. At most four
  walks run at a time.
- **Remotely:** sizing a tree is the most expensive operation Pallet runs on a server, so it needs
  a second switch: **Include remote folders**. Pallet tries `du -sb` first, which costs a single
  round trip; on a server whose `du` does not support `-b` (macOS, BSD, BusyBox), it falls back for
  the rest of the session to an SFTP walk that costs one round trip per directory. Only one remote
  sizing job runs per server at a time, so sizing does not compete with your transfers.

Totals are _apparent size_ (the sum of the file sizes inside, the same number `du` reports), not
disk usage. Symlinks count at their own size, and Pallet does not follow them, so a link to `/`
cannot turn one folder into a walk of the whole filesystem. Unreadable subfolders contribute
nothing instead of failing the total.

Totals are cached. Press **⌘R** on a directory to drop the cached totals for it and everything
below it: that is the moment you tell Pallet the contents changed. Disconnecting from a server
discards its totals.

---

## Selecting files

| Action          | How                              |
| --------------- | -------------------------------- |
| Select one      | Click, or **↑** / **↓**          |
| Extend a range  | **⇧**-click, or **⇧↑** / **⇧↓**  |
| Add/remove one  | **⌘**-click                      |
| Select all      | **⌘A**                           |
| Clear selection | **Escape**, or click empty space |

Selection survives a refresh of the same directory: if you re-list a folder, whatever still exists
stays selected.

---

## Local file management

**New folder (⌘⇧N).** Creates `untitled folder` and starts inline rename so you can type the real
name. Subsequent folders continue the numbering.

**Rename (Return).** Select exactly one item and press Return. This is the Finder convention;
ForkLift opens with Return instead. Use **⌘↓** to open. Return commits the rename, and Escape
cancels it.

**Move to Trash (⌘⌫).** Moves the item to the macOS Trash, so you can recover it in Finder. Remote
deletes are permanent, and Pallet asks for confirmation first.

**Copy and paste (⌘C, ⌘V).** Copy in one pane and paste in the other. It works in every direction,
including local to remote and remote to local: pasting routes through the transfer queue.

**Copy to the other pane (F5 or ⌘D).** **Move to the other pane (F6).**

**Undo (⌘Z).** Undoes local renames and moves, up to 20 levels deep. Transfers and deletes are not
undoable; recover Trash items through Finder instead.

The right-click menu on a file includes **Open** and **Reveal in Finder**. Open uses the file's
default app.

**Right-click a file** (local): Open · Reveal in Finder · Rename · Copy · Move to Trash.
**Right-click empty space**: New Folder · Paste · Refresh.

---

## Connecting to a server

**Quick Connect** fills the right pane whenever no server is attached to it: at launch, and again
after you disconnect. To open it over a connected pane, press **⌘K** or click **Connect to Server**
at the top of the sidebar. **Cancel** returns you to the file list.

| Field                               | Notes                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Protocol**                        | SFTP, FTP, or explicit FTPS. SFTP is selected by default.                                                                        |
| **Server**                          | Hostname or IP.                                                                                                                  |
| **Port**                            | Defaults to 22 for SFTP and 21 for FTP and FTPS; Pallet preserves custom ports when you switch protocols.                        |
| **Username**                        |                                                                                                                                  |
| **Authenticate**                    | Password for every protocol; **Private Key** is also available for SFTP.                                                         |
| **Password** / **Key + Passphrase** | Key auth takes a path to your private key; the passphrase field appears with it.                                                 |
| **Remote Path**                     | Where to start browsing. Blank means your server-side home directory.                                                            |
| **Local Path**                      | Optional. Sets the _left_ pane to this folder when you connect, so a favorite can restore both sides of a working setup at once. |
| **Note**                            | Free text, shown when editing the favorite.                                                                                      |
| **Color Label**                     | A dot for spotting the connection in a long favorites list.                                                                      |

**Options** reveals connection-specific controls:

- **Keepalive (s)**: SFTP only; how often to ping an idle connection. The default is 15.
- **Concurrency**: parallel transfer channels, 1-7. Seeded from **Default concurrency** in
  [Settings](#settings), which starts at 4. Raise it for many small files; lower it if your server
  limits sessions. Pallet clamps values outside the range rather than rejecting them.
- **Compression**: SFTP only; negotiates zlib. Useful on slow links, at the cost of CPU.
- **Verify TLS certificate**: FTPS only, and enabled by default. Disable it only for a trusted
  private or test server that uses a self-signed certificate.

Click **Connect** to connect once, or **Add to Favorites** to save the settings for next time.

**If the connection drops** (Wi-Fi dies, the laptop sleeps, the server restarts), Pallet grays out
the pane, marks the session _reconnecting_, and retries with backoff (1, 2, 4, 8, 15 seconds). Any
running transfer pauses and resumes automatically once the connection returns.

Disconnect with the **×** on the server chip in the right pane's breadcrumb bar. The pane shows
Quick Connect again.

---

## Host key verification

Pallet uses _trust-on-first-use_, the same model as ForkLift and Transmit.

**The first time you connect to a host,** Pallet shows a dialog with its key type and SHA-256
fingerprint. Compare the fingerprint against the one your server reports (`ssh-keyscan your-host`
or your provider's console), then click **Trust**. Pallet stores the key, and you won't see the
dialog again.

**If a host's fingerprint changes,** Pallet shows a more prominent warning with the old and new
fingerprints. The server was either rebuilt deliberately, or someone is intercepting your
connection, and the fingerprint alone cannot tell you which. You can dismiss the warning, but
don't dismiss it unless you know why the key changed.

---

## Favorites

Saved connections live in the Favorites section of the sidebar, each with its color dot.

| Action   | How                                   |
| -------- | ------------------------------------- |
| Save one | **Add to Favorites** in Quick Connect |
| Connect  | Click it in the sidebar               |
| Edit     | Right-click → **Edit**                |
| Delete   | Right-click → **Delete**              |
| Reorder  | Drag it up or down the list           |

Favorites are stored in SQLite on your machine, alongside your settings. Pallet encrypts passwords
and key passphrases through macOS Keychain with Electron's `safeStorage`; the database stores only
the chosen authentication method and whether a secret exists.

Favorites also record when you last used them.

---

## Remote file management

Once a pane is connected, most local operations work the same way:

- **New folder**: ⌘⇧N
- **Rename**: Return
- **Delete**: ⌘⌫ (permanent, with a confirmation dialog; there is no server-side Trash)
- **Change permissions**: in [the inspector](#the-inspector)

**Right-click a remote file**: Open · Edit in External Editor · Copy · Rename · Delete · Refresh.

**One limitation:** remote-to-remote moves are not supported. Copy the files, then delete the
originals. A move attempt fails with an explanation instead of silently copying and deleting,
because a failure partway through that sequence loses data.

---

## Transferring files

**Drag and drop** files from one pane to the other. Drop onto a folder to go inside it, or anywhere
else in the pane to drop at the current directory. The drop target highlights.

Use the keyboard instead: **F5** or **⌘D** to copy to the other pane, **F6** to move (local only),
or **⌘C** and **⌘V** to copy and paste.

Everything goes through the **transfer queue** in the drawer at the bottom (even a 4 KB local
copy), so progress, conflicts, and error handling behave identically no matter what you move.

### How a transfer runs

1. **Enumerated first.** Pallet walks the entire source tree before transferring any bytes, so the
   job's file count and total size are known from the start. The progress bar shows measured
   totals.
2. **Staged before replacement.** Pallet writes each file to its own unique
   `.pallet-<id>.pallet-part` file. Separate jobs cannot share partial files, and an existing
   destination stays intact while Pallet transfers its replacement.
3. **Verified before replacement.** Pallet checks the staged size and confirms that the source size
   and modification time have not changed, then stamps metadata and renames the file into place.
   Local copies and SFTP servers that support POSIX rename replace atomically. Other SFTP servers
   and FTP and FTPS use the server's rename behavior; if the server refuses the replacement, the
   job reports an error instead of deleting the original. Pallet reports a lost rename reply for
   inspection instead of retrying it silently.

Folder scans reuse directory-entry metadata instead of requesting it again for every child.
Transfers use the server's concurrency setting. Jobs sharing a server take turns, while jobs using
different servers can run together. Pallet throttles progress updates to keep large batches
responsive.

### Queue controls

The queue drawer shows progress, transfer rate, and bytes moved for each job:

| Button               | What it does                     |
| -------------------- | -------------------------------- |
| **Pause**            | Interrupts active streams        |
| **Resume**           | Continues the transfer           |
| **Retry**            | Re-runs a failed job             |
| **Cancel**           | Stops and cleans up staged files |
| **Remove from list** | Clears a finished job            |

**Clear** removes all finished jobs at once. The drawer header shows aggregate progress across all
running jobs.

A job that a dropped connection paused shows **"Paused — connection lost"** and resumes
automatically. You cannot resume it manually; it waits for the network.

**If a transfer is interrupted,** local and SFTP transfers of at least 16 MiB resume from the last
confirmed 8 MiB checkpoint within the same job. Pallet repeats only the interrupted chunk. Small
files and transfers involving FTP or FTPS restart the affected file. Completed files stay complete
through pauses and automatic recovery. The **Retry** button starts a new attempt and checks
conflicts again.

**If a transfer stalls** (no bytes for 60 seconds), Pallet abandons that channel and retries with a
fresh one. Pallet retries transient stream and metadata failures up to five times with backoff;
permission and disk errors fail without repeated attempts. Network loss pauses the job during
scanning, directory creation, and copying until the session reconnects.

Cancellation cleans up the job's temporary files when the destination is reachable. A crash or an
unreachable server can leave identifiable partial files behind. Pallet keeps checkpoints in memory,
so resuming across app restarts is not supported. Verification uses sizes and source modification
times, not a full destination checksum or protection against remote disk failure.

---

## Conflicts

When a destination file already exists, the transfer pauses and asks:

| Choice        | Result                                        |
| ------------- | --------------------------------------------- |
| **Replace**   | Overwrite the destination                     |
| **Skip**      | Leave the destination alone, move on          |
| **Keep Both** | Write alongside it as `file (2).txt` and more |

Select **"Apply to all N remaining conflicts"** to answer once for the rest of the batch. Because
Pallet collects conflicts against the plan built during enumeration, 400 conflicting files produce
one question, not 400.

Pallet overwrites a file only when you choose to.

---

## The inspector

Press **⌘I** or **Space** to toggle it. The inspector shows details for a single selected item:

- Name, kind, size, date modified, full path, and extension
- **Permissions matrix**: a grid of R/W/X checkboxes across Owner, Group, and Others, plus the
  octal value (`0644`) and the symbolic string (`-rw-r--r--`)
- **Inline preview** for images and text files under 1 MB

**On a remote file, the permissions are editable.** Select checkboxes or enter an octal value to
change permissions on the server. Local permissions are read-only.

---

## Editing remote files

Right-click a remote file → **Edit in External Editor**.

Pallet downloads the file to a temporary location, opens it in your default app for that file type,
and monitors it. Every save re-uploads the file through the same `.pallet-part` staging as any
other transfer. A toast confirms each upload.

Keep the file open and keep saving; each save is another upload. Close the editor when you finish.

---

## Settings

Press **⌘,** or choose **Pallet → Settings**. A separate window opens with three tabs, and it
resizes to fit the selected tab.

### General

| Setting                    | Default | What it does                                                                             |
| -------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| **Show hidden files**      | Off     | The same switch as **⌘⇧.** in the file browser.                                          |
| **Calculate folder sizes** | Off     | Total each folder's contents instead of showing `--`. See [Folder sizes](#folder-sizes). |
| **Include remote folders** | Off     | Extends the above to connected servers. Only appears while folder sizes are on.          |

### Appearance

**Appearance**: System, Light, or Dark. System follows the macOS setting, including changes you
make while Pallet is running.

### Transfers

**Default concurrency**: 1-7, default 4. Seeds the concurrency field in Quick Connect; changing it
does not affect existing connections.

Changes save as you make them (there is no OK button) and apply to open windows immediately.
Preferences live in the same local SQLite database as your favorites.

---

## Updates

Pallet checks GitHub Releases on launch and once a day. When a newer version is available, Pallet
shows a dismissible toast rather than a modal.

GitHub prereleases are included by default. Version numbers are plain `MAJOR.MINOR.PATCH`; Pallet
does not ship versions like `0.1.0-beta.1`.

Updates are not installed automatically; that requires code signing, which is not in place.
Instead, the toast downloads the release disk image into `~/Downloads` (with a progress bar) and
mounts it. To update, click **Download update**, then drag Pallet into Applications. If a release
has no disk image, the toast links to the release page.

---

## Logs and privacy

**Pallet collects no telemetry.** There are no analytics, no crash reports, and no other outbound
requests: the only outbound request Pallet makes is the GitHub Releases version check. Your data
stays on your machine.

Logs go to `~/Library/Logs/Pallet/pallet.log`, rotating at 5 MB. Open them with **Help → Reveal Log
in Finder**.

Pallet does not log credentials, and it scrubs every line on the way to disk: it replaces inline
URL passwords, `password:` and `token:` assignments, and private-key bodies with `***`. The log is
safe to attach to a bug report, though check it first for file paths you would rather not share.

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
| `⌘,`           | Settings          |

---

## Known limitations

Deliberate omissions in the beta, not bugs:

- **SSH agent authentication**: password and private key only. Agent support, which includes
  1Password's SSH agent, is the first addition planned after the beta.
- **Remote-to-remote move**: copy, then delete.
- **Resume across app restarts or FTP and FTPS checkpoints**: checkpoint resume covers only large
  local and SFTP files within a running job.
- **Undo for transfers or deletes**: undo covers local rename and move only.
- **Search**: a good remote search needs server-side `find` with cancellation; a poor one is worse
  than none.
- **Directory tree sidebar, grid and column views, tabs, Finder tags**
- **S3 and SMB**: additional remote-storage protocols are not in this release.
- **Folder sync and mirroring**
- **Archive preview**
- **Custom themes**: light and dark, following the system or pinned in Settings.
- **Automatic updates**: they require code signing first.
- **Intel Macs**: the beta ships arm64 only.

Each omission keeps the beta focused on the core loop: browse, select, transfer, verify.
