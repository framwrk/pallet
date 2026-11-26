# S3 connections

Pallet's Quick Connect supports S3-compatible object storage alongside SFTP, FTP, and explicit FTPS.
One connection is scoped to a single general-purpose bucket plus an optional starting key prefix; it
is not a bucket browser. MinIO is exercised against a disposable local server; AWS S3 uses the same
client and configuration but is only verified when an operator runs the opt-in real-AWS check. Other
S3-compatible services use the same configuration, but are not separately verified.

## Setup fields

| Field                     | Notes                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Protocol**              | S3.                                                                                                                                                                                          |
| **Provider**              | **AWS or custom endpoint**, or a provider preset such as **Backblaze B2**. A preset hides **Endpoint** and **Session Token**, derives the endpoint from **Region**, and relabels the keys.   |
| **Endpoint**              | Optional `http://` or `https://` origin for MinIO, Cloudflare R2, Wasabi, and similar. The scheme may be omitted, in which case `https://` is assumed. Blank uses the AWS regional endpoint. |
| **Region**                | Required for AWS. Optional with a custom endpoint, where blank defaults to `us-east-1`; it is always sent as the request-signing region.                                                     |
| **Bucket**                | One existing general-purpose bucket. Pallet does not list your buckets, create them, or delete them.                                                                                         |
| **Starting Prefix**       | Optional key prefix, stored in the favorite's **Remote Path** and shown as **Prefix**. The pane's `/` is this prefix; blank means the bucket root.                                           |
| **Access Key ID**         | Stored in the favorite's nonsecret username field.                                                                                                                                           |
| **Secret Access Key**     | Stored in the encrypted secret blob.                                                                                                                                                         |
| **Session Token**         | Optional, for temporary credentials. Stored in the same encrypted blob.                                                                                                                      |
| **Path-style addressing** | Defaults on for custom endpoints and off for AWS. Enable or disable it per connection.                                                                                                       |

The endpoint must be an origin: no credentials, query, fragment, or base path. HTTPS uses the
platform trust store with verification always on; there is no insecure-verification switch. When the
scheme is omitted, `https://` is assumed; plain `http` is accepted when the endpoint is specified
with that scheme.

## Provider presets

A preset is a static entry in `src/shared/s3/s3-presets.ts` with an id, a label, an endpoint template,
a region placeholder, and the provider's names for the key fields. It is not a separate client:
connections still use the S3 client described here. The favorite stores the preset id next to the
derived endpoint, and the main process recomputes the endpoint from the region on save, so a preset
favorite cannot point anywhere but its provider. A region must be one DNS label, such as
`us-west-004`.

### Backblaze B2

Choose **Provider → Backblaze B2**, enter the region from the bucket's S3 endpoint (for example
`us-west-004` for `s3.us-west-004.backblazeb2.com`), the bucket, and an application key's **Key ID**
and **Application key**. Path-style addressing defaults on and can still be toggled; B2 accepts both
styles. Changing a saved favorite's provider requires re-entering the secret. Live B2 behavior is
not verified by the automated checks.

- **Checksums.** Newer AWS SDKs add CRC32 checksum headers to uploads by default, which B2 rejects
  with `Unsupported header`. Pallet sets the SDK's request checksum calculation and response
  validation to `WHEN_REQUIRED` for every custom endpoint, B2 included, so uploads and copies carry
  no optional checksum headers. `DeleteObjects` still needs a checksum under that setting, and the
  SDK sends CRC32 rather than `Content-MD5`. Pallet uses `DeleteObjects` for every delete, including
  the source cleanup after a rename, so this is unverified against live B2: if delete or rename fails
  with an unsupported-header error, this is the likely cause, and a failed rename leaves both the
  source and the copy.
- **Part sizes.** B2's minimum part size is 5 MB, except for the last part, and its maximum is 5 GB.
  Pallet uploads in 8 MiB parts and copies objects over 5,000,000,000 bytes with `UploadPartCopy`
  parts of at least 5 MiB, so both are inside B2's limits. The single-copy cutoff uses decimal
  gigabytes for every provider because B2 documents its copy limit as 5 GB.
- **Copy and rename.** File and folder rename use plain `CopyObject` (or `UploadPartCopy` over 5 GB)
  followed by `DeleteObjects`, without conditional or metadata-replacing headers; B2 supports both.
  B2 buckets keep file versions, so an S3 delete only hides the old version. Renamed sources, deleted
  files, and Pallet's `.pallet-<id>.pallet-part` staging keys stay billed as hidden versions until a
  lifecycle rule removes them. Set the bucket's lifecycle to **Keep only the last version** (or a
  rule with `daysFromHidingToDeleting`) if that matters.
- **Bucket-scoped keys.** Pallet never lists buckets, so a key restricted to one bucket works. A key
  restricted to a file-name prefix only lists inside that prefix: set **Starting Prefix** to the key's
  prefix or a folder under it, or the connection test fails with access denied. The key needs the
  `listFiles`, `readFiles`, `writeFiles`, and `deleteFiles` capabilities.
- **Credentials.** B2 application keys are long-lived, so the preset has no session token field.

## Required IAM permissions

Pallet only needs access to the configured bucket and prefix. Bucket-level `s3:ListBucket` with a
prefix condition is enough; `s3:ListAllMyBuckets` is never called. The implementation lists and
reads objects, uploads, copies, deletes, and aborts its own multipart uploads:

| Operation                     | Permission                                                         |
| ----------------------------- | ------------------------------------------------------------------ |
| List objects and folder sizes | `s3:ListBucket`                                                    |
| Read, preview, download       | `s3:GetObject`                                                     |
| Upload, create folder marker  | `s3:PutObject`                                                     |
| Delete objects and folders    | `s3:DeleteObject` (also covers `DeleteObjects`)                    |
| Copy an object                | `s3:GetObject` on the source and `s3:PutObject` on the destination |
| Multipart copy and upload     | `s3:PutObject` plus `s3:AbortMultipartUpload`                      |

`HeadObject` is authorized by `s3:GetObject`. Minimal policy example for a connection whose starting
prefix is `logs/`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListConnectionPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::example-bucket",
      "Condition": {
        "StringLike": { "s3:prefix": ["", "logs", "logs/*"] }
      }
    },
    {
      "Sid": "ReadWriteObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::example-bucket/logs/*"
    },
    {
      "Sid": "AbortStagingUploads",
      "Effect": "Allow",
      "Action": "s3:AbortMultipartUpload",
      "Resource": "arn:aws:s3:::example-bucket/logs/*"
    }
  ]
}
```

A connection at the bucket root uses `arn:aws:s3:::example-bucket/*` for object actions and needs
`"*"` (or no condition) in the prefix condition. Bucket administration, ACLs, policies, and CORS are
not used.

## Paths

Pane paths are absolute and POSIX-like. `/` is the configured prefix, or the bucket root when no
prefix is set. Paths cannot contain `.` or `..` segments, empty segments, control characters, or a
trailing slash, and Pallet never operates outside the configured prefix.

S3 has no real directories. A folder is a key prefix, and creating one writes an empty marker object
ending in `/`. If a bucket contains both an object and a folder with the same visible name in one
place, Pallet reports the ambiguity and asks you to rename one outside Pallet instead of silently
merging them. The connection root cannot be renamed or deleted.

## Secrets and favorites

Each favorite has one encrypted, Keychain-backed secret file with mode `0600`, written through
Electron's `safeStorage`. It contains a versioned JSON payload with the secret access key and optional
session token. For S3 settings, SQLite stores only the endpoint origin, region, bucket, addressing
style, provider preset, prefix, and access key ID; the renderer receives favorites with `secretStored` and never the
secret itself.

When editing a favorite:

- Leaving the secret field blank keeps the existing secret.
- Entering a new access key and secret without a session token replaces the stored secret with
  long-term credentials.
- Replacing only the session token requires re-entering the access key and secret as well, so the
  stored payload always describes one consistent credential set.

## Transfers, staging, and cost

Uploads are written to a unique staging key named `.pallet-<id>.pallet-part` in the destination
folder, then copied server-side to the final key. An existing final object is replaced only after the
staged upload and the server-side copy succeed, so a failed replacement leaves it intact. Deleting the
staging key or aborting an upload is best effort.

Interrupted files that involve S3 restart from byte zero; Pallet does not persist multipart upload
IDs or resume partial objects. Objects larger than 5,000,000,000 bytes are copied server-side with
multipart `UploadPartCopy`.

A crash or unreachable endpoint can leave staging objects and incomplete multipart uploads behind,
which may incur storage cost. Pallet never changes a bucket's lifecycle configuration. If that risk
matters for a bucket, add your own lifecycle rule that expires the `.pallet-` staging prefix and
aborts incomplete multipart uploads.

Optional **Verify copied files with SHA-256** rereads the entire source and the staged destination
before replacement. It is off by default and adds full-object read traffic.

## Rename and delete

A single object rename is a copy followed by a delete; renaming refuses to overwrite an existing
destination. A folder rename snapshots every key under the folder, preflights every destination,
copies all objects, and only then deletes the sources. **Folder rename is not atomic.** If a copy
fails, the sources are left intact and the error reports how many objects were copied; objects
already copied remain at the destination until you review and remove them.

Delete is recursive for folders, batched through `DeleteObjects` in groups of 1000, and inspects the
per-key results. A delete that partially fails reports the affected keys instead of treating the
request as successful. Deletes are permanent; there is no S3 Trash.

## Sizing, previews, and editing

Folder sizes use a non-delimited, paginated listing of the prefix and sum object sizes; folder
markers add no bytes. Previews use bounded `Range` reads, so Pallet downloads only the requested
prefix of a large object. External editing downloads the object, watches for saved changes, and
re-uploads through the same staging and replacement path.

S3 has no POSIX modes, cannot preserve a source modification time, and has no symlinks or free-space
value. Pane entries show synthetic permissions (`0755` for folders, `0644` for files), permissions
cannot be changed, and the status line does not show available space. ETags are opaque version tokens
for source-change checks, not content hashes.

## Recovery and errors

Only connectivity failures (DNS, refused/reset connections, timeouts, 5xx responses) pause work and
trigger the normal reconnect and auto-resume flow. Access denied, signature mismatch, expired or
invalid session token, missing bucket, invalid region, and invalid endpoint fail directly with an
actionable error instead of retrying. An expired session token requires editing the favorite and
re-entering credentials; Pallet does not refresh tokens or use a credential provider chain.

## Not supported in this release

- Default credential chains, environment variables, shared AWS config, IAM roles, SSO, and token
  refresh. Credentials are always supplied explicitly with the connection.
- Listing all buckets, creating or deleting buckets, or bucket administration; access points; S3
  Express; Requester Pays.
- Anonymous access, custom certificate authorities, endpoint base paths, SSE-C, and ACL, policy, or
  CORS editing.
- Version browsing, Object Lock, Glacier storage classes, and POSIX semantics such as chmod, mtime,
  symlinks, and free space.
- Atomic folder rename, durable transfer recovery across app restarts, and resuming interrupted
  multipart uploads.

## Verification status

MinIO, AWS S3, and packaged-app checks are opt-in and are not part of the default CI suite. The
default offline, UI, and release checks do not exercise an S3 endpoint.
