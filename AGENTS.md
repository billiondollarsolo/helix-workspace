# Helix Workspace Agent Guide

This repository owns the communication and file-storage platform, web app, CLI,
MCP interface, infrastructure, and SDK contracts. The product includes Mail,
Drive storage, Chat, Calendar, Meet, Assistant, and Admin, plus Passwords, an
optional administrator-enabled native KeePass vault; existing Vaultwarden installs
remain available through a legacy link during migration. Editors, file viewers,
and converters are outside the product and must not remain as dependencies,
optional integrations, disabled controls, or compatibility stubs.

Keep unrelated local work intact. Do not edit sibling repositories, generated
dependencies, or generated route trees. Do not commit build output or secrets.

Reuse existing helpers. Preserve tenant isolation, actor-scoped authorization,
malware scanning, retention, audit trails, and actionable errors. Meet requires
configured LiveKit credentials; do not bypass deployment evidence or dependency gates.
Use semantic HTML, labelled controls, keyboard focus, and reduced motion.

Keep the established visual design. Use global design tokens and existing shared
controls, fields, and layout components; do not copy control styles into features.
Forms must have styled, labelled controls, help, validation, and inline errors.
Use labelled + New or + Add actions for creation. Use inline forms, dedicated
pages, or nonblocking panels for creation and editing; reserve blocking modals
for confirmations and concrete review decisions. Preserve drafts, focus, and
scroll during background updates. Sandboxed email content keeps its isolated
document stylesheet for security; application controls use the shared styles.

Run focused checks while iterating, then `pnpm format:check`, `pnpm typecheck`,
`pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm quality:boundaries`.
For web changes also run the relevant Playwright and accessibility checks.
