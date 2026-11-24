# macOS packaging

`electron-builder.yml` allowlists `out/**` and `package.json`. Electron Builder adds
production dependencies from `node_modules` separately and automatically unpacks native
modules. Source files, tests, scripts, documentation, local agent files, and other project
files must stay outside `app.asar`. Runtime assets imported by Vite belong in `out/`.

`mac.extendInfo` must be a dictionary. Its five `NS*FolderUsageDescription` strings and
`NSLocalNetworkUsageDescription` become top-level keys in `Pallet.app/Contents/Info.plist`.
Without `NSLocalNetworkUsageDescription`, macOS never asks for Local Network access and
connections to LAN hosts such as a NAS fail with `EHOSTUNREACH`.

`mac.identity: "-"` ad-hoc signs the whole bundle as `com.framwrk.pallet`. Unsigned builds
keep Electron's stock signature, which no longer matches the modified bundle; macOS then
denies Local Network access without prompting. Ad-hoc signing with the hardened runtime
needs `com.apple.security.cs.disable-library-validation` in `build/entitlements.mac.plist`. An array instead produces numeric keys
and a `length` key, which macOS does not use as folder usage descriptions.

Run the configuration regressions before packaging:

```bash
bun test test-server/packaging.test.ts
```

After installing and rebuilding the declared dependencies as described in the README,
build locally without signing or publishing:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false bun run build:mac
```

Inspect the actual packaged files, not just the YAML:

```bash
plutil -lint dist/mac-arm64/Pallet.app/Contents/Info.plist
plutil -p dist/mac-arm64/Pallet.app/Contents/Info.plist
node_modules/.bin/asar list dist/mac-arm64/Pallet.app/Contents/Resources/app.asar
```

Verify that:

- Documents, Downloads, Movies, Music, and Pictures descriptions and
  `NSLocalNetworkUsageDescription` are top-level strings, with no numeric keys or `length` key.
- `codesign -dv` reports `Identifier=com.framwrk.pallet`, and
  `codesign --verify --deep --strict` passes on the app.
- The archive has only `out`, `package.json`, and `node_modules` at its root. Main and
  preload entry points, renderer HTML, JavaScript, CSS, fonts, and other built assets exist.
- Production dependencies remain present, including `better-sqlite3`, `ssh2`, and
  `basic-ftp`. Native binaries have matching files in `app.asar.unpacked`.
- The distributable ZIP contains the same `Info.plist` and `app.asar` as the inspected
  app. Run `unzip -tq` on the ZIP and `hdiutil verify` on the DMG to check their integrity.

To preserve an existing `dist/mac-arm64` build, pass
`--config.directories.output=dist/packaging-check` to `bun run build:mac` and adjust the
inspection paths. For verification using only the already installed Electron distribution,
also pass `--config.electronDist=node_modules/electron/dist`.

## Release workflow

- Push a `vMAJOR.MINOR.PATCH` tag only after its commit is on `main` and its version matches `package.json`.
- [Release CI](../.github/workflows/release.yml) runs lint, typechecks, and offline tests, rebuilds native
  modules, then builds and verifies the unsigned arm64 package. It does not run the UI suite.
- `bash scripts/verify-release.sh vX.Y.Z` checks the DMG and app version and writes `dist/checksums.txt`.
  The release publishes the DMG and checksums; the locally built ZIP is not uploaded. Versions below
  1.0.0 are marked as GitHub prereleases.
- `bash scripts/preview-release-notes.sh X.Y.Z` previews GitHub-generated notes with an authenticated
  `gh` CLI. It reads remote history and does not publish anything.
