# Live S3 check

`test:s3` exercises the real `@aws-sdk/client-s3` path against a disposable
MinIO. It is opt-in, creates a unique `pallet-s3-check-*` prefix, and removes
only that prefix when it finishes.

It is intentionally outside `bun test test-server`, so Docker is never needed
for the offline suite.

## 1. Start MinIO

```sh
docker compose --profile s3 up -d minio
```

MinIO listens on `http://127.0.0.1:19000`. The compose defaults are
`pallet` / `pallet-secret`; override them with
`PALLET_S3_TEST_ACCESS_KEY` and `PALLET_S3_TEST_SECRET_KEY` (and
`PALLET_S3_TEST_PORT`) in your shell or a local `.env`.

The service uses the Chainguard MinIO image pinned by digest, runs as a
non-root user, and keeps `/data` on a tmpfs, so its data disappears with the
container. The official `minio/minio` repositories no longer publish pullable
images.

## 2. Create a bucket

The check creates the bucket if it does not exist, so this step is optional.
To create it explicitly:

```sh
bun -e '
  import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
  const client = new S3Client({
    region: "us-east-1",
    endpoint: "http://127.0.0.1:19000",
    forcePathStyle: true,
    credentials: { accessKeyId: "pallet", secretAccessKey: "pallet-secret" },
  });
  await client.send(new CreateBucketCommand({ Bucket: "pallet-s3-test" }));
'
```

## 3. Run the check

```sh
PALLET_S3_TEST_ENDPOINT=http://127.0.0.1:19000 \
PALLET_S3_TEST_ACCESS_KEY=pallet \
PALLET_S3_TEST_SECRET_KEY=pallet-secret \
PALLET_S3_TEST_BUCKET=pallet-s3-test \
bun run test:s3
```

Set `PALLET_S3_TEST_REGION` if the endpoint needs a region other than
`us-east-1`.

The script uploads and downloads through `S3Endpoint`, tests ranged reads,
copies and renames objects, lists more than 1000 keys to force pagination,
totals folder bytes, deletes files and a prefix, and fails fast with a clear
message when any of the four required variables is missing.

## 4. Stop MinIO

```sh
docker compose --profile s3 down
```

The tmpfs data is discarded with the container. Never point these variables at a
production bucket: the check writes objects and deletes its own prefix.
