# Helix Workspace Agent Guide

This repository owns the communication and file-storage platform, web app, CLI,
MCP interface, infrastructure, and SDK contracts. The product includes Mail,
Drive storage, Chat, Calendar, Meet, Assistant, and Admin. Editors, file viewers,
and converters are outside the product and must not remain as dependencies,
optional integrations, disabled controls, or compatibility stubs.

Keep unrelated local work intact. Do not edit sibling repositories, generated
dependencies, or generated route trees. Do not commit build output or secrets.

Reuse existing helpers. Preserve tenant isolation, actor-scoped authorization,
malware scanning, retention, audit trails, and actionable errors. Meet requires
configured Jitsi credentials; do not bypass deployment evidence or dependency gates.
Use semantic HTML, labelled controls, keyboard focus, and reduced motion.

Run focused checks while iterating, then `pnpm format:check`, `pnpm typecheck`,
`pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm quality:boundaries`.
For web changes also run the relevant Playwright and accessibility checks.
