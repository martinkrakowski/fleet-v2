# UI refinements — proposals

*Date: 2026-10-13 · Status: draft, not adopted · Owner decision: pending*

The applied changes (12px container padding, 3px container radius, live-lane
clock and pulse) are committed separately. This file holds the layout proposals
that were considered beside them. None of them is implemented, and none is
scheduled. Each one is a proposal for the owner to accept, change, or drop.

1. **Sticky header on the line table.** The knowledge view keeps its column
   labels visible while its wrap scrolls; the line table does not. Copying the
   same `position: sticky` header treatment would keep the attempt, fact, and
   state labels readable on a long line.

2. **Tabular numerals for observed and cost columns.** The observed timestamps
   and the lane-minute figures are set in the mono face but do not align
   vertically. `font-variant-numeric: tabular-nums` (or fixed-width cells)
   would let durations and timestamps be scanned down a column.

3. **Sticky project group rows.** The line table groups attempts by project with
   a full-width group row. Making those group rows sticky within the table wrap
   would keep the project context visible while its attempts scroll past.

4. **A density toggle for the line table.** The 12px row padding is the floor,
   not a ceiling. A compact/comfortable toggle, kept client-side, would let an
   operator choose a denser scan without weakening the minimum.

5. **Attention rail as a collapsible drawer on narrow screens.** Below 72rem
   the line grid already collapses to one column and the rail stacks under the
   table. Folding the "Needs attention" list into a drawer would keep the
   table above the fold on small screens without hiding the attention count.

6. **Align the seat grid with the capacity card.** The three slot tiles sit in
   a fixed three-column grid regardless of how many slots the installation
   reports. Sizing the columns from the slot count would keep the rail
   stable when capacity is not three.

None of these changes a fact, a receipt, a route, or a fixture. Any accepted
proposal is its own lane with its own verification.
