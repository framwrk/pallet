# SCP connections

Pallet's Quick Connect offers SCP for SSH servers that do not provide the SFTP subsystem, such as
embedded devices, routers, and hardened hosts that removed `sftp-server`. An SCP connection uses
the same SSH connection code as SFTP. That covers trust-on-first-use host keys, password,
private-key, and SSH-agent sign-in, keepalive, compression, and automatic reconnect. When an SFTP
connection fails because the server refused the subsystem, the error says to connect with SCP
instead. Pallet never falls back to SCP on its own.

SCP is its own protocol rather than an automatic fallback because it behaves differently: Pallet
browses by running shell commands on the server, transfers cannot resume mid-file, and listings
cost more than SFTP's. Favorites store which protocol actually runs.

## Requirements

The account must be able to run commands through a POSIX `sh`. Pallet also needs:

- `scp` on the server's `PATH`
- `stat`, in the GNU coreutils or BusyBox form (`stat -c`) or the BSD/macOS form (`stat -f`)
- `xargs -0`, `mv`, `rm`, `mkdir`, `chmod`, and `touch`

GNU/Linux distributions, BusyBox systems, and the BSDs and macOS ship these by default. On connect,
Pallet runs one probe: it detects the `stat` form with the same `printf | xargs -0 stat` pipeline
the listings use, checks for `scp`, and reads the home directory. A server that fails the probe is
refused with a message that names the missing command. Accounts limited to `scp` by a forced
command, `scponly`, or `rssh` cannot run the shell commands Pallet needs, so they are not
supported. Browsing a folder needs execute (search) permission on it, because the listing runs
`cd` into it.

## Setup fields

The fields match SFTP: **Server**, **Port** (22 by default), **Username**, password, **Private
Key**, or **SSH Agent** authentication, **Remote Path** (blank means the login home), and the
**Keepalive**, **Concurrency**, and **Compression** options. The pane's terminal button works as
it does for SFTP.

## How commands run

Every operation opens a short-lived SSH exec channel whose command is always the fixed string
`sh -s`. Pallet writes the script, with any paths in it, to the channel's stdin. The user's login
shell (bash, fish, csh, and so on) therefore never parses a path. Paths must be absolute and must
not contain a NUL byte. They are quoted with one function:

```ts
export function shQuote(value: string): string {
  if (value.includes("\0")) throw scpError("EINVAL", "Path contains a NUL byte");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
```

Each script prints a marker line before doing any work, and Pallet ignores anything printed
before it, such as output from a noisy `~/.bashrc`. Scripts report missing paths, non-folders,
existing destinations, and folders in the way with distinct exit codes. Pallet maps those to the
same errors the other protocols raise.

The session allows at most **Concurrency + 1** exec channels at once, the same budget as the SFTP
channel pool. That keeps Pallet below sshd's default `MaxSessions` of 10. Waiting for a free
channel gives up after 20 seconds, and a cancelled transfer stops waiting immediately. If the
server refuses to open a channel, the transfer queue treats it as a connection error and retries
with backoff.

## Listing

A listing is one script and does not fork a process per entry:

```sh
cd -- '/the dir'
set -- * .[!.]* ..?*
# for each existing entry: printf '<d|f|u><name>\0'   (target kind: folder, other, dangling)
printf '\0'
# then the same entries, NUL-separated, through: xargs -0 stat -c '%f %s %Y %n' --   (GNU/BusyBox)
#                                            or: xargs -0 stat -f '%p %z %m %N' --   (BSD)
```

The three globs match every name except `.` and `..`. Names arrive NUL-delimited, so spaces,
newlines, quotes, and unicode survive intact. Each `stat` line is matched against the name already
read, so a newline inside a name cannot shift the results. An entry that disappears mid-listing is
dropped. Any other `stat` error, or output that does not parse, fails the listing. Sizes, modes,
and modification times come from `lstat`. Symlinks show as links, with the target kind taken from
`[ -d ]`. Folder sizing walks these listings and never descends into a symlink, so it cannot
loop.

## Transfers

- **Uploads** run `scp -p -t -- '<staged path>'`. The staged name is the usual
  `.pallet-<id>.pallet-part` beside the destination. Pallet announces the exact size and the
  four-digit mode in the `C` record and the modification time in a `T` record. Because of `-p`,
  the remote `scp` applies both exactly, regardless of the server's umask. An upload counts as
  written only after the remote `scp` acknowledges the end of the data and exits with status 0. A
  stream that ends short of, or runs past, the announced size fails the file.
- **Replacement** runs `mv -f` from the staged file to the destination. If the destination is a
  folder, or a symlink to one, the replacement fails instead of moving the staged file inside it.
  The destination is never written directly, so an existing file survives a failed upload.
- **Downloads** run `scp -p -f -- '<path>'`. Pallet reads the `T` and `C` records as bounded,
  newline-terminated lines and takes the size from them. The name inside the `C` record is
  ignored, because OpenSSH escapes newlines there; the requested path identifies the file. The
  download finishes only after the remote `scp` reports final success and exits with status 0.
- **Progress** is counted as bytes flow, with SSH flow control providing backpressure.
- **Cancel** closes the exec channel, so the remote `scp` exits. The queue then deletes the staged
  file with `rm -f`.
- **No resume.** SCP has no offsets, so an interrupted, paused, or retried SCP file restarts from
  byte zero. Files that already completed stay complete.
- **SHA-256 verification** works as for other protocols. A verified upload is written with mode
  `0600` first. After the digests match, Pallet runs `TZ=UTC0 touch -t` and `chmod` to set the
  final modification time and mode, then replaces the destination.

## Browsing operations

| Operation        | Command                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| Info             | `stat` on one path (lstat data)                                             |
| New folder       | `mkdir --`, refusing an existing name                                       |
| Rename           | refuses an existing destination, then `mv --`                               |
| Delete           | `rm -rf --`, which removes symlinks without following them                  |
| Permissions      | `chmod <octal>`                                                             |
| Preview          | `scp -f`, closing the channel after the preview limit                       |
| Resolve a folder | `cd -- <path> && pwd -P`, used for **Remote Path** and the Go to Folder box |

The rename check and the move are two separate commands, so a file created between them can be
overwritten. SFTP has the same gap between its check and its rename.

## Limits

- Dropbear's `scp` refuses filenames that contain a newline, so Pallet cannot transfer those
  files to or from Dropbear servers. Listing them still works.
- Filenames are decoded as UTF-8, as they are for SFTP.
- Free space is not shown.

## Tests

`test-server/scp.test.ts` runs `SessionManager`, the browse service, the endpoint, and the transfer
queue against an in-process ssh2 server with no SFTP subsystem. That server's exec channel runs the
local `/bin/sh` and the system `scp`, so the macOS run exercises the BSD `stat` path for real. The
same file tests quoting through a real shell and parses GNU/BusyBox and BSD output.
`test-server/scp-favorite.test.ts` covers favorite storage. Both are part of `bun run test:offline`.

The opt-in live check runs against Alpine, which has BusyBox `ash` and `stat` and OpenSSH `scp`,
with no SFTP subsystem:

```sh
docker compose --profile scp up -d --build --wait scp
bun run test:scp
```

The SCP-only server listens on `127.0.0.1:2223` (override with `PALLET_SCP_TEST_PORT`). The check
confirms that SFTP is refused with the SCP hint. It then uploads and downloads a tree with SHA-256
verification, including empty, large, unicode, and hostile names. It also lists, previews, sizes,
copies on the same session, renames, runs `chmod`, drops the connection to confirm reconnect, and
deletes its check folder.
