# Secret, certificate, or key rotation

Owner: security and platform on-call. Use for planned rotation, imminent expiry,
or suspected compromise.

## Detection

- Confirm expiry/credential alerts or the approved rotation schedule.
- Identify the credential alias, consumers, trust boundary, and current version
  without recording secret values.
- For suspected compromise, determine the earliest possible exposure time and
  affected permissions.

## Containment

- Revoke or disable a compromised credential where safe; otherwise restrict its
  permissions and consumers until dual-version rollout is ready.
- Freeze unrelated deploys and preserve access/audit evidence.
- Use only the deployment secret manager and approved encrypted channels.

## Diagnosis

- Inventory issuers, consumers, replicas, caches, trust stores, automation, and
  expiry/rotation dependencies.
- Check whether the credential signs, encrypts, authenticates, or decrypts
  retained data; this determines overlap and rollback requirements.
- Never print, diff, commit, or paste the secret/key material.

## Recovery

- Create the new version in the secret manager with least privilege.
- Roll out trust/verification first, then producers, then consumers; keep
  bounded overlap where protocol and compromise status permit.
- Re-encrypt or re-sign retained data when required, then revoke the old
  version and invalidate sessions/caches.

## Verification

- Confirm all consumers report the new version/expiry and authentication,
  signing, encryption/decryption, and readiness checks pass.
- Verify old-version use is zero and revoked credentials fail controlled tests.
- Confirm rotation actions and access are audited.

## Rollback

- Roll consumers back to the still-valid prior version only for a planned,
  non-compromise rotation.
- Never restore a compromised credential; issue another clean version and keep
  the compromised version revoked.

## Post-incident evidence

- Record credential aliases and version IDs, issuer evidence, consumer rollout,
  validation results, revocation time, access review, approvals, and follow-ups.
- Exclude all private keys, certificates containing unnecessary identity data,
  passwords, and tokens.
