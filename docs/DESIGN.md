# Fleet design system

The line-controller draft HTML (`docs/planning/2026-10-13_waves-dashboard.html`)
is the visual source of truth. This package, `@fleet/ui`, is its implementation
as React components. Where the two disagree, the draft wins and the package
changes.

## Tokens

The draft defines its tokens as CSS custom properties on `:root`. The components
in this package never hard-code a colour: every colour, border, radius and font
reference goes through these variables, so the dark default and the
`[data-theme="light"]` twin both work without component changes.

Surfaces and lines:

| Token | Role |
|---|---|
| `--bg` | page background |
| `--card` | card / pane surface |
| `--line`, `--line-soft`, `--line-strong` | hairlines at three weights |

Text:

| Token | Role |
|---|---|
| `--text` | primary text |
| `--muted` | secondary text |
| `--faint` | tertiary text |

Accents:

| Token | Meaning |
|---|---|
| `--cyan` | active / attention |
| `--emerald` | accepted, success, "yes" |
| `--amber` | unknown, gaps, warnings |
| `--rose` | failed |
| `--violet` | blocked, decisions |

Supporting tokens used by the components: `--bg-sink` (sunken controls),
`--card-sheen` (gradient layered over `--card`), `--radius` and `--radius-card`,
`--slate` (the neutral accent for "ended" and "no").

## Type roles

| Token | Role |
|---|---|
| `--sans` | body copy, controls |
| `--display` | headings and the wordmark |
| `--mono` | ids, facts, badges, chips, labels |

System stacks only; nothing is fetched.

## Components

All are exported from `src/index.ts` and take an optional `style` prop that
merges after (and so overrides) the component styles.

- **`Badge kind`** — mono, uppercase pill with a 1px `currentColor` border and
  a 9% `color-mix` wash. Kinds: `active` (cyan), `ended` (slate), `unknown`
  (amber), `blocked` (violet), `queued` (muted), `accepted` (emerald),
  `failed` (rose), `fix` (violet), `keeper` (emerald), `candidate` (amber).
- **`Fact state`** — a dot plus a mono word, one of the five runner facts.
  States: `yes` (filled emerald dot), `no` (outlined slate dot), `unknown`
  (dashed amber dot), `stale` (dashed muted dot, dimmed to 60% — an
  observation that no longer speaks for the present).
- **`Card`** — the sheen-over-card surface with a `--line` border and
  `--radius-card`; `padded` adds the draft's `0.75rem 0.9rem` inset.
- **`IconButton label`** — 1.7rem square sunken button for a single glyph;
  hover and focus bring `--line-strong` and `--text`. The `label` is required
  and becomes both `title` and `aria-label`.
- **`RouteChip variant`** — mono pill naming a route the plan does or does not
  name. `plain` is faint on a soft hairline; `gap` is amber on a dashed amber
  border.

## Non-goals

No Tailwind, no runtime stylesheet, no dependency on any `@fleet/*` domain
package. The package renders with inline styles drawn from the variables
above; the page that mounts these components owns the `:root` token block.
