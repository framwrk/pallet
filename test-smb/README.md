# Live SMB check

`test:smb` exercises Pallet's SMB session, browsing, and transfer code against a disposable Samba
server. It is opt-in and outside `bun test test-server`, so Docker is never needed for the offline
suite.

## 1. Start Samba

```sh
docker compose --profile smb up -d --build --wait smb
```

Samba listens on `127.0.0.1:1445` (override with `PALLET_SMB_TEST_PORT`) and exports the share
`pallet` to the user `pallet`. The password defaults to `pallet`; override it with
`PALLET_TEST_PASSWORD`. The image installs Alpine's `samba` package and keeps Samba's default
security settings, which require NTLMv2.

## 2. Run the check

```sh
bun run test:smb
```

The check rejects a wrong password and a missing share, then uploads, lists, previews, sizes,
replaces, downloads (with SHA-256 verification), copies on the same session, renames, drops the
connection to confirm reconnect, and deletes everything it created under one
`/pallet-smb-check-*` folder.

To test with signing and encryption required, change the running server and run the check again:

```sh
docker compose --profile smb exec smb sh -c \
  "sed -i 's/^\[global\]/[global]\n  server signing = mandatory\n  smb encrypt = required/' /etc/samba/smb.conf && smbcontrol all reload-config"
bun run test:smb
docker compose --profile smb up -d --force-recreate --wait smb
```

## 3. Stop Samba

```sh
docker compose --profile smb down
```
