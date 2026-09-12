# Pallet

A free and open-source macOS SFTP, FTP, and explicit FTPS file manager

## Features

See [FEATURES.md](FEATURES.md) for a detailed feature list and keyboard shortcuts.

## Installing

### Download

Grab the latest `.dmg` from the [Releases page](https://github.com/framwrk/pallet/releases),
open it, and drag **Pallet** to your Applications folder.

### First launch: getting past Gatekeeper

**Pallet is not code-signed or notarized yet**. macOS will refuse to open it on the
first try.

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

Requires [Bun](https://bun.sh) 1.3+ and Xcode command line tools. Pallet uses Bun exclusively —
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
| `offline`             | —            | —            | —                           | 100%                        |
| `off`                 | Unrestricted | Unrestricted | None                        | None                        |

These are synthetic test presets, not measurements of a particular network. The default adds
roughly 80 ms round-trip latency before queuing and retransmissions; `poor` adds roughly 300 ms.
Bandwidth is shared by all connections **per server**, not allocated separately to every transfer.
Packet loss is random, so repeated runs can behave differently. TCP may recover from loss;
successful tests on these profiles are expected when the application handles the conditions well.

```bash
PALLET_TEST_NETWORK=poor bun run server
PALLET_TEST_NETWORK=off bun run server
```

Override individual settings using `PALLET_TEST_DOWNLOAD_KBIT`, `PALLET_TEST_UPLOAD_KBIT`,
`PALLET_TEST_DELAY_MS`, `PALLET_TEST_JITTER_MS`, and `PALLET_TEST_LOSS_PERCENT`. Rates are positive
whole numbers in kilobits/second; delay and jitter are nonnegative whole milliseconds, with jitter
no greater than delay. Loss accepts 0–100, including decimals. `off` and `offline` ignore these overrides.
For example, use a slower but deterministic link for a timing test:

```bash
PALLET_TEST_DOWNLOAD_KBIT=2000 PALLET_TEST_UPLOAD_KBIT=500 \
  PALLET_TEST_JITTER_MS=0 PALLET_TEST_LOSS_PERCENT=0 bun run server
```

The containers use Linux `tc`/netem and a virtual Ethernet pair to shape both directions. They require
`NET_ADMIN` (granted by Compose) and Docker kernel support for netem and veth. Startup fails if
shaping cannot be applied; it never silently falls back to an unrestricted connection. See the
[netem manual](https://man7.org/linux/man-pages/man8/tc-netem.8.html) for timing limitations.
This affects only the test containers, not the rest of your computer's network.

To simulate a connection dropping **during** a transfer without restarting the server, apply an
outage, then restore the startup settings in a separate command when ready:

```bash
docker compose exec -e PALLET_TEST_NETWORK=offline sftp test-server-network
# Resume the connection using this container's original environment:
docker compose exec sftp test-server-network
```

Replace `sftp` with `ftp` or `ftps` to affect that server. A short outage may stall and recover;
a longer one can trigger application timeouts. Live changes last until reapplied or the container
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
and recovery in an isolated SFTP container. It uses a temporary local port and removes its container
afterwards. The ordinary protocol and application checks use your active profile; `offline` should
fail connection checks, and adverse profiles can expose timeouts rather than always passing.

Stop and remove the servers with `bun run server:stop`.

## License

[Apache License 2.0](LICENSE).

## Acknowledgments

Inspired by [ForkLift 4](https://binarynights.com/) by BinaryNights. Built with Electron, React,
Tailwind CSS, shadcn/ui on Base UI, TanStack Virtual, `ssh2`, and `better-sqlite3`.
