<div align="center">

# Pallet

**A free and open-source dual-pane file manager for macOS.**

Connect to servers over SFTP, FTP, or explicit FTPS, and move files between your Mac and remote
servers.

[![Release](https://img.shields.io/github/v/release/framwrk/pallet?sort=semver&label=release)](https://github.com/framwrk/pallet/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20arm64-black.svg)](FEATURES.md#known-limitations)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-f472b6.svg)](https://bun.sh)

[Download](#installing) · [Features](#features) · [Build from source](#building-from-source) · [Contributing](#contributing) · [License](#license)

</div>

---

## Features

Pallet pairs a Finder-familiar local pane with a remote pane. The left pane is your Mac; the right
pane is the server. Press **⌘K** to connect, select a file, and press **F5** to send it to the other
pane.

- **SFTP, FTP, and explicit FTPS:** password or private-key authentication, per-connection
  keepalive, concurrency, and compression options, and SSH trust-on-first-use host key verification.
- **Real transfer totals:** Pallet enumerates every job before the first byte moves, so progress
  bars show actual totals. Files are written to staged temporary files, verified, and renamed into
  place, so a failed transfer leaves the existing destination intact.
- **Automatic recovery:** a dropped Wi-Fi connection or a sleeping laptop pauses the queue, and
  Pallet resumes it with backoff after the connection returns. Large SFTP transfers checkpoint every
  8 MiB and resume from the last confirmed chunk. Pallet abandons stalled channels and retries them
  on fresh ones.
- **Keyboard-first:** F5 and F6 to copy or move across panes, ⌘K to connect, Return to rename, ⌘⌫
  to move files to the Trash, and ⌘⇧. for hidden files. The full list, including the known
  limitations, is in [FEATURES.md](FEATURES.md).
- **Favorites with encrypted secrets:** connections are saved in SQLite on your machine. Pallet
  encrypts passwords and key passphrases through macOS Keychain and stores no secrets in the
  database.
- **Built for large directories:** virtualized file lists render 10,000-entry folders without
  loading every row, and optional folder-size calculation walks only the rows on screen.
- **Inspector:** a permissions matrix with octal and symbolic views (editable on remote files),
  inline image and text preview, and full path details.
- **No telemetry:** no analytics, no crash reporting, and no other outbound requests. The only
  outbound request Pallet makes is a GitHub Releases version check.

## Installing

### Download

Download the `.dmg` from the [Releases page](https://github.com/framwrk/pallet/releases), open it,
and drag **Pallet** to your Applications folder.

### First launch and Gatekeeper

**Pallet is not code-signed or notarized.** macOS refuses to open the app on the first launch.

To open it anyway:

1. Double-click **Pallet** in Applications, then click **Done**.
2. Open **System Settings → Privacy & Security**, and scroll to the **Security** section.
3. The Security section shows _"Pallet was blocked to protect your Mac."_ Click **Open Anyway**,
   then confirm.

Pallet opens normally from then on.

If that option does not appear, clear the quarantine attribute manually:

```bash
xattr -cr /Applications/Pallet.app
```

Then launch the app again.

## Building from source

Requires [Bun](https://bun.sh) 1.3 or later and the Xcode command line tools. Pallet is tested with
Bun only; `npm`, `pnpm`, and `yarn` are untested.

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

The offline suite covers deterministic filesystem and fault-injection scenarios without Docker. It
includes 2,100-file folders, checkpoint resume, pausing and canceling, conflicting names, source
changes, and safe replacement:

```bash
bun run test:transfers
```

### Local test servers

Docker is required. Start local SFTP, FTP, and explicit FTPS servers in the background:

```bash
bun run server
```

The servers simulate a constrained connection by default for uploads, downloads, and FTP and FTPS
passive data connections. Choose a profile when starting or recreating them:

| `PALLET_TEST_NETWORK` | Download     | Upload       | Added delay, each direction | Packet loss, each direction |
| --------------------- | ------------ | ------------ | --------------------------- | --------------------------- |
| `performant`          | 1000 Mbit/s  | 1000 Mbit/s  | 1 ms                        | 0%                          |
| `optimal`             | 100 Mbit/s   | 50 Mbit/s    | 10 ms ± 2 ms                | 0%                          |
| `realistic` (default) | 10 Mbit/s    | 2 Mbit/s     | 40 ms ± 10 ms               | 0.1%                        |
| `poor`                | 1.5 Mbit/s   | 0.5 Mbit/s   | 150 ms ± 50 ms              | 2%                          |
| `offline`             | n/a          | n/a          | n/a                         | 100%                        |
| `off`                 | Unrestricted | Unrestricted | None                        | None                        |

These are synthetic test presets, not measurements of a particular network. The default adds roughly
80 ms of round-trip latency before queuing and retransmissions; `poor` adds roughly 300 ms, while
`optimal` and `performant` add roughly 20 ms and 2 ms for high-throughput and low-latency checks.
`performant` still shapes traffic, so it exercises throttling at gigabit rates; only `off` removes
shaping entirely. Bandwidth is shared by all connections **per server**, not allocated separately to
every transfer. Packet loss is random, so repeated runs can behave differently. TCP can recover from
some loss, so runs on these profiles can still succeed.

```bash
PALLET_TEST_NETWORK=poor bun run server
PALLET_TEST_NETWORK=off bun run server
```

Override individual settings with `PALLET_TEST_DOWNLOAD_KBIT`, `PALLET_TEST_UPLOAD_KBIT`,
`PALLET_TEST_DELAY_MS`, `PALLET_TEST_JITTER_MS`, and `PALLET_TEST_LOSS_PERCENT`. Rates are positive
whole numbers in kilobits per second; delay and jitter are nonnegative whole milliseconds, with
jitter no greater than delay. Loss accepts 0-100, including decimals. `off` and `offline` ignore
these overrides. For example, use a slower but deterministic link for a timing test:

```bash
PALLET_TEST_DOWNLOAD_KBIT=2000 PALLET_TEST_UPLOAD_KBIT=500 \
  PALLET_TEST_JITTER_MS=0 PALLET_TEST_LOSS_PERCENT=0 bun run server
```

The containers use Linux `tc` (netem) and a virtual Ethernet pair to shape both directions. They
require `NET_ADMIN` (granted by Compose) and Docker kernel support for netem and veth. Startup fails
if shaping cannot be applied; the containers do not fall back to an unrestricted connection. See the
[netem manual](https://man7.org/linux/man-pages/man8/tc-netem.8.html) for timing limitations. This
affects only the test containers, not the rest of your computer's network.

To simulate a connection dropping during a transfer without restarting the server, apply an outage,
then restore the startup settings in a separate command when you are ready:

```bash
docker compose exec -e PALLET_TEST_NETWORK=offline sftp test-server-network
# Resume the connection using this container's original environment:
docker compose exec sftp test-server-network
```

Replace `sftp` with `ftp` or `ftps` to affect that server. A short outage may stall and recover; a
longer one can trigger application timeouts. Live changes last until you reapply them or the
container restarts. Inspect active rules and packet and drop counters with:

```bash
docker compose exec sftp test-server-network status
```

Connect from Pallet with these test-only credentials:

| Protocol      | Server      | Port   | Username | Password | Remote path    |
| ------------- | ----------- | ------ | -------- | -------- | -------------- |
| SFTP          | `localhost` | `2222` | `pallet` | `pallet` | `/home/pallet` |
| FTP           | `localhost` | `2121` | `pallet` | `pallet` | `/`            |
| Explicit FTPS | `localhost` | `2122` | `pallet` | `pallet` | `/`            |

The SSH host keys persist across container rebuilds, so Pallet's trusted-host entry remains valid.
FTPS generates a self-signed certificate for `localhost` on first start and persists it in a Docker
volume, so its fingerprint remains stable across rebuilds. It is for local testing only. The FTP
server uses passive ports `30000-30009`, and the FTPS server uses `30100-30109`. Disable certificate
verification in the connection dialog's Options section when connecting to this local FTPS server,
and keep verification enabled for production servers.

Use `PALLET_TEST_SERVER_PORT`, `PALLET_TEST_FTP_PORT`, or `PALLET_TEST_FTPS_PORT` to override a
control port, and `PALLET_TEST_PASSWORD` to override the shared password. After the servers start,
verify login, listing, download, upload, and deletion over all three protocols:

```bash
bun run server:verify
```

To exercise Pallet's own session, browsing, transfer, preview, folder-size, and mutation adapters
against all three servers, run `bun run server:verify:app`.

Run `bun run server:verify:network` to check actual upload and download throttling, latency, an
outage, and recovery in an isolated SFTP container. It uses a temporary local port and removes its
container afterward. The ordinary protocol and application checks use your active profile;
connection checks fail under `offline`, and adverse profiles can produce timeouts instead of
passing.

Stop and remove the servers with `bun run server:stop`.

### End-to-end transfer verification

With the local test servers running, `bun run server:verify:transfers` exercises the actual queue
over SFTP, FTP, and FTPS and compares SHA-256 hashes after downloading. It also checks overwrites
and same-session remote copies with concurrency set to one. Set `PALLET_TEST_DISCONNECT=1` to also
force a real SSH disconnect in the SFTP test and check automatic recovery.

Use `PALLET_TEST_PROTOCOL=sftp` (or `ftp` or `ftps`) to select a protocol,
`PALLET_TEST_FILE_COUNT=2100` for a larger batch, and `PALLET_TEST_TRANSFER_TIMEOUT_MS=900000` when
you deliberately use a slow network profile. The SFTP test includes a file larger than 16 MiB and an
injected interruption after the first checkpoint. Use `PALLET_TEST_LARGE_FILE=0` for a small smoke
test on a deliberately slow link. Test artifacts use unique temporary directories; the tests remove
them when they exit normally.

## Contributing

Bug reports and pull requests are welcome. Before you open a pull request (PR), make sure
`bun run lint` and `bun run typecheck` pass.

## License

[Apache License 2.0](LICENSE).

## Acknowledgments

Inspired by [ForkLift 4](https://binarynights.com/) by BinaryNights. Built with Electron, React,
Tailwind CSS, shadcn/ui on Base UI, TanStack Virtual, `ssh2`, and `better-sqlite3`.
