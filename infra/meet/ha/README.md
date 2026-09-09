# Helix Meet HA media plane

This profile deploys three independent regional Jitsi shards behind the signed
`jitsi-scaler` room router. Each shard starts with three JVBs spread across
three zones, scales to nine, enforces 80 participants per bridge, and reserves
one bridge of N-1 headroom: the declared one-loss capacity is 160 concurrent
participants per regional shard. HAProxy synchronizes only room affinity; no
client-IP session affinity is used.

The exact upstream chart is vendored and checksum locked. Every runtime image
is digest locked. Because the upstream Jitsi images are not signed, production
must mirror the seven locked images into an owned registry and sign them with
the release key. `deploy.sh verify` verifies the signed upstream chart and each
mirrored image before any cluster mutation.

## Prerequisites

- Kubernetes 1.28+ with at least three zones in each configured region and a
  working metrics-server for the CPU HPA.
- Helm 3.16.2 (the repository release workflow uses the same version), kubectl,
  Cosign, ingress, external DNS, and a regional UDP/TCP load balancer.
- Nodes expose the JVB host UDP ports 10000, 10100, and 10200. Regional TURN
  load balancers expose UDP 3478 and TLS 443; relay ports 50000-54999 remain
  cluster-internal between Coturn and JVB.
- The configured cluster peer range must be no broader than the JVB node/pod
  range. Coturn denies private peers except this explicit range.

Mirror each source digest from `values.yaml` under the matching name in one
owned repository (`web`, `prosody`, `jicofo`, `jvb`, `coturn`, `busybox`, and
`haproxy`), then sign the mirrored digest. For example:

```sh
crane copy ghcr.io/jitsi/jvb@sha256:d7dc646d21af07530ae6acf1ace23ea4782445d0362004621a32a5a632a964e9 \
  registry.example.com/meet/jvb:stable-11146-2
cosign sign --key /secure/release.key \
  registry.example.com/meet/jvb@sha256:d7dc646d21af07530ae6acf1ace23ea4782445d0362004621a32a5a632a964e9
```

Create `helix-meet-runtime` outside Git with `JWT_APP_SECRET`,
`JICOFO_AUTH_PASSWORD`, `JVB_AUTH_USER`, and `JVB_AUTH_PASSWORD`. Each regional
`helix-meet-turn-{us-east-1,us-east-2,us-west-2}` secret contains only its
`TURN_CREDENTIALS` HMAC secret. Rotate one region through the external secret
manager, roll its Prosody and Coturn after a 10-minute overlap, then continue
to the next region. Also create `helix-meet-ingress-tls` and one TLS secret per
TURN hostname: `helix-meet-turn-{us-east-1,us-east-2,us-west-2}-tls`.

## Verify and deploy

```sh
export HELIX_MEET_IMAGE_REGISTRY=registry.example.com/meet
export HELIX_MEET_PUBLIC_HOST=meet.example.com
export HELIX_MEET_TURN_DOMAIN=example.com
export HELIX_MEET_CLUSTER_PEER_RANGE=10.40.0.0-10.40.255.255
export HELIX_MEET_COSIGN_PUBLIC_KEY=/secure/release.pub

infra/meet/ha/deploy.sh verify
infra/meet/ha/deploy.sh deploy
```

The upgrade is atomic and waits for readiness. JVB uses a one-at-a-time rolling
strategy even with host ports: preStop first enables the JVB drain API, waits
up to 10 minutes for participants to leave, and only then releases the port.
Scale-down stabilization is 15 minutes. PDBs protect two JVBs per shard, two
HAProxy replicas, and one Coturn replica during voluntary maintenance.

Before an upgrade, run `deploy.sh render`, review the diff against the current
release manifest, and record `helm history helix-meet -n helix-meet`. If the
post-upgrade canary fails, rollback with the recorded revision:

```sh
infra/meet/ha/deploy.sh rollback 7
```

Rollback waits and cleans up a failed attempt. It reuses the post-rendered
manifest stored in Helm history, including its original image digests.

## Loss and upgrade evidence

`validate.sh` proves the locked artifact, complete digest set, three regional
TURN paths, room stickiness, three-zone scheduling, HPA/PDB/drain policy, and
the N-1 capacity equation. Run its optional online chart-signature check in CI:

```sh
infra/meet/ha/validate.sh --online-signatures
```

For a release candidate, point `HELIX_MEET_CANARY_URL` at an external synthetic
client that returns 2xx only while its already-established two-party call has
bidirectional RTP. The drill requires explicit confirmation, removes only JVB
pods, and always uncordons affected nodes:

```sh
HELIX_MEET_CANARY_URL=https://canary.example.com/calls/ha/health \
  infra/meet/ha/failover-drill.sh --confirm bridge
HELIX_MEET_CANARY_URL=https://canary.example.com/calls/ha/health \
  infra/meet/ha/failover-drill.sh --confirm node
HELIX_MEET_CANARY_URL=https://canary.example.com/calls/ha/health \
  infra/meet/ha/failover-drill.sh --confirm zone us-east-1a
```

The default established-call interruption budget is 30 seconds over a
three-minute observation window. A failed drill blocks promotion.

The complete browser/device/network support boundary, SLOs, accessibility and
caption limitations, privacy model, incident playbooks, and sustained mixed-call
release gate are maintained in [`docs/meet-support-and-slos.md`](../../../docs/meet-support-and-slos.md).
The release gate reuses this drill's optional aggregate JSON output and the
MEET-14 metrics instead of maintaining a second failure or telemetry harness.
