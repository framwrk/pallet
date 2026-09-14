<div align="center">

# Pallet

**A free and open-source dual-pane file manager for macOS.**

Connect to servers over SFTP, FTP, or explicit FTPS, and move files like you mean it.

[![Release](https://img.shields.io/github/v/release/framwrk/pallet?sort=semver&label=release)](https://github.com/framwrk/pallet/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20arm64-black.svg)](FEATURES.md#what-pallet-does-not-do-yet)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-f472b6.svg)](https://bun.sh)

[Download](#installing) · [Features](#features) · [Build from source](#building-from-source) · [Contributing](#contributing) · [License](#license)

</div>

---

## Features

Pallet pairs a Finder-familiar local browser with a fast remote pane. The left pane is always your
Mac; the right pane is always the server. **⌘K** to connect, select a file, **F5** to send it
across. That's the whole loop.

- **SFTP, FTP, and explicit FTPS:** password or private-key auth, per-connection keepalive,
  concurrency, and compression options, and SSH trust-on-first-use host key verification.
- **A transfer queue that tells the truth:** every job is enumerated before the first byte moves,
  so progress bars show real totals. Files are written to staged temp files, verified, and renamed
  into place; an existing destination is never damaged by a failed transfer.
- **Self-healing connections:** a dropped Wi-Fi or sleeping laptop pauses the queue and resumes on
  its own with backoff. Large SFTP transfers checkpoint every 8 MiB and resume from the last
  confirmed chunk. Stalled channels are abandoned and retried on fresh ones.
- **Keyboard-first:** F5/F6 to copy/move across panes, ⌘K to connect, Return to rename, ⌘⌫ to
  Trash, ⌘⇧. for hidden files. The full map is in [FEATURES.md](FEATURES.md).
- **Favorites with real secrets hygiene:** connections saved in SQLite on your machine;
  passwords and key passphrases encrypted through macOS Keychain, never in the database.
- **Built for large directories:** virtualized file lists keep 10,000-entry folders scrolling
  smoothly, and optional folder-size calculation walks only what's on screen.
- **A real inspector:** permissions matrix with octal and symbolic views (editable on remote
  files), inline image and text preview, and full path details.
- **No telemetry. Ever.** No analytics, no crash reporting, no phone-home. The only outbound
  request Pallet makes is a GitHub Releases version check.

See [FEATURES.md](FEATURES.md) for everything Pallet can do, including the complete keyboard
shortcuts and a candid list of what it doesn't do yet.

## Installing

### Download

Grab the latest `.dmg` from the [Releases page](https://github.com/framwrk/pallet/releases), open
it, and drag **Pallet** to your Applications folder.

### First launch: getting past Gatekeeper

**Pallet is not code-signed or notarized yet.** macOS will refuse to open it on the first try.

Do this instead:

1. Double-click **Pallet** in Applications. Click **Done**.
2. Open **System Settings → Privacy & Security**, scroll to the **Security** section.
3. You'll see _"Pallet was blocked to protect your Mac."_ Click **Open Anyway**, then confirm.

Pallet opens normally from then on.

If that option doesn't appear, clear the quarantine attribute manually:

```bash
xattr -cr /Applications/Pallet.app
```

Then launch it again.

## Building from source

Requires [Bun](https://bun.sh) 1.3+ and Xcode command line tools. Pallet uses Bun exclusively;
`npm`/`pnpm`/`yarn` are not tested.

```bash
git clone https://github.com/framwrk/pallet.git
cd pallet
bun install
bun run rebuild     # rebuild native modules against Electron's ABI
bun run dev         # run in development
bun run build:mac   # produce a .dmg and .zip in dist/
```

### Checks

```bash
bun run lint
bun run typecheck
```

## Testing

### Offline tests

Deterministic filesystem and fault-injection coverage, no Docker required, including 2,100-file
folders, checkpoint resume, pause/cancel, conflicting names, source changes, and safe replacement:

```bash
bun run test:transfers
```

### Local test servers

Docker is required. Start local SFTP, FTP, and explicit FTPS servers in the background with:

```bash
bun run server
```

The servers simulate a constrained connection by default, including uploads, downloads, and
FTP/FTPS passive data connections. Choose a profile when starting or recreating them:

| `PALLET_TEST_NETWORK` | Download     | Upload       | Added delay, each direction | Packet loss, each direction |
| --------------------- | ------------ | ------------ | --------------------------- | --------------------------- |
| `realistic` (default) | 10 Mbit/s    | 2 Mbit/s     | 40 ms ± 10 ms               | 0.1%                        |
| `poor`                | 1.5 Mbit/s   | 0.5 Mbit/s   | 150 ms ± 50 ms              | 2%                          |
| `optimal`             | 100 Mbit/s   | 50 Mbit/s    | 10 ms ± 2 ms                | 0%                          |
| `performant`          | 1000 Mbit/s  | 1000 Mbit/s  | 1 ms                        | 0%                          |
| `offline`             | n/a          | n/a          | n/a                         | 100%                        |
| `off`                 | Unrestricted | Unrestricted | None                        | None                        |

These are synthetic test presets, not measurements of a particular network. The default adds
roughly 80 ms round-trip latency before queuing and retransmissions; `poor` adds roughly 300 ms,
while `optimal` and `performant` add roughly 20 ms and 2 ms for high-throughput and near-LAN
checks. `performant` is still shaped, so it exercises throttling at gigabit rates; only `off`
removes shaping entirely. Bandwidth is shared by all connections **per server**, not allocated
separately to every transfer. Packet loss is random, so repeated runs can behave differently. TCP
may recover from loss; successful tests on these profiles are expected when the application
handles the conditions well.

```bash
PALLET_TEST_NETWORK=poor bun run server
PALLET_TEST_NETWORK=off bun run server
```

Override individual settings using `PALLET_TEST_DOWNLOAD_KBIT`, `PALLET_TEST_UPLOAD_KBIT`,
`PALLET_TEST_DELAY_MS`, `PALLET_TEST_JITTER_MS`, and `PALLET_TEST_LOSS_PERCENT`. Rates are positive
whole numbers in kilobits/second; delay and jitter are nonnegative whole milliseconds, with jitter
no greater than delay. Loss accepts 0-100, including decimals. `off` and `offline` ignore these
overrides. For example, use a slower but deterministic link for a timing test:

```bash
PALLET_TEST_DOWNLOAD_KBIT=2000 PALLET_TEST_UPLOAD_KBIT=500 \
  PALLET_TEST_JITTER_MS=0 PALLET_TEST_LOSS_PERCENT=0 bun run server
```

The containers use Linux `tc`/netem and a virtual Ethernet pair to shape both directions. They
require `NET_ADMIN` (granted by Compose) and Docker kernel support for netem and veth. Startup
fails if shaping cannot be applied; it never silently falls back to an unrestricted connection. See
the [netem manual](https://man7.org/linux/man-pages/man8/tc-netem.8.html) for timing limitations.
This affects only the test containers, not the rest of your computer's network.

To simulate a connection dropping **during** a transfer without restarting the server, apply an
outage, then restore the startup settings in a separate command when ready:

```bash
docker compose exec -e PALLET_TEST_NETWORK=offline sftp test-server-network
# Resume the connection using this container's original environment:
docker compose exec sftp test-server-network
```

Replace `sftp` with `ftp` or `ftps` to affect that server. A short outage may stall and recover; a
longer one can trigger application timeouts. Live changes last until reapplied or the container
restarts. Inspect active rules and packet/drop counters with:

```bash
docker compose exec sftp test-server-network status
```

Connect from Pallet with these test-only credentials:

| Protocol      | Server      | Port   | Username | Password | Remote path    |
| ------------- | ----------- | ------ | -------- | -------- | -------------- |
| SFTP          | `localhost` | `2222` | `pallet` | `pallet` | `/home/pallet` |
| FTP           | `localhost` | `2121` | `pallet` | `pallet` | `/`            |
| Explicit FTPS | `localhost` | `2122` | `pallet` | `pallet` | `/`            |

The SSH host keys persist across container rebuilds so Pallet's trusted-host entry remains valid.
FTPS generates a self-signed certificate for `localhost` on first start and persists it in a Docker
volume so its fingerprint remains stable across rebuilds. It is only for local testing. The FTP
servers use passive ports `30000-30009` and `30100-30109`, respectively. Disable certificate
verification in the connection dialog's Options section when connecting to this local FTPS server;
never disable it for a production server.

Use `PALLET_TEST_SERVER_PORT`, `PALLET_TEST_FTP_PORT`, or `PALLET_TEST_FTPS_PORT` to override a
control port, and use `PALLET_TEST_PASSWORD` to override the shared password. After the servers are
healthy, verify login, listing, download, upload, and deletion over all three protocols with:

```bash
bun run server:verify
```

To exercise Pallet's own session, browsing, transfer, preview, folder-size, and mutation adapters
against all three servers, run `bun run server:verify:app`.

Run `bun run server:verify:network` to check actual upload/download throttling, latency, an outage,
and recovery in an isolated SFTP container. It uses a temporary local port and removes its
container afterwards. The ordinary protocol and application checks use your active profile;
`offline` should fail connection checks, and adverse profiles can expose timeouts rather than
always passing.

Stop and remove the servers with `bun run server:stop`.

### End-to-end transfer verification

With the local test servers running, `bun run server:verify:transfers` exercises the actual queue
over SFTP, FTP, and FTPS and compares SHA-256 hashes after downloading. It also checks overwrites
and same-session remote copies with concurrency set to one. Set `PALLET_TEST_DISCONNECT=1` to also
force a real SSH disconnect in the SFTP test and check automatic recovery.

Use `PALLET_TEST_PROTOCOL=sftp` (or `ftp` / `ftps`) to select a protocol,
`PALLET_TEST_FILE_COUNT=2100` for a larger batch, and `PALLET_TEST_TRANSFER_TIMEOUT_MS=900000` when
deliberately using a slow network profile. The SFTP test includes a file larger than 16 MiB and an
injected interruption after the first checkpoint. Use `PALLET_TEST_LARGE_FILE=0` for a small smoke
test on a deliberately slow link. Test artifacts use unique temporary directories and are removed
when the test exits normally.

## Contributing

Bug reports and pull requests are welcome. Before opening a PR, make sure `bun run lint` and
`bun run typecheck` pass.

## License

[Apache License 2.0](LICENSE).

## Acknowledgments

Inspired by [ForkLift 4](https://binarynights.com/) by BinaryNights. Built with Electron, React,
Tailwind CSS, shadcn/ui on Base UI, TanStack Virtual, `ssh2`, and `better-sqlite3`.
