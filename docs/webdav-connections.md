# WebDAV connections

Pallet's Quick Connect supports WebDAV (HTTP) and WebDAVS (HTTPS) alongside SFTP, FTP, FTPS, S3,
and SMB. One connection is scoped to an optional server path; the pane's `/` is that path. The
client is tested against an in-process WebDAV server that answers like Apache `mod_dav`. Nextcloud,
ownCloud, Synology, nginx, and IIS speak the same protocol but are not separately verified.

## Setup fields

| Field            | Notes                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| **Protocol**     | WebDAV for `http://`, WebDAVS for `https://`.                                                                  |
| **Server**       | Hostname or IP. Do not include the scheme or a path.                                                           |
| **Port**         | 80 for WebDAV and 443 for WebDAVS by default.                                                                  |
| **Server Path**  | Optional URL path that becomes the pane's root, such as `/remote.php/dav/files/alice`. Blank means `/`.        |
| **Username**     | Stored in the favorite's nonsecret username field.                                                             |
| **Password**     | Stored in the encrypted secret blob and sent with HTTP Basic authentication on every request.                  |
| **Remote Path**  | Optional folder under the server path to open first. A missing folder falls back to the server path.           |
| **TLS Security** | WebDAVS only. Verifies the server certificate by default; turn it off only for a self-signed server you trust. |

The server path is stored in SQLite (`favorites.webdav_root`) with the rest of the favorite. Spaces
and other characters may be typed plainly or percent-encoded. The password never leaves the main
process. Plain WebDAV sends it unencrypted, so use WebDAVS whenever the server offers HTTPS.

## Protocol

Pallet speaks WebDAV directly over Node's `http` and `https` modules, in
`src/main/services/webdav/`. It parses `PROPFIND` replies with
[`fast-xml-parser`](https://github.com/NaturalIntelligence/fast-xml-parser), ignoring namespace
prefixes, so `D:`, `d:`, and default-namespace replies all work.

| Operation        | Request                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------- |
| List / stat      | `PROPFIND` with `Depth: 1` or `Depth: 0`, asking only for type, size, and modification date |
| Download         | `GET`, with a `Range` header for previews                                                   |
| Upload           | `PUT` with a chunked body                                                                   |
| New folder       | `MKCOL`                                                                                     |
| Rename / replace | `MOVE` with `Overwrite: F` for renames and `Overwrite: T` for staged uploads                |
| Delete           | `DELETE`; the server removes folder contents itself                                         |

Request paths are percent-encoded per segment, and folders get a trailing slash. If a server
redirects a `PROPFIND` for a folder without the slash, Pallet retries once with it. Listing entries
outside the server path are ignored.

## Behavior

- **Browsing** lists each folder with one `PROPFIND`, including sizes and dates. Hidden files follow
  the leading-dot rule used for other remote panes.
- **Rename** refuses to overwrite an existing name. **Delete** sends one `DELETE`, even for folders.
- **Transfers** stage uploads as `.pallet-<id>.pallet-part`. The upload stream finishes only after
  the server answers the `PUT` with a 2xx status, so a quota or permission failure fails the file
  instead of looking like success. Pallet then checks the staged size and `MOVE`s it over the
  destination. Interrupted WebDAV files restart from byte zero. Copied files keep the upload time,
  not the source modification time.
- **Permissions** are read-only in the inspector; `chmod` is not available over WebDAV.
- **Timeouts and drops.** Every request times out after 20 seconds of socket inactivity, and
  transfer streams after 120 seconds, which leaves time for servers that assemble large uploads
  before replying. Network failures pause transfers and reconnect with the usual backoff. Sign-in,
  permission, missing-path, and quota errors (HTTP 401, 403, 404/409, 507) fail directly with a
  message instead of reconnecting.

Not supported: Digest, NTLM, Kerberos, and OAuth sign-in (a server that asks only for one of these
fails with an unsupported sign-in method error); WebDAV locks; preserved modification times; free-space
reporting; and redirects other than the trailing-slash retry.

## Tests

`test-server/webdav.test.ts` runs the client, service, endpoint, and `SessionManager` against an
in-process WebDAV server, and `test-server/webdav-favorite.test.ts` covers favorite storage. Both
are part of `bun run test:offline`.
