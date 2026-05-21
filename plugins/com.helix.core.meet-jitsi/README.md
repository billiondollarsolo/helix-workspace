# Meet Jitsi Plugin

`com.helix.core.meet-jitsi` is the first-party Meet provider for Phase 7. It
declares the stable Meet tool contract and uses a self-hosted Jitsi deployment
for media.

Tools:

- `meet.create-room`
- `meet.mint-token`
- `meet.end-room`

Infrastructure:

- `compose.yaml` contains the plugin-local Jitsi recipe.
- `../../infra/meet/README.md` documents root compose profile usage and envs.

The runtime TypeScript implementation is intentionally outside this artifact.
