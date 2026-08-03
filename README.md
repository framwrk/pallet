# Pallet

A free and open-source macOS SSH/SFTP file manager

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

### Tests

```bash
bun run lint
bun run typecheck
bun run test              # unit: path utils, conflict naming, semver
bun run test:integration  # SFTP + transfers against Dockerized OpenSSH (needs Docker)
bun run test:resilience   # connection-drop-mid-transfer safety (needs Docker)
bun run test:interop      # round-trip against SFTPGo, a non-OpenSSH server (needs Docker)
bun run test:advanced     # keepalive / compression / concurrency options (needs Docker)
bun run test:scale        # 5 GB file + 10,000-file directory, both ways (needs Docker, slow)
```

The integration suites build real SFTP servers in Docker and drive the actual main-process
services against them — no mocks. They check that the Docker daemon is reachable before doing any
work and fail immediately with an actionable message if it isn't, and they clean up leftover
containers from a previous run rather than waiting on a port the corpse still holds. No suite can
hang: every wait has a deadline and every run has an overall ceiling.

Scale is tunable:

```bash
PALLET_SCALE_GB=1 PALLET_SCALE_FILES=2000 bun run test:scale
```

Everything under `tests/node/` runs on Node rather than Bun. That's deliberate: Pallet ships on
Electron, and `ssh2`'s streams behave differently on Bun's runtime — a dead channel's callbacks
never fire there, so reconnect paths stall in ways they never do in the real app. Those suites
test the runtime we actually ship.

## License

[Apache License 2.0](LICENSE).

## Acknowledgments

Inspired by [ForkLift 4](https://binarynights.com/) by BinaryNights. Built with Electron, React,
Tailwind CSS, shadcn/ui on Base UI, TanStack Virtual, `ssh2`, and `better-sqlite3`.
