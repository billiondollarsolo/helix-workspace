# Drive S3 API

Helix Drive accepts S3 commands. Standard S3 clients (the AWS CLI, rclone,
boto3, the AWS SDKs, and other SigV4 clients) can list, upload, download, copy,
and delete Drive files with an S3 access key.

The gateway is not a pass-through to the object store behind Drive. Each S3
request is translated into the same Drive store operations that the REST API,
CLI, MCP tools, and WebDAV use. So every request keeps Drive's guarantees:

- **Tenant isolation and actor-scoped authorization.** A key acts as its user,
  limited to the key's Drive scopes. Drive folder and file ACLs apply exactly as
  they do in the web app.
- **Malware scanning and DLP.** Every upload goes through the Drive upload
  pipeline, and so does every completed multipart upload and every copy. A
  file that is still waiting for its scan, or that was quarantined, cannot be
  downloaded.
- **Retention and trash.** Deleting an object moves it to Drive trash, and the
  org's trash retention policy applies. Overwriting a key adds a Drive version.
- **Audit trail.** Every S3 operation, allowed or denied, writes an audit
  record (`drive.s3.<operation>`). Drive also keeps its own upload, trash, and
  version activity.
- **Quotas.** Uploads count against the org's storage accounting. By default
  the org has no storage limit.

Raw keys in the backing bucket (staged uploads, versions, quarantine, mail
evidence) are never reachable through the gateway.

## Turning it on or off

The org setting `drive_s3_api` controls the gateway, and it is **on by
default**. Admins can change it in **Admin → Tenant settings → Drive → Drive
S3 API**. While the setting is off, every request fails with `AccessDenied` and
a message that says the S3 API is turned off for the organization.

## Access keys

Users create their own keys in **Settings → S3 access keys**. The CLI can list
and revoke them:

```sh
helix drive s3-keys list
helix drive s3-keys revoke --key-id <key id>
```

- The access key ID looks like `HLXABCDEFGHIJKLMNOPQ`. The secret access key is
  shown **once**, in the response that creates the key. The stored
  pending-action result and the idempotency cache keep only a redacted
  placeholder, so the secret cannot be fetched again.
- Scopes: `drive.read` (list, download, head), `drive.write` (upload,
  multipart), and `drive.delete` (delete). `CopyObject` reads its source, so it
  needs both `drive.read` and `drive.write`. A key can never do more than its
  user can do.
- Only a signed-in person can create a key, from the web app. Delegated OAuth
  tokens (including the CLI's), API keys, and agent credentials are refused, so
  a delegated grant cannot mint a key that outlives the grant.
- SigV4 needs the secret itself to verify a signature, so Helix cannot store it
  as a one-way hash. The secret is sealed with the tenant envelope cipher
  (AES-256-GCM, with a per-tenant key derived from `HELIX_SECRET_ENCRYPTION_KEY`)
  and decrypted only to check a signature.
- Revoking a key, disabling its user, or offboarding the user stops the key
  immediately.
- Admins with `admin.users` can list every key in the org with
  `helix drive s3-keys list --all` (tool `drive.s3-keys.list` with
  `allActors: true`), and they can revoke any key.
- The tools behind these commands are `drive.s3-keys.create`,
  `drive.s3-keys.list`, and `drive.s3-keys.revoke`. You can also call them
  through the REST tool API and MCP. Creating and revoking a key needs
  confirmation, like app passwords.

## Endpoint and addressing

| Setting      | Value                                           |
| ------------ | ----------------------------------------------- |
| Endpoint URL | `https://<your Helix host>/v1/s3`               |
| Addressing   | Path style (`/v1/s3/<bucket>/<key>`)            |
| Region       | `us-east-1` (any region in the signature works) |
| Signature    | AWS Signature Version 4 only                    |
| Transport    | HTTPS is required in production                 |

Virtual-hosted-style addressing (`<bucket>.host`) is not supported. Configure
clients for path style.

The gateway also verifies signatures computed over the bucket-relative path
(`/<bucket>/<key>`). This lets you run it on a dedicated host, for example
`s3.helix.example.com`, which some clients need because they reject an
endpoint URL that has a path (the MinIO client is one). To do this, add a
reverse-proxy site that rewrites the path to the gateway:

```caddyfile
s3.{$HELIX_DOMAIN} {
	rewrite * /v1/s3{uri}
	reverse_proxy {$HELIX_UPSTREAM}
}
```

In multi-tenant (SaaS) mode, Helix resolves the tenant from the host name. So
the dedicated S3 host must also resolve to the org: use the org's own host, or
send the tenant header that your deployment's proxy already asserts.

## Buckets

Buckets are fixed, DNS-safe views of the Drive roots that the key's user can
access:

| Bucket                       | Contents                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `my-drive`                   | The user's My Drive: the files and folders they own, and everything inside those folders.         |
| `shared-with-me`             | Items shared with the user. The root is read-only; folders shared with edit access accept writes. |
| `<org-slug>--my-drive`       | A tenant-qualified alias of `my-drive`. A key from any other org gets `AccessDenied`.             |
| `<org-slug>--shared-with-me` | A tenant-qualified alias of `shared-with-me`.                                                     |

Use the tenant-qualified alias when one client is configured for several Helix
orgs. A misconfigured key then fails loudly instead of writing to the wrong
org. Helix Drive has no shared drives, so there are no other buckets.
`CreateBucket` returns `BucketAlreadyOwnedByYou` for these names.

## Keys and folders

- An object key is a `/`-separated Drive path. `reports/2026/q3.pdf` is the
  file `q3.pdf` in the folder `reports/2026`.
- `PutObject` creates any missing folders, like `mkdir -p`. The folders it
  creates are ordinary Drive folders.
- A key that ends in `/` with an empty body (a "directory marker") creates that
  folder. `HEAD` on `folder/` succeeds when the folder exists. `DELETE` on
  `folder/` moves the folder to trash only if it is empty.
- Key segments cannot be empty, `.`, `..`, longer than 255 characters, or
  contain control characters. A key can be at most 1024 bytes long.
- Drive allows two items with the same name in a folder. Through the S3 API, a
  key resolves to the first match in Drive's name order.
- `ListObjectsV2` and `ListObjects` return keys in S3's UTF-8 binary order.
  With `delimiter=/`, folders appear as `CommonPrefixes`, including empty
  folders. Without a delimiter, the listing walks the folder tree. Empty
  folders do not appear as keys.

## Supported operations

| Area      | Operations                                                                                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service   | ListBuckets                                                                                                                                                                                                                                                                                                                         |
| Bucket    | HeadBucket, GetBucketLocation, GetBucketVersioning (always unversioned), ListObjectsV2 (`prefix`, `delimiter`, `continuation-token`, `max-keys` up to 1000, `start-after`, `encoding-type=url`), ListObjects v1 (`marker`), ListMultipartUploads, DeleteObjects (up to 1000 keys), CreateBucket (returns `BucketAlreadyOwnedByYou`) |
| Object    | GetObject (single `Range`, `If-Match`, `If-None-Match`, `If-Range`), HeadObject, PutObject (`x-amz-meta-*` up to 2 KB), CopyObject (`x-amz-metadata-directive`, `x-amz-copy-source-if-match`, `x-amz-copy-source-if-none-match`), DeleteObject                                                                                      |
| Multipart | CreateMultipartUpload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload, ListParts                                                                                                                                                                                                                                         |

Any other operation or subresource (ACLs, policies, tagging, lifecycle,
versions, object lock, UploadPartCopy, SelectObjectContent, and so on) returns
`501 NotImplemented` as S3 XML.

### Authentication

- SigV4 in the `Authorization` header or in a presigned query string. A
  presigned URL can live at most 7 days.
- The payload hash can be a signed SHA-256, `UNSIGNED-PAYLOAD`,
  `STREAMING-AWS4-HMAC-SHA256-PAYLOAD` (aws-chunked with chunk signatures),
  `STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER`, or
  `STREAMING-UNSIGNED-PAYLOAD-TRAILER`. The gateway verifies every chunk
  signature and every trailer signature.
- `Content-MD5` is verified. So are the `x-amz-checksum-crc32`, `-crc32c`,
  `-sha1`, and `-sha256` checksums, whether they arrive as headers or as
  trailers. `x-amz-checksum-crc64nvme` is accepted but not verified.
- The client's clock must be within **±15 minutes** of the server's clock.
  Otherwise the request fails with `RequestTimeTooSkewed`.
- Every `x-amz-*` header must be signed, as in S3. For header auth, the
  exceptions are `x-amz-content-sha256` and `x-amz-date`, which the string to
  sign covers anyway. A request with an unsigned `x-amz-copy-source`,
  `x-amz-meta-*`, or `x-amz-metadata-directive` is refused with `AccessDenied`,
  so the holder of a presigned PUT URL cannot turn it into a copy or inject
  metadata. On a presigned request, an unsigned `Content-Type` or `Content-MD5`
  is ignored: the object is stored as `application/octet-stream`.
- Signature Version 2 is rejected. The AWS CLI v1 `aws s3 presign` command
  signs with SigV2 by default. Run
  `aws configure set default.s3.signature_version s3v4` to make it use SigV4.
- Each client IP gets 30 failed signatures per minute. Each key gets 3,000
  requests per minute. After that, requests fail with `SlowDown` and a
  `Retry-After` header.

### ETags

- For a single-part upload, the ETag is the content MD5, as in S3.
- For a multipart upload, the ETag follows S3's convention:
  `md5(concat(part MD5s))-<part count>`.
- When a file changes through another Drive channel (the web app, WebDAV, or
  REST), the S3 ETag becomes a stable value derived from the file's SHA-256,
  with a `-1` suffix. Clients treat that value as opaque and do not compare it
  with a local MD5.
- `Last-Modified` and `Content-Type` come from Drive metadata. Downloads are
  served with Drive's safe content headers, so active types such as HTML and
  SVG are sent as `application/octet-stream`.

### Malware scanning, DLP, and errors

| Situation                                                                | S3 error                                                                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Upload rejected by the malware scan                                      | `403 ObjectQuarantined`                                                                                                       |
| Download of a quarantined file                                           | `403 ObjectQuarantined`                                                                                                       |
| Download of a file still waiting for its scan                            | `409 ObjectScanPending` (retry after the scan completes)                                                                      |
| Scanner unavailable, or an earlier version still awaits its scan         | `503 ServiceUnavailable` with `Retry-After`. Nothing is stored and staged multipart parts are kept, so retry the same request |
| DLP blocks the download, or the file is a recording with export disabled | `403 AccessDenied`                                                                                                            |
| Key lacks the scope the operation needs                                  | `403 AccessDenied`, naming the missing scope                                                                                  |
| `drive_s3_api` is off                                                    | `403 AccessDenied`, saying the S3 API is turned off                                                                           |
| Storage quota exceeded                                                   | `403 QuotaExceeded`                                                                                                           |

## Limits

- A single `PutObject`, a `CopyObject`, and a completed multipart object are
  each limited to the Drive antivirus size limit
  (`HELIX_DRIVE_AV_MAX_FILE_BYTES`). The gateway reads and scans the whole
  object before it commits, as Drive's REST upload does. Behind the bundled
  Caddy proxy, each request body is limited to 64 MiB. Larger files must use
  multipart upload: the AWS CLI and rclone switch to multipart at 8 MiB and
  5 MiB.
- Every multipart part except the last must be at least 5 MiB, as in S3.
  Parts are staged in the tenant's object store under a private prefix that
  Drive never serves. The parts staged for one upload can never add up to more
  than the object size limit (`EntityTooLarge`). Each user can have at most
  100 unfinished uploads (`SlowDown`). An unfinished upload expires after 7
  days, and a leader-elected worker (`drive-s3-multipart-cleanup-worker`)
  deletes expired uploads and their staged bytes every 15 minutes. Staged
  parts do not count toward storage accounting until the upload completes.
- Object version IDs are not exposed. Drive keeps the version history, which
  users can browse in the web app.

## Client configuration

### AWS CLI

```sh
aws configure --profile helix          # access key ID, secret, region us-east-1
aws configure set profile.helix.s3.addressing_style path
aws configure set profile.helix.s3.signature_version s3v4
ENDPOINT=https://helix.example.com/v1/s3

aws --profile helix --endpoint-url $ENDPOINT s3 ls s3://my-drive/
aws --profile helix --endpoint-url $ENDPOINT s3 cp ./report.pdf s3://my-drive/reports/report.pdf
aws --profile helix --endpoint-url $ENDPOINT s3 sync ./photos s3://my-drive/photos
aws --profile helix --endpoint-url $ENDPOINT s3 rm --recursive s3://my-drive/tmp/
aws --profile helix --endpoint-url $ENDPOINT s3 presign s3://my-drive/reports/report.pdf --expires-in 3600
```

AWS CLI v2 uploads with aws-chunked trailing checksums by default. The gateway
supports that encoding, so no extra setting is needed.

### rclone

```ini
[helix]
type = s3
provider = Other
access_key_id = HLXABCDEFGHIJKLMNOPQ
secret_access_key = <secret>
endpoint = https://helix.example.com/v1/s3
region = us-east-1
force_path_style = true
```

```sh
rclone lsd helix:my-drive
rclone sync ./photos helix:my-drive/photos --progress
```

rclone stores file modification times in `x-amz-meta-mtime`, and the gateway
keeps that metadata.

### boto3

```python
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url="https://helix.example.com/v1/s3",
    aws_access_key_id="HLXABCDEFGHIJKLMNOPQ",
    aws_secret_access_key="<secret>",
    region_name="us-east-1",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)
s3.upload_file("report.pdf", "my-drive", "reports/report.pdf")
for item in s3.list_objects_v2(Bucket="my-drive", Prefix="reports/").get("Contents", []):
    print(item["Key"], item["Size"])
url = s3.generate_presigned_url(
    "get_object", Params={"Bucket": "my-drive", "Key": "reports/report.pdf"}, ExpiresIn=600
)
```

### AWS SDK for JavaScript v3

```ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "https://helix.example.com/v1/s3",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "HLXABCDEFGHIJKLMNOPQ", secretAccessKey: "<secret>" },
});
await s3.send(new PutObjectCommand({ Bucket: "my-drive", Key: "notes/today.md", Body: "# Today" }));
```

## Operations notes

- Implementation: `apps/helix/src/platform/drive/s3/`. Routes are registered
  in `apps/helix/src/bootstrap/drive-routes.ts`. Keys and multipart sessions
  are stored in the tables from migration `0204_drive_s3_gateway.sql`.
- The gateway runs in its own Fastify scope. It returns S3 XML errors and
  never the JSON API error envelope. Its routes accept raw bodies of any
  content type, without JSON parsing.
- The bundled Caddyfile allows bodies up to 64 MiB under `/v1/s3/*`, and it
  does not compress S3 responses.

### Cloudflare and other reverse proxies

For a proxied workspace, add a Cache Rule matching its hostname and URI paths beginning
with `/v1/`, with **Cache eligibility: Bypass cache**. Cloudflare can turn a cache-eligible
HEAD request into GET before forwarding it, invalidating the AWS signature. Do not weaken
signature verification to accommodate this. Preserve the Host, path, query, method and signed
headers, and disable response transformations for S3 and DAV. See
[Cloudflare HEAD behavior](https://developers.cloudflare.com/cache/concepts/cache-behavior/).

Proxy body limits apply per request, including UploadPart. Multipart uploads can keep each
request below the proxy cap, but the completed object must still fit Helix's configured
antivirus file-size limit. Infected uploads are quarantined; scanner outages never make an
unscanned object downloadable.
