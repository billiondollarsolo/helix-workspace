# Meet secret rotation and retired Jitsi keys

## LiveKit secrets

Meet runs on LiveKit. Its secrets live in the production secrets directory:

| File                     | Used by                              | Effect of rotating                                              |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------- |
| `livekit_api_secret`     | `livekit`, `helix`, `egress`         | Running calls and recordings end; people rejoin with new tokens |
| `livekit_redis_password` | `livekit-redis`, `livekit`, `egress` | Running recordings end                                          |
| `meet_capture_secret`    | `helix` and capture services         | Capture and recording requests with the old value are refused   |
| `turn_cert`, `turn_key`  | `livekit`                            | TURN over TLS presents the new certificate                      |

To rotate, write a new random value (at least 32 characters) into the file, for example
`openssl rand -base64 48 > "$HELIX_PRODUCTION_SECRETS_DIR/livekit_api_secret"`, keep mode 0644, then
recreate the services that read it:

```sh
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.production.yml -f docker-compose.meet.yml \
  up -d --force-recreate livekit egress helix
```

For `livekit_redis_password`, recreate `livekit-redis livekit egress`.

Rotate `livekit_api_secret` after any suspected exposure: whoever holds it can mint tokens for any room.
Replace `turn_cert` and `turn_key` before the certificate expires and recreate `livekit`.

## Retired Jitsi keys and Git-history purge

Jitsi has been removed from Helix. The steps below only clean up keys it left in Git history.

Five Jitsi development private keys were committed under `infra/meet/config`.
Treat all five as compromised even if no production deployment is known. Their
public-key SHA-256 fingerprints are:

```text
35fe1748542bf40293365fd8996d9581a3763d9ee8d49e0ab160284916a79a75
df07dd2c7d66fc3c1e1a2f075f8e099c16baf29381a5954b0853793a784b4654
2bf3129265ba1889258daa3c3f1c91ed0a1347fd525630fbe6ccdfdbcccd2be7
90dd8cb36eb6e418ed187aa75e96f4aa21b949371cae972bbdf7e9aa36f0190f
5385e647cd15c3d1c02b46b6d002606fb079a849ca6ec2d01f095e2671f3b2ce
```

The repository no longer contains any Jitsi configuration or keys.

### Coordinated rotation and purge

- [ ] Inventory every environment, backup, registry artifact, and secret store
      that may contain one of the retired fingerprints.
- [ ] Remove any remaining Jitsi deployment and verify no live TLS or XMPP
      endpoint presents a retired fingerprint.
- [ ] Revoke or remove the old certificate material and its trust entries from
      every environment. Record the change and deployment IDs in the incident log.
- [ ] Freeze merges and ask all contributors to push work or create patches.
- [ ] Create a fresh mirror: `git clone --mirror <repository-url> helix-workspace-purge.git`.
- [ ] From the mirror, run
      `infra/scripts/purge-meet-key-history.sh --backup-bundle /secure/offline/helix-before-key-purge.bundle --execute`
      using a trusted copy of the script.
- [ ] Review rewritten refs, then force-push all branches and tags from the
      mirror during the announced maintenance window.
- [ ] Delete server-side pull-request refs/caches and any release artifacts that
      embed the keys; request hosting-provider cache removal where applicable.
- [ ] Invalidate every pre-purge clone and CI cache. Contributors must delete
      old clones and clone again—merging an old branch can restore the secret.
- [ ] Run `pnpm security:scan-history` in a fresh full clone. CI runs the same
      check and rejects shallow or contaminated history.
- [ ] Remove the encrypted offline bundle after the incident-retention period.

Do not mark SEC-22 complete until the production inventory, rotation, force
push, clone invalidation, and clean full-history scan are all recorded.
