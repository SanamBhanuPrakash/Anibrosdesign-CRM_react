# Anibros CRM — UI Design System (v2)

Implementation: `src/theme/theme.ts` (tokens + MUI overrides), `src/ui/*` (shared components), `src/app/*` (shell). Stack: **Material UI v9** + Emotion, MUI icons, MUI X Charts (free package only), TanStack Query. **One styling system:** Tailwind and the legacy component kit were removed (2026-10-15) after the last four legacy pages were rebuilt; a screen that needs a colour takes it from the theme.

## 1. Principles
1. **Calm, editorial, data-first.** A CRM is read for hours: low contrast noise, strong hierarchy, generous rhythm.
2. **One accent.** Deep green-teal (`#1F6F5C` / `#5BB59D` dark). Semantic colours are muted. No gradients-as-decoration, no purple "AI" palette.
3. **Warm paper neutrals**, never pure white/black: light `#F7F6F2`/`#FFFFFF`, dark `#161614`/`#1E1E1B`. Shadows are tinted warm.
4. **Honest states.** Every data view has loading (skeleton), error (specific + retry + reference id), empty (composed, next step), and content. Failures are never shown as "empty".
5. **Accessibility is baseline:** visible focus (`:focus-visible` 2 px accent), labels bound to inputs, error text associated, `aria-live` for status, skip link, keyboard-complete flows, `prefers-reduced-motion` honoured globally, colour is never the only signal.
6. **Server is the authority.** UI hides what you can't do (capabilities from `/me`), but never relies on hiding.

## 2. Tokens
| Group | Light | Dark |
|---|---|---|
| Background / paper / sunken | `#F7F6F2` / `#FFFFFF` / `#EFEDE6` | `#161614` / `#1E1E1B` / `#121210` |
| Text primary / secondary / disabled | `#1C1B18` / `#5F5D55` / `#9A978C` | `#ECEAE3` / `#A9A69B` / `#6F6D64` |
| Divider | `#E4E1D8` | `#34322D` |
| Primary | `#1F6F5C` (hover `#155143`) | `#5BB59D` |
| Success / Warning / Error / Info | `#2E7D4F` / `#A66A12` / `#B3382C` / `#2F6690` | lighter, contrast-checked variants |
| Tones | `accentTone` (selected/badges), `neutralTone`, `surface.{sunken,raised,hover,selected}` | equivalents |
Radii: 8 (controls), 10 (containers/menus), 12–14 (dialogs/cards). Spacing: MUI 8-px scale. Breakpoints 0/600/900/1200/1536. Light/dark/system via MUI CSS variables (`data-color-scheme`), applied before first paint (no flash).
**Rule:** colours come only from theme tokens (`sx` colour strings such as `text.secondary`, `surface.hover`, `chart.s1`, or `theme.vars.palette` in callbacks); inside component overrides never read `theme.palette` (light only). No hex or Tailwind colour in a screen. A page that follows this is correct in both schemes with no per-page dark mode code.
**Data visualisation tokens:** `chart.s1…s6` (categorical, each ≥ 3:1 against the surface in both schemes), `chart.muted`, `chart.grid`. Colour is never the only signal: values are always printed, and status uses words. Use ONE colour for one measure; use categories only when the categories are the point.
**Contrast:** text on every surface reaches 4.5:1 (checked with axe on every route in both schemes). Navigation group headings use `text.secondary`; `text.disabled` is for disabled controls only. Avatar tints keep white initials at 4.5:1.

## 3. Typography (Google Fonts, self-hosted via Fontsource — no request to Google)
| Role | Family | Use |
|---|---|---|
| UI & data | **Geist Variable** | everything by default; `variant="numeric"` enables tabular figures for tables/KPIs |
| Display | **Newsreader Variable** (serif) | page titles (h1–h3), dialog titles, hero numbers |
| Mono | **Geist Mono Variable** | ids, keys, codes, request references |
Scale: h1 36 / h2 28 / h3 22 / h4 17 / h5 15 / body 14 / body2 13 / caption 12 / eyebrow 11 caps.
**Roles, one rule per role (no page invents its own):** page title = `PageHeader` (Newsreader h2 token, 28 px, via `variant="h2" component="h1"`); section or panel title = `h5` (15/600) inside `Panel`; settings section title = `h4` (17/600); hero figure = Newsreader at 26–32 px via `StatTile`; table numbers use tabular figures; labels are body2 (13 px, secondary) and wrap instead of being cut off; identifiers use the mono role. Display serif is for titles and hero figures only, never for body text or labels. `text-wrap: balance` on headings, `pretty` on body. Measure ≤ 65ch for prose.
*Note on "Claude fonts": Anthropic's brand typefaces are proprietary and not licensed for use here; the pairing above is an open-source editorial equivalent.*

## 4. Layout & navigation
- App shell: collapsible permission-aware sidebar (Work · Inventory · Insights · Automate · Workspace), workspace switcher, top bar with **command palette (⌘/Ctrl+K or `/`)**, realtime status, account menu (theme, sign out). Mobile: temporary drawer. Content max-width 1480, gutters 16/24/40.
- Page anatomy: `PageHeader` (serif title, ≤65ch description, actions) → sections divided by hairlines (`Section`: title+help left, controls right) → data. Prefer flat sections and dividers over nested cards; cards only where elevation communicates hierarchy.
- Tables: MUI `Table` for small lists; MUI X DataGrid (server-side) for large ones — with saved views and bulk bar (Wave 6.4).

## 5. Components (`src/ui`)
Analytical screens share `src/ui/analytics.tsx` and `src/ui/Panel.tsx`: `Panel` (titled surface with an optional "what does this mean" help button), `StatTile` (one headline figure; label wraps; whole tile is a link when it has a destination), `BarList` (ranked rows with an inline bar, sized to the data: one row for one source), `RangeBar` (quick periods, exact dates, the test-lead switch; state lives in the URL), `ChartFrame` (text summary for assistive technology), `MetricHelp`. Charts are used only where a chart is the right form (a trend over time); a ranked list of five items is a `BarList`, not a chart canvas. Nothing empty is drawn: zero-value rows are omitted and said so.
`PageHeader`, `Section`, `QueryBoundary` (loading→error→empty→content), `EmptyState`, `ErrorState` (+ reference id), `SkeletonRows`, `ConfirmProvider/useConfirm` (promise-based, destructive default-safe), `ToastProvider/useToast`, `PasswordField` + `PasswordStrength`, `UserAvatar` (rounded-square, muted deterministic tints), `RoleChip`, `RelativeTime` (exact time on hover), `CopyButton`, `ErrorBoundary`.
Interaction polish: 150 ms ease-out colour/border transitions, `scale(0.98)` press feedback on buttons, hover/selected tones on rows & nav, focus rings, no layout shift on loading.

## 6. Forms
react-hook-form + zod resolvers; server validation errors (`errors[].path`) map back to fields; passwords never trimmed; submit disabled only while pending (never hide the reason); destructive confirmations via `useConfirm`; secrets shown once with explicit acknowledgement.

## 7. Content style
Sentence case, plain active voice, specific errors ("We can't reach the server. Check your connection and try again."), no exclamation marks, no "Oops", no filler. Domain terms: *workspace* (tenant), *lead*, *viewing*, *pipeline stage*.

## 8. Quality gates (Wave 6.6/6.7)
Initial JS ≤ 250 kB gzip (currently ≈ 245 kB incl. vendor chunks); route-level lazy loading; LCP < 2.5 s on a mid laptop; Lighthouse a11y ≥ 95; axe checks and Playwright journeys for auth, team, API keys, leads, pipeline, viewings in CI; visual regression snapshots at 390/768/1440 px in light and dark.
