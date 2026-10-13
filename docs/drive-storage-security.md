# Drive storage security operations

Drive object encryption and database-volume encryption are separate controls. S3-compatible
uploads require signed SSE-S3 (`AES256`) or tenant-specific SSE-KMS headers. When a tenant policy
is configured, finalize performs a provider `HEAD` request and refuses to persist the version if
the reported algorithm or KMS key differs.

## Deployment evidence

Before enabling Business production traffic, retain:

- an upload response and post-finalize provider metadata showing the expected SSE algorithm and,
  for KMS, the tenant key ARN;
- bucket policy evidence denying unencrypted writes and writes with an unexpected KMS key;
- a cross-tenant negative test showing tenant A cannot cause tenant B's key to be signed;
- separate PostgreSQL volume/TDE evidence. Object-store SSE does not encrypt PostgreSQL metadata,
  audit rows, filenames, or search projections.

Never record access keys, raw share tokens, share passwords, or object contents in evidence.

## Sharing notices and access requests

Sharing notifies each person newly given access in Helix. The sharer chooses whether they are
also emailed; that email is sent as the sharer through their own mailbox and is recorded in
their Sent mail. A failure to queue it never undoes the share.

A person who cannot open an item may ask its owner for access. They cannot read the item, so the
request and the answer go through two database functions, `helix_drive_request_access` and
`helix_drive_decide_access_request`, which the application role may execute but whose table it
may only read:

- a request can be made only as the signed-in person, for an item that exists, that they do not
  own and cannot already open;
- only the item's owner at the time of the answer can approve or decline, so a request does not
  outlive a change of owner or a deletion;
- approving grants view access and nothing more; the owner can change it afterwards in the Share
  dialog;
- a person sees only requests they made or requests for items they own.

Asking again while a request is open notifies nobody, so a person cannot use requests to flood
an owner. Hiding an item from Shared with me (`drive_hidden_shares`) is a
per-person list preference and changes no access.

## KMS rotation

1. Create or select the replacement key and grant only the tenant storage principal access.
2. Update the tenant storage encryption configuration. The resolver cache key includes encryption
   configuration, so the next resolution creates a new client instead of reusing the old policy.
3. Upload a canary and retain matching `HEAD` evidence before migrating old objects.
4. Re-encrypt existing objects with a copy operation carrying the replacement KMS headers.
5. Verify hashes, sizes, versions, and restore metadata before disabling the old key.

Losing or permanently disabling a KMS key makes objects encrypted under it unrecoverable. Keep the
old key available until backup restore and historical-version verification have completed.

## Lifecycle

Trash retention defaults to 30 days. Hard delete is blocked until retention expires and while a
legal hold, active share/link, or pending scan job exists. Orphan collection supports dry-run,
uses bounded batches, aborts stale multipart uploads, and removes zero-reference tenant blobs.
Operators should schedule collection outside the web process and alert on repeated failures.
