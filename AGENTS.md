# Helix Workspace Agent Guide

## Scope and topology

- This repository owns the Helix host, web shell, services, infrastructure, and SDK contracts.
- `../helix-editors` is the required sibling repository. Editor UI primitives and editor-owned
  packages belong there; host integration and product surfaces belong here.
- When a change spans both repositories, use the same branch name in each and validate the paired
  refs together. Do not copy editor source into this repository.
- Keep unrelated work in the workspace intact. Never edit generated dependencies or commit build
  output.

## Production packaging boundary (MVP default; Full Workspace gated)

- **Default production profile is MVP** (`HELIX_WORKSPACE_PROFILE=mvp` or unset): Mail, Drive
  (storage + read-only previews), secure server-readable Chat, Assistant/agent workflows, and Admin.
- MVP production must fail closed unless `HELIX_APPS` is exactly `mail,drive,chat,assistant`, the
  disabled module configuration is explicit for docs/calendar/meet/editors, editor migrations are
  `false`, and the web build uses `VITE_HELIX_MVP_ONLY=true`.
- **Full Workspace v1** (`HELIX_WORKSPACE_PROFILE=full`) expands `HELIX_APPS` to
  `mail,drive,chat,assistant,calendar,meet,docs,sheets,slides` only after domain evidence and
  fail-closed dependency gates (Meet requires Jitsi domain + JWT secret; Business Drive requires
  ClamAV; editors require `HELIX_EDITORS_MIGRATIONS_ENABLED=true` and helix-editors pin). See
  `docs/architecture/v1-packaging-matrix.md` and `apps/helix/src/config/workspace-packaging.ts`.
- Do not enable Full Workspace packaging as a shortcut without those gates. Dormant integration
  code is not enablement.
- `../helix-editors` remains a pinned compatibility/build input; treat editor enablement as PKG.

## Implementation rules

- Preserve the core-app boundary enforced by `infra/scripts/verify-workspace-editor-boundaries.mjs`.
  Import public `@helix/editors-*` packages rather than sibling source paths.
- Do not ship controls that silently do nothing. Hide them or disable them with a useful reason.
- Use semantic HTML, visible keyboard focus, labelled forms, actionable errors, and reduced-motion
  support. New routes must retain the shell's `#main-content` navigation target.
- Keep route/search state in the URL when it needs to survive refresh, sharing, or back/forward.
- Add focused tests beside changed code. Do not manually edit `apps/web/src/routeTree.gen.ts`.
- Never add secrets, production credentials, or customer data to fixtures, logs, or commits.

## Verification

Run the narrowest relevant tests while iterating, then from this repository run:

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm quality:editors-boundaries:test
pnpm quality:editors-boundaries
```

For web UI changes also run the relevant Playwright/a11y checks. If `../helix-editors` changed,
build and test it first so this repository consumes the current package output.
