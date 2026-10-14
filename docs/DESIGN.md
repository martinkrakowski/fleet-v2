# Fleet design system

`docs/DESIGN.md` and `@fleet/ui` (`packages/ui`) are the **sole authoritative
visual specification** for Fleet v2. The earlier draft
`docs/planning/2026-10-13_waves-dashboard.html` is retired as the visual source
of truth: where it disagrees with this document or the package, this document
and `@fleet/ui` win.

## Licence attribution

Token values and component CSS rules in `@fleet/ui` and in
`apps/web/src/app/globals.css` are adapted from MIT-licensed admin design system
styles. The MIT copyright and permission notice is preserved with this
distribution:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions: the above copyright
> notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

## First paint & theme tokens

Tokens are CSS custom properties defined on `:root` in
`apps/web/src/app/globals.css`:

- **Light mode** — `:root` and `:root[data-theme="light"]` define the default
  palette: `--body-bg: #f5f7fb`, `--bg-surface: #ffffff`,
  `--bg-surface-secondary: #f9fafb`.
- **Dark mode** — `:root[data-theme="dark"]` overrides the palette:
  `--body-bg: #0f1623`, `--bg-surface: #1a2332`,
  `--bg-surface-secondary: #141d2b`.

Components in `@fleet/ui` never hard-code a colour: every colour, border,
radius, shadow and font reference goes through these variables, so both themes
work without component changes. Temporary legacy aliases (`--bg`, `--card`,
`--line`, `--muted`, `--sans`, …) remain on `:root` until Phase 7 retires them.

## Sidebar surface

The sidebar is a themed rail whose tokens adapt between Light mode and Dark
mode (the width tokens are constant):

| Token | Light mode | Dark mode | Role |
|---|---|---|---|
| `--sidebar-bg` | `#ffffff` | `#1a2332` | rail background |
| `--sidebar-w` | `252px` | `252px` | expanded width |
| `--sidebar-rail-w` | `64px` | `64px` | collapsed icon-rail width (`body.sidebar-rail`) |
| `--sidebar-active` | `rgba(26, 187, 156, 0.1)` | `rgba(26, 187, 156, 0.14)` | active link wash |
| `--sidebar-text` | `#5a6577` | `#93a0bb` | idle link text |
| `--sidebar-text-active` | `#1e2633` | `#e9eef7` | active/hover link text |
| `--sidebar-border` | `#e6e7eb` | `rgba(255, 255, 255, 0.08)` | rail border |

Toggling `body.sidebar-rail` animates the rail width (`252px` ↔ `64px`) with
a `0.22s` `cubic-bezier(0.22, 1, 0.36, 1)` transition on `.app-shell`'s grid
track and `.sidebar`'s width; labels, badges, the project filter and the
footer fade/collapse by `opacity`/`max-width`/`max-height` instead of
`display: none`, so the toggle animates cleanly in both directions. Collapsed
rail items carry `data-tooltip` (view links use their label; the brand uses
`fleet`) and reveal hover/`focus-visible` tooltips rendered from
`attr(data-tooltip)` through `::after`. All shell motion is disabled under
`prefers-reduced-motion: reduce`.

## Primary accent & semantic tones

The primary accent is teal `#1abb9c` (`--primary`, `--primary-dk: #169f85`,
`--primary-lt` as a translucent wash). Semantic tones pair a solid accent with
a translucent `-lt` wash:

| Tone | Solid | Wash |
|---|---|---|
| `neutral` | `--text-muted` / `--border-color` | — |
| `accent` | `--primary` | `--primary-lt` |
| `ok` | `--green` | `--green-lt` |
| `warn` | `--yellow` | `--yellow-lt` |
| `danger` | `--red` | `--red-lt` |
| `decision` | `--purple` | `--purple-lt` |

Supporting hues follow the same solid/wash pairing: `--blue`/`--blue-lt`,
`--azure`/`--azure-lt`, `--cyan`/`--cyan-lt`, `--orange`/`--orange-lt`.

## Typography & spacing

The system is **pure**: zero CDN font requests, no `Inter` in the font stack —
only operating-system faces.

| Token | Value |
|---|---|
| `--font-sans` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` |
| `--font-mono` | `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace` |

Body copy is `14px` (`0.875rem`) at a line-height of `1.4286`, weights
`400/500/600`.

Radii: `--radius-sm: 4px`, `--radius: 6px`, `--radius-lg: 8px` (cards use
`--radius-card: 6px`).

Spacing scale:

| Token | Value |
|---|---|
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-5` | `24px` |
| `--space-6` | `32px` |
| `--space-7` | `48px` |
| `--space-8` | `64px` |

## CSS ownership boundary

- `apps/web/src/app/globals.css` holds **only**: CSS custom properties, base
  document resets, the Admin Shell layout classes (`.app-shell`, `.sidebar`,
  `.topbar`, `.main`, `.page-wrapper`, `.footer` and their sub-parts), and the
  `apps/web`-only page grid classes (`.row`, `.col-1`, `.col-2`, `.col-3`,
  `.col-4`, `.col-8-4`, `.col-4-8`).
- `packages/ui` (`@fleet/ui`) owns **all** primitive component styles and
  **never** depends on `.row` or `.col-*`.
- Component styles are plain CSS drawn from these variables. No Tailwind, no
  runtime stylesheet, no dependency on any `@fleet/*` domain package.

## Component catalogue (`@fleet/ui`)

**Surfaces**

- `Card` — the base surface (`--bg-surface`, `--border-color`,
  `--radius-card`, `--shadow-card`), with `CardHeader`, `CardBody` and
  `CardFooter` sections.
- `PageHeader` — page title, optional subtitle and trailing actions.
- `EmptyState` — centred icon, heading and body for empty collections.
- `Banner` — full-width notice in a semantic tone (`ok` / `warn` / `danger` /
  `accent`).

**Controls**

- `Button` — primary (teal), secondary, subtle and danger variants, sizes,
  loading state.
- `IconButton` — square single-glyph button; `label` is required and becomes
  both `title` and `aria-label`.
- `Switch` — labelled toggle.
- `Select` — native select styled to the token palette.
- `Accordion` — collapsible section with header and body slots.

**Data display**

- `StatCard` — metric with label, value, optional delta and tone.
- `Table` — token-styled table with header, rows and footer slots.
- `KeyValueList` — two-column label/value list.
- `Stepper` — numbered step indicator with a current marker.
- `Chip` — compact mono pill for ids, routes and small facts.
- `Badge` — uppercase status pill; kinds include `active`, `ended`,
  `unknown`, `blocked`, `queued`, `accepted`, `failed`.
- `Fact` — dot plus a mono word; states `yes`, `no`, `unknown`, `stale`.
- `RouteChip` — mono pill naming a route; `plain` is faint on a soft hairline,
  `gap` is warn-toned on a dashed border.

All components accept an optional `style` prop that merges after (and so
overrides) the component styles, and take no colours from anywhere but the
tokens above.