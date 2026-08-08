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

### Checks

```bash
bun run lint
bun run typecheck
```

## License

[Apache License 2.0](LICENSE).

## Acknowledgments

Inspired by [ForkLift 4](https://binarynights.com/) by BinaryNights. Built with Electron, React,
Tailwind CSS, shadcn/ui on Base UI, TanStack Virtual, `ssh2`, and `better-sqlite3`.
