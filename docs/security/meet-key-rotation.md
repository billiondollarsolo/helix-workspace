# Retired Jitsi keys and Git-history purge

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

The repository no longer supplies Jitsi runtime configuration or keys. Local
Compose creates service-owned config volumes; production must provision fresh
certificates from its secret manager and mount them at runtime. Never copy a
Compose-generated config volume into production.

## Coordinated rotation and purge

- [ ] Inventory every environment, backup, registry artifact, and secret store
      that may contain one of the retired fingerprints.
- [ ] Generate unrelated replacement key pairs in the production secret
      manager, deploy them, restart every Jitsi component, and verify no live TLS or
      XMPP endpoint presents a retired fingerprint.
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
