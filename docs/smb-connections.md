# SMB connections

Pallet's Quick Connect supports SMB file shares alongside SFTP, FTP, explicit FTPS, and S3. One
connection is scoped to a single share on one server; the pane's `/` is the share root. Samba 4.21
is exercised against a disposable local server in both its default configuration and with signing
and encryption required. Windows and NAS servers use the same protocol but are not separately
verified.

## Setup fields

| Field           | Notes                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **Protocol**    | SMB.                                                                                           |
| **Server**      | Hostname or IP. Do not include `smb://`, slashes, or the share.                                |
| **Port**        | 445 by default. NetBIOS over port 139 is not supported.                                        |
| **Share**       | The share name only, such as `Public`. Leading and trailing slashes are trimmed.               |
| **Domain**      | Optional NTLM domain or workgroup. Blank works for local and workgroup accounts.               |
| **Username**    | Stored in the favorite's nonsecret username field.                                             |
| **Password**    | Stored in the encrypted secret blob.                                                           |
| **Remote Path** | Optional folder inside the share to open first. A missing folder falls back to the share root. |

The share and domain are stored in SQLite with the rest of the favorite. The password never leaves
the main process.

## Protocol

Pallet uses [`smb3-client`](https://github.com/euricojardim/smb3-client), a pure TypeScript SMB
client, bundled into the main process:

- Dialects SMB 2.1, 3.0, 3.0.2, and 3.1.1, with SHA-512 pre-authentication integrity on 3.1.1.
- NTLMv2 inside SPNEGO. Servers that only allow Kerberos, such as some Active Directory file servers
  with NTLM disabled, refuse the sign-in.
- Message signing (HMAC-SHA256 or AES-CMAC) and encryption whenever the server offers or requires
  them. Electron's TLS library lacks AES-CCM, so encryption works with AES-GCM servers (SMB 3.1.1)
  but fails on servers that require encryption over SMB 3.0 or 3.0.2, such as Windows 8 and Windows
  Server 2012.

`patches/smb3-client@0.2.0.patch`, applied by `bun install`, fixes library issues found while
testing against Samba:

| Change                                           | Why                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Repeat the `*` pattern on every directory query  | Samba rejects an empty pattern on follow-up queries, so every listing failed.               |
| Count a credit for NEGOTIATE                     | The client believed it held one credit more than granted, and Samba dropped the connection. |
| Return size and modification time from `readdir` | Listings would otherwise need one extra request per entry.                                  |
| `rename(from, to, { replace: true })`            | Staged uploads replace the destination with one server rename.                              |
| Pass close errors to the write stream            | A failed close otherwise looked like a successful upload.                                   |

smb3-client publishes ES modules only, so `electron.vite.config.ts` bundles it into the main
process instead of leaving it for `require()`.

## Behavior

- **Browsing** lists each folder with one directory query, including sizes and dates. Hidden files
  follow the leading-dot rule used for other remote panes.
- **Rename** refuses to overwrite an existing name. **Delete** walks folders and removes their
  contents first.
- **Transfers** stage uploads as `.pallet-<id>.pallet-part`, check the staged size, then rename over
  the destination. Interrupted SMB files restart from byte zero. Copied files keep the upload time,
  not the source modification time.
- **Permissions** are read-only in the inspector; `chmod` is not available over SMB.
- **Connection drops** pause transfers and reconnect with the usual backoff. Pallet adds its own
  20-second request timeout, because the library has none. Sign-in, share, and permission errors fail
  directly with a message instead of reconnecting.

Not supported: SMB 1, guest or anonymous access, Kerberos, DFS referrals, browsing the server's list
of shares, file locks, and opening more than one share per connection.

## Live check

The Samba check is opt-in and not part of `bun run test:offline`. See
[test-smb/README.md](../test-smb/README.md).
