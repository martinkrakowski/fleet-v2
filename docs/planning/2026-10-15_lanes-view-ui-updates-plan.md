# Implementation Plan: `/lanes` View UI Updates

- **Date:** 2026-10-15
- **Project:** `fleet-v2`
- **Reference:** `/Users/martin/Desktop/lanes-view-ui-updates.png`
- **Scope:** `@fleet/ui` (`packages/ui`) and `@fleet/web` (`apps/web/src/app/lanes` + `apps/web/src/app/globals.css`)

---

## 1. Summary of Requested UI Changes

Per the user instructions and annotated screenshot (`/Users/martin/Desktop/lanes-view-ui-updates.png`):

1. **Move the `"show ended"` toggle to the `"All projects"` header bar, aligned right, and box the filter toolbar to full width:**
   - Remove `<Switch checked={showEnded} onChange={...} label="show ended" />` from `LanesToolbar` (`apps/web/src/app/lanes/components/lanes-toolbar.tsx`).
   - Place `<Switch checked={showEnded} onChange={setShowEnded} label="show ended" />` inside the `<CardHeader>` `actions` slot of the `"All projects"` card (`apps/web/src/app/lanes/page.tsx`), aligned right alongside the `{rows.length} lanes` count.
   - Extend `LanesToolbar` (`.tools` in `apps/web/src/app/lanes/lanes.module.css`) to **full width** with the same boxed card border, surface background, shadow, and border radius (`border: 1px solid var(--border-color); border-radius: var(--radius-card); background: var(--bg-surface); box-shadow: var(--shadow-card);`) as the other card windows on `/lanes`.
2. **Full-height containers on desktop (`lg`, `min-width: 992px`) for `"All projects"` and the right-hand `"Capacity"` / `"Needs attention"` column:**
   - On desktop viewports (`@media (min-width: 992px)`), make the `/lanes` page fill the available `.page-wrapper` height down to the bottom above the footer so that both the middle panel (`"All projects"` `Card.lanewrap`) and the right-hand panel (`div.rail` containing `CapacityCard` and `AttentionCard`) stretch flush to the bottom of the desktop viewport.
   - Preserve natural stacked flow on tablet/mobile (`< 992px`).
3. **Correct text formatting and alignment for the `state` drop-down menu and associated label:**
   - Currently `<Select label="state">` in `packages/ui/src/Select.module.css` uses `flex-direction: column`, stacking the lowercase `"state"` label vertically above `<select>` and causing vertical misalignment with `"8 of 8 shown"` in the horizontal toolbar.
   - Add an `inline` prop (`inline?: boolean`) to `@fleet/ui`'s `<Select>` component (`packages/ui/src/Select.tsx` + `Select.module.css`) so horizontal toolbars render the label and `<select>` inline on the same baseline/center axis (`flex-direction: row; align-items: center; gap: 8px;`), with clean label typography (`font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint);`) and properly formatted option labels (`Every state`, `Unknown`, `Blocked`, `Active`, `Queued`, `Accepted`, `Failed`, `Ended` — or consistent state display labels while keeping the filter values intact).

---

## 2. Detailed File-by-File Changes

### Step 1: Enhance `@fleet/ui` `<Select>` for Inline Toolbar Alignment
**Files:**
- [`packages/ui/src/Select.tsx`](file:///Users/martin/Projects/fleet-v2/packages/ui/src/Select.tsx)
- [`packages/ui/src/Select.module.css`](file:///Users/martin/Projects/fleet-v2/packages/ui/src/Select.module.css)

**Changes:**
1. In `packages/ui/src/Select.tsx`:
   - Add `inline?: boolean;` to `SelectProps`.
   - Apply `classes.wrapperInline` when `inline` is `true`:
     ```tsx
     export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
       label?: ReactNode;
       inline?: boolean;
       wrapperClassName?: string;
     }
     ```
2. In `packages/ui/src/Select.module.css`:
   - Add `.wrapperInline`:
     ```css
     .wrapperInline {
       flex-direction: row;
       align-items: center;
       gap: 8px;
     }

     .wrapperInline .label {
       font-family: var(--font-mono);
       font-size: 0.68rem;
       font-weight: 500;
       letter-spacing: 0.08em;
       text-transform: uppercase;
       color: var(--text-faint);
       white-space: nowrap;
     }
     ```
   - Ensure `.select` has clean vertical centering and right-chevron spacing (`height: 32px; padding: 0 28px 0 10px; line-height: 1.2;`).

### Step 2: Update `LanesToolbar` & Relocate `"Show ended"` Toggle to `"All projects"` Header
**Files:**
- [`apps/web/src/app/lanes/components/lanes-toolbar.tsx`](file:///Users/martin/Projects/fleet-v2/apps/web/src/app/lanes/components/lanes-toolbar.tsx)
- [`apps/web/src/app/lanes/page.tsx`](file:///Users/martin/Projects/fleet-v2/apps/web/src/app/lanes/page.tsx)

**Changes:**
1. In `apps/web/src/app/lanes/components/lanes-toolbar.tsx`:
   - Remove `showEnded` and `onShowEndedChange` from `LanesToolbarProps` (since `"show ended"` now lives in the `"All projects"` `CardHeader`).
   - Pass `inline` to `<Select label="State" inline ...>` and format the option text cleanly (e.g., `"Every state"` for `""`, and capitalized state names `s.charAt(0).toUpperCase() + s.slice(1)` while keeping `value={s}` unchanged so filter logic on `summary(a)[0]` is untouched):
     ```tsx
     export interface LanesToolbarProps {
       stateFilter: string;
       onStateFilterChange: (value: string) => void;
       shown: number;
       scopedCount: number;
     }

     export function LanesToolbar({
       stateFilter,
       onStateFilterChange,
       shown,
       scopedCount
     }: LanesToolbarProps) {
       return (
         <div className={styles.tools}>
           <Select
             label="State"
             inline
             value={stateFilter}
             onChange={(e) => onStateFilterChange(e.target.value)}
             aria-label="state filter"
           >
             {STATE_FILTERS.map((s) => (
               <option key={s} value={s}>
                 {s ? s.charAt(0).toUpperCase() + s.slice(1) : "Every state"}
               </option>
             ))}
           </Select>
           <span className={`${styles.tally} ${styles.mono}`}>
             {shown} of {scopedCount} shown{stateFilter ? " · filtered" : ""}
           </span>
         </div>
       );
     }
     ```
2. In `apps/web/src/app/lanes/page.tsx`:
   - Import `Switch` from `@fleet/ui`.
   - Update `<LanesToolbar>` call to pass `stateFilter`, `onStateFilterChange`, `shown`, and `scopedCount`.
   - Add `className={`row col-8-4 ${styles.board}`}` to the board grid container.
   - In the `"All projects"` `<CardHeader>`, render both the `"Show ended"` `<Switch>` and the `{rows.length} lanes` count in `actions` (aligned right via `CardHeader`'s `.actions` flex container):
     ```tsx
     <CardHeader
       title={project || "All projects"}
       actions={
         <div className={styles.headerActions}>
           <Switch
             checked={showEnded}
             onChange={setShowEnded}
             label="Show ended"
           />
           <span className={styles.meta}>
             {rows.length} lane{rows.length === 1 ? "" : "s"}
           </span>
         </div>
       }
     />
     ```
   - Note: Per `AGENTS.md` ("Navigation and view controls (theme toggle, drawer toggle, filters, row selection) are not domain actions and stay immediate"), the `"Show ended"` filter switch and `"State"` filter select remain immediate view controls.

### Step 3: Full-Width Boxed Filter Bar & Full-Height Desktop (`lg`) Columns
**Files:**
- [`apps/web/src/app/lanes/lanes.module.css`](file:///Users/martin/Projects/fleet-v2/apps/web/src/app/lanes/lanes.module.css)
- [`apps/web/src/app/lanes/components/attention-card.tsx`](file:///Users/martin/Projects/fleet-v2/apps/web/src/app/lanes/components/attention-card.tsx)
- [`apps/web/src/app/globals.css`](file:///Users/martin/Projects/fleet-v2/apps/web/src/app/globals.css)

**Changes:**
1. **Full-width boxed `.tools` bar in `apps/web/src/app/lanes/lanes.module.css`:**
   ```css
   .tools {
     width: 100%;
     display: flex;
     gap: var(--space-4);
     align-items: center;
     justify-content: space-between;
     flex-wrap: wrap;
     margin: 0 0 var(--space-4);
     padding: 10px 16px;
     background: var(--bg-surface);
     border: 1px solid var(--border-color);
     border-radius: var(--radius-card);
     box-shadow: var(--shadow-card);
     color: var(--text-muted);
     font-size: 0.8rem;
   }
   ```
2. **Header actions alignment in `apps/web/src/app/lanes/lanes.module.css`:**
   ```css
   .headerActions {
     display: inline-flex;
     align-items: center;
     gap: var(--space-3);
     flex-wrap: wrap;
     margin-left: auto;
   }
   ```
3. **Full-height desktop (`@media (min-width: 992px)`) containers for `"All projects"` and `"Capacity"` / `"Needs attention"` rail:**
   - In `apps/web/src/app/globals.css`:
     - Make `.page-wrapper` a flex column container (`display: flex; flex-direction: column;`) so pages that opt into full-height layout (`flex: 1`) can stretch to the bottom of the viewport above `.footer`.
   - In `apps/web/src/app/lanes/lanes.module.css`:
     - Set `.page { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }`.
     - Add `.board` and `.attnCard` rules for `@media (min-width: 992px)`:
       ```css
       .board {
         align-items: stretch;
       }

       .lanewrap {
         min-width: 0;
         display: flex;
         flex-direction: column;
       }

       .rail {
         min-width: 0;
         display: flex;
         flex-direction: column;
         gap: var(--space-4);
       }

       .attnCard {
         display: flex;
         flex-direction: column;
       }

       @media (min-width: 992px) {
         .board {
           flex: 1;
           min-height: 0;
           margin-bottom: 0;
         }

         .lanewrap {
           height: 100%;
         }

         .rail {
           height: 100%;
         }

         .attnCard {
           flex: 1;
         }
       }
       ```
   - In `apps/web/src/app/lanes/components/attention-card.tsx` (or `capacity-card.tsx`):
     - Pass `className={styles.attnCard}` to `<Card className={styles.attnCard}>` in `AttentionCard` (and/or `CapacityCard`) so the right-hand `.rail` column stretches cleanly to match the full height of the `"All projects"` card down to the bottom of the desktop viewport.

---

## 3. Verification Plan

1. Run full workspace checks:
   ```bash
   yarn build && yarn typecheck && yarn lint && yarn lint:arch && yarn sync:check
   ```
2. Verify desktop (`lg` >= 992px) and mobile (`sm` <= 640px) rendering:
   - Confirm `"Show ended"` toggle is in the `"All projects"` header bar, aligned right alongside the lane count.
   - Confirm the filter toolbar extends full width with the same card border, surface background, shadow, and border radius as the other windows.
   - Confirm the `State` dropdown and its label are aligned inline horizontally and formatted cleanly.
   - Confirm `"All projects"` and the right-hand `"Capacity"` / `"Needs attention"` column stretch to full height on desktop (`lg`).
