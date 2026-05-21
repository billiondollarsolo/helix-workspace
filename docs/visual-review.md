# Visual Review Quality Gate

Phase 9 covers TASK-A07 visual identity, responsive review, theme review, and motion review for the web shell.

## Review Matrix

Use `apps/web/quality-gates.routes.json` as the route and viewport source of truth. Capture each route in:

- light theme
- dark theme
- reduced motion
- mobile, tablet, and desktop viewports
- shell right rail open state where the context panel is present

## Visual Identity Checks

- Helix mark, left rail, top bar, content frame, and right rail use consistent spacing and 8px radius.
- The palette does not collapse into a one-note theme; primary, accent, danger, panel, border, and muted colors remain distinct.
- Repeated empty feature surfaces use consistent icon, heading, body, and action treatment.
- Operational screens remain dense and scannable; no landing-page composition is used for app routes.
- Text never overlaps controls, badges, rail content, panels, or route content.

## Light And Dark Review

- `:root` and `:root.dark` tokens preserve readable contrast.
- Borders, muted panels, hover states, and active rail items are visible in both modes.
- Status colors remain distinguishable without relying on hue alone.
- Native color-scheme is set correctly so form controls match the active theme.

## Reduced Motion Review

- Run the accessibility audit with reduced motion enabled; the script configures Playwright with `reducedMotion: "reduce"` and fails on continuous infinite animation detected during the route smoke pass.
- Manually inspect animated loading and meeting states.
- Continuous animation must pause, stop, or be nonessential.
- Focus transitions and route loading must remain understandable without motion.

## Sign-Off Evidence

Record the following before release:

- audit report path from `pnpm quality:a11y`, including the automated light/dark, reduced-motion, right-rail, overflow, clipping, and overlap smoke results
- screenshots or screen recordings for the route matrix
- issues opened for any route that fails responsive, theme, or reduced-motion checks
