# Grok-4.7 Plan Review: `/brief` Header Action Relocation, `@fleet/ui` `AlertBox` Confirmation Modal, and Unwired Actions Inventory

- **Date:** 2026-10-15
- **Plan Reviewed:** `docs/planning/2026-10-15_brief-header-and-alert-box-plan.md`
- **Reviewer Seat:** `grok -m grok-4.7 --permission-mode plan` (Grok CLI on laptop, never OpenRouter)
- **Final Verdict:** **Ready for implementation.**

---

## Round 1 Findings & Amendments Applied

1. **Unused `FREEZE_ROUTE_NOTE` and `RouteChip` import in `apps/web/src/app/brief/page.tsx`:**
   - *Finding:* Removing `<RouteChip gap>{FREEZE_ROUTE_NOTE}</RouteChip>` from `<PageHeader>` leaves `FREEZE_ROUTE_NOTE` (line 12) and the `RouteChip` import (line 4) unused, which fails `yarn typecheck` / `yarn lint`.
   - *Amendment:* Added explicit step 1d in Section 1 to remove `FREEZE_ROUTE_NOTE` and the unused `RouteChip` import from `apps/web/src/app/brief/page.tsx`.
2. **`AlertBox` focus management and `tone` contract:**
   - *Finding:* Specify initial focus and focus restoration for `role="alertdialog"`, and add an explicit `tone` column to the Section 4 confirmation copy matrix matching `opTone()` and `OPS`.
   - *Amendment:* Updated Section 3 to specify capturing `document.activeElement` on open, moving initial focus to the `Cancel` button (`cancelButtonRef.current?.focus()`), handling `Escape` -> `onCancel()`, and restoring focus on close/unmount; added explicit `tone` values to Section 4.
3. **Exclusion of clipboard copy control (`data-action="copy"`):**
   - *Finding:* `attempt-header.tsx` includes a clipboard copy button (`data-action="copy"`) alongside filter pills and candidate inspection selectors.
   - *Amendment:* Updated the Section 4 exclusion note to explicitly include the clipboard copy button (`data-action="copy"` in `attempt-header.tsx`).
4. **Accuracy of `/v1` API route inventory in Section 5:**
   - *Finding:* Align Section 5 with `apps/api/server/routes/v1/`: list all six `GET` routes, note that `GET /v1/attempts/:id` executes `reconcileAttempt.execute`, note that `POST /v1/attempts` sequences `prepareBriefPackage` -> `reserveExecutionCapacity` -> `dispatchAttempt`, use `POST /v1/forge` (`merge-pr` / `push-and-open-pr`), and remove `.architecture/manifest.yaml` from the HTTP route bullet.
   - *Amendment:* Updated Sections 5.1, 5.2, and 5.3 accordingly.

---

## Round 2 Verdict (`grok -m grok-4.7 --permission-mode plan`)

> **Ready for implementation.**
>
> The four Round 1 fixes match the code:
> - `FREEZE_ROUTE_NOTE` and the `RouteChip` import are still only in `apps/web/src/app/brief/page.tsx` (lines 4, 12, and 88), and Section 1 tells the implementer to remove both.
> - Section 3 specifies focus capture, initial focus on Cancel, Escape → `onCancel`, and restore on close or unmount. Section 4 has an explicit `tone` column that matches `opTone` and `OPS`.
> - The exclusion note names the clipboard control (`data-action="copy"` in `attempt-header.tsx`).
> - The `/v1` inventory matches `apps/api/server/routes/v1/`: six GET handlers, `GET /v1/attempts/:id` calls `reconcileAttempt.execute`, `POST /v1/attempts` runs `prepareBriefPackage` → `reserveExecutionCapacity` → `dispatchAttempt`, and forge is `POST /v1/forge` with kinds `merge-pr` and `push-and-open-pr`.
