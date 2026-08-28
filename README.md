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

Stop and remove the servers with `bun run server:stop`.

## License

[Apache License 2.0](LICENSE).

## Acknowledgments

Inspired by [ForkLift 4](https://binarynights.com/) by BinaryNights. Built with Electron, React,
Tailwind CSS, shadcn/ui on Base UI, TanStack Virtual, `ssh2`, and `better-sqlite3`.
