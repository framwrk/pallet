# Black-box Electron UI regressions

These checks launch **the built Electron application**, with a new profile and disposable files.
They use the same CDP input transport as the original `file-list-focus.test.ts`, with real mouse,
wheel, and keyboard events. DOM queries observe controls and results; tests never call
`window.pallet`, IPC handlers, renderer stores, or React internals. SHA-256 digests and filesystem
listings independently verify transfers. This is behavioral coverage, not screenshot baselining.

## Commands and prerequisites

Run from the repository root, on macOS with Bun, the project's installed dependencies, and a
logged-in graphical desktop. Build first; the runner deliberately does not rebuild implicitly:

```sh
bun run build
bun run test:ui:local
```

The local suite needs neither Docker nor Accessibility. It takes roughly 10 seconds on a warm
machine, including the 10,000-file fixture. Ordinary `bun test test-server` runs skip display
coverage. `PALLET_TEST_UI=1 bun test test-server/file-list-focus.test.ts` remains supported and now
runs these same five local scenarios.

Native Settings checks use System Events to deliver Command-comma to the owned Electron process:

```sh
bun run test:ui:native
```

Enable Accessibility and Automation access for the terminal/host running the command in macOS
System Settings → Privacy & Security. This suite fails if required desktop access is unavailable;
it never silently counts an unavailable interaction as passing. It changes only the temporary
Pallet profile. It may bring its Electron window to the front; avoid typing into that window.

Server coverage requires Docker running, `ssh-keygen`, `ssh-agent`, `ssh-add`, `osascript`, and Swift
(the last two exercise native favorite context menus and Settings). It requires an **already
available** image built from this repository's `test-server/Dockerfile`, containing OpenSSH,
pure-ftpd, OpenSSL, and `tc`. The suite never installs tools, builds an image, pulls an image, or
uses the long-lived Compose services. Reuse a local Compose image (`docker compose images` shows its tag), or provision the declared
Dockerfile separately under your normal setup policy (`docker build -t pallet-ui-test:local test-server`).
Then select that local tag:

```sh
PALLET_UI_SERVER_IMAGE=your-existing-test-server-image:tag bun run test:ui:integration
```

Do not point this at production servers. There are no external-host or credential options. The
runner creates three uniquely named containers with fresh homes and a fresh random password;
SSH private/host keys and the agent socket belong to the run. Only `127.0.0.1` ports are published.
A random port block between 40000 and 63039 supplies fixed control ports (so Docker restarts keep
the same endpoint) and 32 passive ports per FTP server. Occupied ports fail setup explicitly;
rerun after resolving the conflict. Each FTP server allows **64 clients and 64 clients per IP**.
The fixtures request `NET_ADMIN` solely for the delayed-listing test. Kernel `netem` support is
required for that case. No host network settings are changed.

The integration suite uses an unshaped loopback link and 128 MiB sparse source files to make
transfer controls observable. It waits for actual staging bytes before interrupting a transfer.
It does not characterize lossy-network throughput or assume FTP control status represents the
health of data channels. Allow several minutes and several GiB of free temporary disk space.
Run one UI suite at a time: native focus is a shared desktop resource.

For all source checks:

```sh
bun run lint
bun run typecheck
bun run build
bun test test-server
PALLET_TEST_UI=1 bun test test-server
```

The macOS CI job builds/rebuilds the declared native dependency for Electron and runs the local
UI suite after the existing checks, uploading failure diagnostics for seven days. Docker/native
integration remains explicit; ordinary CI has no Docker or Accessibility requirement. A CI runner
that cannot launch Electron fails the UI step rather than silently skipping coverage.

## Automated coverage

| Suite | Scenarios and independent assertions |
| --- | --- |
| Local: navigation | Go to Folder; invalid path keeps input/error and accepts correction; Back/Forward; parent breadcrumb; Refresh discovers a newly created file |
| Local: sorting/selection | Natural Name ordering, folders first, Name/Size/Date Modified in both directions; single, command-multiple, shift-range, Select All, clear selection |
| Local: operations | Hidden toggle; New Folder retains focused rename input; creation/rename verified on disk; collision preserves both files; dialog input isolates delete/copy/new-folder shortcuts |
| Local: inspector | Empty, text, decoded PNG; filename width remains greater than 80px in an 820px viewport beside inspector |
| Local: virtualization | 10,000 entries, fewer than 100 rendered rows before/after real wheel scrolling; click final row and Arrow Up selection |
| Native | Hidden-file, folder-size, remote-size, appearance, and row-density settings persist across a full process restart; nested/empty folders total exactly 14 content bytes |
| Integration: authentication | First-use SFTP reject then accept; wrong password followed by corrected retry; trust survives process restart; changed key reject then explicit trust update; private-key path input; owned SSH-agent auth; self-signed FTPS reject followed by explicit fixture-only verification override |
| Integration: favorites | Create; native context-menu edit; password encrypted file exists with mode 0600; synthetic password absent from DB/WAL and blob; full restart and reconnect with saved password; delete removes secret and metadata, including after another restart |
| Integration: sizing | Actual remote SFTP folder displays 14 bytes, excluding nested directory metadata |
| Integration: SFTP, FTP, FTPS | Upload and download hash equality; Skip/Replace/Keep Both preserve expected originals/duplicate bytes; 43-item UI batch (40 files, empty file, Unicode/space/quote file, nested folder), including nested empty directory; recursive download verification |
| Integration: controls per protocol | Pause/resume; cancel/retry; real bytes staged before controls; old destination survives pause/cancel; eventual staging cleanup; permission-denied replacement then repair/retry; actual server stop/start and automatic recovery, ending with matching hashes |
| Integration: additional transfers | Each protocol: paused-source mutation fails safely and UI retry copies complete new version; per-item pause permits another item to finish, resume verifies both hashes; per-item cancel leaves other item intact |
| Integration: remote-to-remote | SFTP-to-FTP hash equality; Keep Both; replacement cancellation preserves old file and cleans staging; retry; restore local pane while keeping right connection |
| Integration: stale listings | Confirm a listing is pending under server-side delay; disconnect right or restore local over left; assert throughout the delayed-response window that the remote backend never reappears |

A group passes only when every assertion returns successfully. Errors stop the suite and exit
nonzero; earlier passed groups are printed. An explicitly selected suite with missing prerequisites
fails (it is not reported as skipped). The local command names the unselected integration/native
coverage. The opt-in Bun test is the sole intentionally skipped UI test in ordinary offline runs.

## Ownership, cleanup, and diagnostics

`run.ts` owns the temporary root, profile, Electron PID, agent PID and container names. `finally`
cleanup runs after assertion, setup, and transport failures. SIGINT/SIGTERM request interruption
at the next bounded operation and then run the same cleanup; no process-name kills or global
Docker cleanup are used. Electron is terminated, escalated only for that PID, and reaped before
profile removal. Container removal and agent termination are checked. A cleanup failure exits
nonzero and prints the owned root. As with any process, SIGKILL, host shutdown, or a dead Docker
daemon cannot guarantee cleanup; use the printed unique names/root to remove only that run.

Failures write ignored `.agents/artifacts/ui/<timestamp>-<case>/` diagnostics: screenshot, visible
UI text, relevant control geometry and Electron output. Synthetic passwords are redacted from text
logs and password inputs remain masked in screenshots. Keys, raw profile/DB contents, and secret
blobs are never copied to diagnostics. Docker's final log tail is printed with the password redacted.
Treat diagnostics as local test evidence, not as an application security audit.

To maintain the tests, add named scenarios in `local.ts` or `integration.ts`. Keep shared mechanics
in `electron.ts` limited to transport/input, selectors, bounded waits and owned-process shutdown.
Use accessibility names/roles and visible names instead of CSS classes where available. Assertions
throw; do not replace them with log-only results. Poll for asynchronous staging cleanup. Keep
fixtures independent of a developer's favorites, agent, servers, files and profile. A missing row
may be virtualized: the selection helper scrolls through the grid using wheel input.

## Remaining manual desktop checks

These are **not** claimed as automated by this suite. Use a separate disposable profile and fixtures,
never personal servers or files. Record OS version, app commit, result and any diagnostics.

| Interaction | Exact manual check |
| --- | --- |
| Native key picker | Connect → Private Key → Choose…; cancel once (path unchanged), then choose an owned generated key; verify path and successful fixture login. Automated integration types the path and verifies authentication, not the system picker. |
| Native menus | App → Settings… opens Settings; Command-comma while open does not close it; File → Close Remote Pane/Command-W disconnects active remote but leaves the window open; row context-menu Rename enters focused editing. Automated checks use Command-comma and favorite Edit/Delete only. |
| macOS Trash | Create a uniquely named disposable local file, select and Command-Delete; verify it leaves source and appears in Trash with identical bytes. Remove only that unique Trash fixture afterward. No suite writes to the user's Trash. |
| OS drag and drop | Use an actual mouse to drag selected local fixture to a remote pane, then verify destination SHA-256. Also drag a remote source to the other remote pane and verify bytes. No fabricated DataTransfer payload is a substitute. |
| Favorite reorder | Create three disposable favorites, drag first before third; expect insertion **before** target, restart and verify order; delete all three. Native edit/delete and reconnect are automated, reorder is manual. |

Other limits: no hardware/1Password agent
approval, physical laptop sleep, malformed/encrypted private-key matrix, production certificates,
or arbitrary lossy-network profiles are covered. Connection-handshake cancellation is disabled
and remote moves are unsupported; this suite does not add either feature.
