# G0.3 Baseline smoke notes

date=2026-08-02T16:49:31+00:00
workspace_sha=c7af2961327cb0eab50600a0f81b453a3c2a3152
editors_sha=e0e5bc3d21ff63c4b53db5ff72d80d5efb3b3b80

## Compose

Full docker compose up was not required for G0 docs baseline; Tier-1 checklist remains docs/tier-1-compose-checklist.md.
Structural baseline:
docker-compose.yml=present
docker-compose.production.yml=present
helm_chart=present

## Quality gates

See gates.log from G0.4 run in same session.

## Blocking for later phases

- Live smoke of mail/drive/chat requires compose stack + secrets (M7/D7/C6).
