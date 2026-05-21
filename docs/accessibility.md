# Accessibility Quality Gate

Phase 9 covers TASK-A06 accessibility readiness for the Helix web shell.

## Automated Audit

Run the strict audit against a running web preview:

```sh
pnpm --filter @helix/web build
pnpm --filter @helix/web preview
HELIX_WEB_BASE_URL=http://127.0.0.1:4173 pnpm quality:a11y
```

The gate uses `apps/web/scripts/accessibility-audit.mjs`, Playwright, and `axe-core`. Route and viewport coverage lives in `apps/web/quality-gates.routes.json`.
It runs axe in the light theme, then runs visual smoke in light and dark themes with reduced motion requested. The smoke pass opens the shell right rail when present and records findings for horizontal overflow, obvious text/control clipping, element overlap, and continuous reduced-motion animation.
The smoke pass also checks visible text/control contrast in both light and dark themes against WCAG 2.2 AA thresholds: 4.5:1 for normal text and 3:1 for large or bold text.

The strict gate fails when:

- the preview URL is not reachable
- Playwright or axe-core cannot run
- any axe violation is found on the configured route and viewport matrix
- any visual smoke finding is found on the configured route, viewport, and theme matrix

Reports are written to `apps/web/reports/a11y/`.

## Documented Fallback

Use the fallback only when browser execution is not available in the current environment:

```sh
pnpm quality:a11y:fallback
```

The fallback writes a report with the route matrix, viewport matrix, and required manual checks. It is not a substitute for the strict CI gate before release.

## WCAG 2.2 AA Checklist

- Perceivable: text contrast is at least 4.5:1 for normal text and 3:1 for large text in light and dark modes.
- Perceivable: icon-only controls have accessible names and do not rely on color alone.
- Perceivable: zoom to 200% does not hide critical navigation or form controls.
- Operable: all interactive controls are reachable and usable with keyboard only.
- Operable: focus order follows the visual workflow and focus indicators are visible.
- Operable: no keyboard trap exists in menus, command palette, dialogs, or rails.
- Operable: reduced-motion mode removes nonessential animation and avoids continuous motion.
- Understandable: page titles, headings, labels, and button names describe the action or destination.
- Understandable: errors and empty states explain next steps without requiring visual context.
- Robust: shell landmarks are present for navigation, main content, complementary rail, and auth screens.
- Robust: dynamic panels update names, roles, values, and expanded state for assistive technology.

## Mobile Responsive Route Coverage

Check every configured route at these minimum widths:

- 390 x 844 mobile
- 768 x 1024 tablet
- 1440 x 900 desktop

Routes in scope:

- `/`
- `/login`
- `/signup`
- `/mail`
- `/chat`
- `/drive`
- `/docs`
- `/calendar`
- `/meet`
- `/assistant`
- `/settings`
- `/settings/admin`
- `/admin`

For each route, verify no horizontal page scroll, no clipped primary action, no overlapping text, visible focus state, and usable navigation.
