# Plugin Author Guide

Phase 9 documentation pass for TASK-A09.

## Shell Contributions

Plugins should register shell routes, left rail items, command palette actions, and right rail panels through the web platform host. Contributions must include stable IDs, plugin IDs, labels, and deterministic ordering.

Author checklist:

- Route labels are short and match the left rail or command label.
- Left rail icons are recognizable at 19px and have text labels.
- Command palette items include a group and searchable keywords.
- Right rail panels declare when they apply and expose an accessible label.
- Admin-only surfaces are flagged and remain hidden from non-admin navigation.

## Accessibility Requirements

Plugin UI must pass the same Phase 9 checks as platform UI:

- keyboard-only access
- visible focus state
- semantic headings and landmarks where applicable
- named icon buttons
- WCAG 2.2 AA contrast in light and dark modes
- reduced-motion support for animation
- mobile layout at 390px width

## Quality Gate Before Handoff

Run or request:

```sh
pnpm --filter @helix/web build
pnpm quality:a11y
pnpm quality:k6
```

When Playwright or k6 cannot run locally, attach the fallback accessibility report and the manual route review evidence described in `docs/accessibility.md` and `docs/visual-review.md`.
