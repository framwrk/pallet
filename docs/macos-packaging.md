# macOS packaging

`electron-builder.yml` allowlists `out/**` and `package.json`. Electron Builder adds
production dependencies from `node_modules` separately and automatically unpacks native
modules. Source files, tests, scripts, documentation, local agent files, and other project
files must stay outside `app.asar`. Runtime assets imported by Vite belong in `out/`.

`mac.extendInfo` must be a dictionary. Its five `NS*FolderUsageDescription` strings become
top-level keys in `Pallet.app/Contents/Info.plist`. An array instead produces numeric keys
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

- Documents, Downloads, Movies, Music, and Pictures descriptions are top-level strings,
  with no numeric keys or `length` key.
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
