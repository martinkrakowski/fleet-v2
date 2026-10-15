# Improvement Plan: `/brief` Header Action Placement, Shared `@fleet/ui` `AlertBox`, Global Action Confirmations, and Unwired Action Inventory

- **Date:** 2026-10-15
- **Target Packages:** `@fleet/ui` (`packages/ui`), `@fleet/web` (`apps/web`)
- **Architecture & Boundary Compliance:** Pure UI component addition in `@fleet/ui` (`AlertBox`) and view-layer interaction updates in `@fleet/web`. No cross-context or hexagonal boundary changes required.

---

## 1. `/brief` View: Move `"Freeze the brief"` into `<PageHeader>` and Replace Duplicate `RouteChip`

### Current State
- In [`apps/web/src/app/brief/page.tsx`](../../apps/web/src/app/brief/page.tsx) (line 12 and line 88), `FREEZE_ROUTE_NOTE` is defined and `<PageHeader>` renders:
  ```tsx
  actions={<RouteChip gap>{FREEZE_ROUTE_NOTE}</RouteChip>}
  ```
- In [`apps/web/src/app/brief/components/proposal-table-card.tsx`](../../apps/web/src/app/brief/components/proposal-table-card.tsx) (lines 127–148), `<CardFooter>` (`<footer>`) renders the `"Freeze the brief"` `<Button>`, a second identical `<RouteChip gap>{FREEZE_ROUTE_NOTE}</RouteChip>`, and a `<Banner tone="neutral">`.

### Planned Change
1. In `apps/web/src/app/brief/page.tsx`:
   - Remove the now-unused `FREEZE_ROUTE_NOTE` constant (line 12) and `RouteChip` import from `page.tsx`.
   - Compute `includedCount` (`FIXTURE.proposals.filter((p) => Boolean(include[p.id])).length`) in `BriefPage`.
   - Replace `<RouteChip gap>{FREEZE_ROUTE_NOTE}</RouteChip>` inside `<PageHeader actions={...}>` with the `"Freeze the brief"` action `<Button variant="solid" tone="accent" disabled={isFrozen || includedCount === 0} onClick={() => setConfirmFreezeOpen(true)}>Freeze the brief</Button>`.
2. In `apps/web/src/app/brief/components/proposal-table-card.tsx`:
   - Remove the `"Freeze the brief"` `<Button>` from `<CardFooter>`, keeping the summary count (`{includedCount} of {proposals.length} rows included · freeze computes the digest · nothing changes after`) and the single `<RouteChip gap>{FREEZE_ROUTE_NOTE}</RouteChip>` in `<CardFooter>`.

---

## 2. Remove `<Banner>` Body Block from `/brief` `<footer>` and Move Text into `@fleet/ui` `AlertBox`

### Current State
- `<CardFooter>` in `apps/web/src/app/brief/components/proposal-table-card.tsx` (lines 143–147) renders:
  ```tsx
  <Banner tone="neutral">
    Freeze is its own step. Dispatch follows separately as a second button. Neither button
    fetches on this station: the live freeze route is not here, and the pending include and
    exclude choices above are client state until a freeze writes a digest.
  </Banner>
  ```

### Planned Change
1. Remove the `<Banner tone="neutral">...</Banner>` block from `<CardFooter>` in `apps/web/src/app/brief/components/proposal-table-card.tsx`.
2. Place that exact text (`"Freeze is its own step. Dispatch follows separately as a second button. Neither button fetches on this station: the live freeze route is not here, and the pending include and exclude choices above are client state until a freeze writes a digest."`) inside the new `@fleet/ui` `<AlertBox>` confirmation modal triggered when the operator clicks `"Freeze the brief"`.

---

## 3. New `@fleet/ui` Shared `AlertBox` Component

### Files
- `packages/ui/src/AlertBox.tsx`
- `packages/ui/src/AlertBox.module.css`
- Export in `packages/ui/src/index.ts`

### Contract & Behavior
```tsx
export interface AlertBoxProps {
  open: boolean;
  tone?: SemanticTone;
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
  style?: CSSProperties;
}
```
- When `open` is `false`, renders `null`.
- When `open` is `true`, renders a modal overlay backdrop (`role="presentation"`, clicking backdrop calls `onCancel`) and an accessible dialog box (`role="alertdialog"`, `aria-modal="true"`, `aria-labelledby`, `aria-describedby`) with:
  - Tone-accented left border bar matching `Banner.module.css` (`toneNeutral`, `toneAccent`, `toneOk`, `toneWarn`, `toneDanger`, `toneDecision`).
  - Header title (`title`) and optional `meta` badge/route chip.
  - Body container (`children`) displaying the action explanation (such as the moved `/brief` banner body text).
  - Footer action row with a `Cancel` `<Button ref={cancelButtonRef} variant="outline" tone="neutral" onClick={onCancel}>` and a submit/confirm `<Button variant="solid" tone={tone === 'neutral' ? 'accent' : tone} onClick={onConfirm}>` (`confirmLabel ?? "Confirm"`).
  - **Keyboard & Focus Management:**
    - When `open` transitions to `true`, capture `document.activeElement` in `previousFocusRef` and move initial focus to the `Cancel` button (`cancelButtonRef.current?.focus()`), which is the safest default control in a confirmation `alertdialog`.
    - Pressing `Escape` while `open` is `true` invokes `onCancel()`.
    - When `open` transitions back to `false` (on cancel or confirm) or on unmount while open, restore focus to `previousFocusRef.current?.focus()` if it is still connected in the DOM.

---

## 4. Spawn `AlertBox` Confirmation on Every Action Button in `@fleet/web`

Every domain action button across `/brief`, `/attempt`, and `/knowledge` will open `<AlertBox>` before executing its action, carrying the triggering button's semantic `tone`, describing the action, and allowing the user to cancel:

| View | Component | Action Button(s) | `AlertBox` `tone` | Confirmation `AlertBox` Title & Body Description | Buttons |
|---|---|---|---|---|---|
| `/brief` | `apps/web/src/app/brief/page.tsx` | **Freeze the brief** (in `<PageHeader>`) | `"accent"` | **Title:** `Freeze the brief for ${sel}`<br>**Body:** `Freeze is its own step. Dispatch follows separately as a second button. Neither button fetches on this station: the live freeze route is not here, and the pending include and exclude choices above are client state until a freeze writes a digest.` | `Cancel`, `Freeze the brief` |
| `/brief` | `apps/web/src/app/brief/components/frozen-brief-card.tsx` | **Dispatch the intent** | `"accent"` | **Title:** `Dispatch frozen brief (${digest})`<br>**Body:** `The brief package is frozen; dispatching records the intent so the Line holds it until a slot frees. Neither button fetches on this station: the live freeze and dispatch routes are not wired here, so confirming records client state only.` | `Cancel`, `Dispatch the intent` |
| `/attempt` | `apps/web/src/app/attempt/components/operations-sidebar.tsx` | **Reconcile**, **Stop**, **Collect artifacts**, **Start fix**, **Merge** | `opTone(op)` (`"danger"` for `stop`, `"ok"` for `merge`, `"neutral"` for `reconcile`/`collect`/`fix`) | **Title:** `${OP_LABELS[op]} · ${attempt.id}`<br>**Body:** `${OP_DESC[op]} This station is not wired to the live runner or forge mutation routes yet; confirming records the operator's confirmed action intent in this browser without mutating remote runner state.` | `Cancel`, `${OP_LABELS[op]}` |
| `/knowledge` | `apps/web/src/app/knowledge/components/candidate-card.tsx` | **Accept**, **Reject**, **Leave unresolved**, **Propose a policy change** | `OPS[kind].tone` (`"ok"` for `accept`, `"danger"` for `reject`, `"neutral"` for `unresolved`, `"decision"` for `policy`) | **Title:** `${OPS[kind].label} · ${cand.id}`<br>**Body:** `Candidate claim: "${cand.claim}". Confirming "${OPS[kind].label}" records this disposition in this browser only; no keeper or policy file is written until the station is wired to POST /v1/knowledge/${cand.id}/disposition.` | `Cancel`, `${OPS[kind].label}` |

*(Note: Immediate UI chrome and navigation controls—theme toggle in `theme-toggle.tsx`, sidebar drawer toggle in `topbar.tsx`, project/view navigation in `sidebar.tsx` & `project-nav.tsx`, clipboard ID copy button `data-action="copy"` in `attempt-header.tsx`, filter switches/selects in `lanes-toolbar.tsx`, proposal row include switches in `proposal-table-card.tsx`, and row selection in `lane-row.tsx` & `work-order-list-card.tsx`—remain immediate view controls rather than domain action mutations.)*

---

## 5. Inventory of Actions & Routes in `fleet-v2` Not Yet Implemented or Wired-In

### 5.1 Web UI Action Buttons & Read Views Currently Operating on Client/Fixture State Only (Not Wired to `@fleet/api` `/v1/*`)
Although `@fleet/api` exposes `/v1/*` routes and `apps/web/src/lib/api-client.ts` (`createFleetWebApiClient`) implements 5 read helpers (`fetchWorkOrderView` -> `GET /v1/work-orders/:id`, `fetchAttemptView` -> `GET /v1/attempts/:id`, `fetchHeadEvidenceView` -> `GET /v1/heads/:sha/evidence`, `fetchCoordinationView` -> `GET /v1/coordination`, `fetchAttentionView` -> `GET /v1/attention`), the 4 Next.js page views (`/lanes`, `/attempt`, `/brief`, `/knowledge`) currently read static `FIXTURE` modules and mutate local React state (`useState`) rather than calling `api-client.ts`:

1. **`/brief` — Freeze the brief:**
   - Currently computes a client-side FNV-1a digest (`clientDigest`) in `apps/web/src/app/brief/page.tsx`.
   - Not yet wired to `POST /v1/knowledge/selections` (`RecordContextSelectionUseCase`); in `@fleet/api`, `PrepareBriefPackageUseCase` currently runs inside `POST /v1/attempts` (`apps/api/server/routes/v1/attempts/index.post.ts`) alongside capacity reservation and dispatch rather than as a standalone freeze endpoint.
2. **`/brief` — Dispatch the intent:**
   - Currently sets local `dispatchedWo` state and displays a warning banner (`"No request left this station"`).
   - Not yet wired to `POST /v1/attempts` (`apps/api/server/routes/v1/attempts/index.post.ts`, which sequences `prepareBriefPackage`, `reserveExecutionCapacity`, and `dispatchAttempt`).
3. **`/brief` — Retrieval proposals table:**
   - Currently renders static `FIXTURE.proposals`.
   - Not yet wired to `POST /v1/knowledge/proposals` (`ProposeBriefContextUseCase`).
4. **`/attempt` — Reconcile operation button:**
   - Currently renders `<Button data-action="op" data-op="reconcile">` in `OperationsSidebar` without calling the API.
   - Not yet wired to `GET /v1/attempts/:id` (`apps/api/server/routes/v1/attempts/[id].get.ts`, which invokes `reconcileAttempt.execute` and is exposed as `fetchAttemptView` in `apps/web/src/lib/api-client.ts`).
5. **`/attempt` — Stop operation button:**
   - Currently renders `<Button data-action="op" data-op="stop">` without calling the API.
   - Not yet wired to `POST /v1/attempts/:id/stop` (`apps/api/server/routes/v1/attempts/[id]/stop.post.ts` -> `StopAttemptUseCase`).
6. **`/attempt` — Collect artifacts operation button:**
   - Currently renders `<Button data-action="op" data-op="collect">` without calling the API.
   - Not yet wired to `POST /v1/attempts/:id/artifacts` (`apps/api/server/routes/v1/attempts/[id]/artifacts.post.ts` -> `CollectAttemptArtifactsUseCase`).
7. **`/attempt` — Start fix operation button:**
   - Currently renders `<Button data-action="op" data-op="fix">` without calling the API.
   - Not yet wired to `POST /v1/attempts/:id/fix` (`apps/api/server/routes/v1/attempts/[id]/fix.post.ts` -> `PrepareFixAttemptUseCase`).
8. **`/attempt` — Merge operation button:**
   - Currently renders `<Button data-action="op" data-op="merge">` without calling the API.
   - Not yet wired to `POST /v1/forge` (`apps/api/server/routes/v1/forge/index.post.ts` -> `ExecuteAuthorizedForgeActionUseCase` with `kind: "merge-pr"`).
9. **`/knowledge` — Candidate disposition buttons (`Accept`, `Reject`, `Leave unresolved`, `Propose a policy change`):**
   - Currently updates local React state `dispositions[cand.id]` (`"recorded in this browser only"`).
   - Not yet wired to `POST /v1/knowledge/:id/disposition` (`apps/api/server/routes/v1/knowledge/[id]/disposition.post.ts` -> `DecideKnowledgeDispositionUseCase`) or `POST /v1/knowledge/:id/publish` (`PublishAcceptedKeeperUseCase`).
10. **Page-Level Read Hydration Across `/lanes`, `/attempt`, `/brief`, and `/knowledge`:**
    - None of the 4 page components currently call `createFleetWebApiClient()` on mount/interval (`fetchWorkOrderView`, `fetchAttemptView`, `fetchHeadEvidenceView`, `fetchCoordinationView`, `fetchAttentionView`), nor `GET /v1/capabilities` (`apps/api/server/routes/v1/capabilities.get.ts`).

### 5.2 Missing Read/List/Standalone API Endpoints Flagged as `gap · ...` in `@fleet/web`
These endpoints are explicitly badged as gaps in the UI and have no route handler in `apps/api/server/routes/v1/` yet:

1. **`GET /v1/attempts` (Attempt List Route):**
   - Flagged on `/lanes` header (`gap · no list route: GET /v1/attempts is missing`). Note: single-attempt `GET /v1/attempts/:id` (`attempts/[id].get.ts`) **does** exist and runs `reconcileAttempt.execute`, and `GET /v1/work-orders/:id` (`work-orders/[id].get.ts`) returns `{ workOrder, attempts, journal }` for one work order, but there is no cross-project `GET /v1/attempts` list route.
2. **`GET /v1/capacity`:**
   - Flagged on `/lanes` `CapacityCard` (`gap · no capacity route`). No read endpoint exposes current host slot occupancy across all work orders.
3. **`POST /v1/briefs` & `GET /v1/briefs/:workOrderId` (Standalone Freeze & Frozen Brief Package Read Routes):**
   - Flagged on `/brief` (`gap · the live freeze route is not on this station` and `gap · no package read` on `BriefManifestCard` and `FrozenBriefCard`). `PrepareBriefPackageUseCase` is currently invoked inside `POST /v1/attempts` rather than a standalone freeze route, and no GET route returns a frozen `.lane/brief.md` + `.lane/brief-manifest.json` package.
4. **`GET /v1/knowledge/candidates` and `GET /v1/knowledge/keepers` (Knowledge List Routes):**
   - Flagged on `/knowledge` header (`gap · list routes are not on this station`). No GET route lists candidate notes or published keepers by project.

### 5.3 Backend Use Cases / API Routes Implemented in `@fleet/api` & `@fleet/cli` Without Web UI Controls
These routes exist under `apps/api/server/routes/v1/` (and in `@fleet/cli`), but have no forms or buttons in `@fleet/web`:

1. **Work Order Registration:** `POST /v1/work-orders` (`apps/api/server/routes/v1/work-orders/index.post.ts` -> `RegisterWorkOrderUseCase`).
2. **Request Attempt Acceptance:** `POST /v1/attempts/:id/acceptance` (`apps/api/server/routes/v1/attempts/[id]/acceptance.post.ts` -> `RequestAttemptAcceptanceUseCase`).
3. **Forge Push & Open PR:** `POST /v1/forge` (`apps/api/server/routes/v1/forge/index.post.ts` -> `ExecuteAuthorizedForgeActionUseCase` with `kind: "push-and-open-pr"`).
4. **Evidence & Acceptance Controls:**
   - `POST /v1/verifications` (`apps/api/server/routes/v1/verifications/index.post.ts` -> `RequestVerificationUseCase`)
   - `POST /v1/verifications/:id/receipt` (`apps/api/server/routes/v1/verifications/[id]/receipt.post.ts` -> `RecordVerificationReceiptUseCase`)
   - `POST /v1/reviews` (`apps/api/server/routes/v1/reviews/index.post.ts` -> `RequestIndependentReviewUseCase`)
   - `POST /v1/reviews/:id/receipt` (`apps/api/server/routes/v1/reviews/[id]/receipt.post.ts` -> `RecordReviewReceiptUseCase`)
   - `POST /v1/findings/:id/disposition` (`apps/api/server/routes/v1/findings/[id]/disposition.post.ts` -> `RecordFindingDispositionUseCase`)
   - `POST /v1/heads/:sha/assessment` (`apps/api/server/routes/v1/heads/[sha]/assessment.post.ts` -> `AssessHeadAcceptanceUseCase`)
5. **Knowledge Lifecycle Controls (Beyond Disposition):**
   - `POST /v1/attempts/:id/notes` (`apps/api/server/routes/v1/attempts/[id]/notes.post.ts` -> `CaptureCompletedAttemptNotesUseCase`)
   - `POST /v1/knowledge/checks` (`apps/api/server/routes/v1/knowledge/checks.post.ts` -> `CheckKnowledgeClaimUseCase`)
   - `POST /v1/knowledge/selections` (`apps/api/server/routes/v1/knowledge/selections.post.ts` -> `RecordContextSelectionUseCase`)
   - `POST /v1/knowledge/:id/publish` (`apps/api/server/routes/v1/knowledge/[id]/publish.post.ts` -> `PublishAcceptedKeeperUseCase`)
   - `POST /v1/knowledge/:id/reuse` (`apps/api/server/routes/v1/knowledge/[id]/reuse.post.ts` -> `RecordKnowledgeReuseUseCase`)
   - `POST /v1/knowledge/:id/supersede` (`apps/api/server/routes/v1/knowledge/[id]/supersede.post.ts` -> `SupersedeKnowledgeEntryUseCase`)
6. **Operator Coordination Controls:**
   - `POST /v1/projects` (`apps/api/server/routes/v1/projects/index.post.ts` -> `RegisterProjectProfileUseCase`)
   - `GET /v1/capabilities` (`apps/api/server/routes/v1/capabilities.get.ts` -> `InspectConfiguredCapabilitiesUseCase`)
   - `POST /v1/decisions` (`apps/api/server/routes/v1/decisions/index.post.ts` -> `RequestScopedDecisionUseCase`)
   - `POST /v1/authorizations/resolve` (`apps/api/server/routes/v1/authorizations/resolve.post.ts` -> `ResolveActionAuthorizationUseCase`)
   - `POST /v1/authorizations/:id/consume` (`apps/api/server/routes/v1/authorizations/[id]/consume.post.ts` -> `RecordAuthorizationConsumptionUseCase`)
   - `POST /v1/observations` (`apps/api/server/routes/v1/observations/index.post.ts` -> `PublishProjectObservationUseCase`)
   - `POST /v1/relays` (`apps/api/server/routes/v1/relays/index.post.ts` -> `SendFleetRelayUseCase`)
   - `POST /v1/relays/:id/acknowledgement` (`apps/api/server/routes/v1/relays/[id]/acknowledgement.post.ts` -> `RecordRelayAcknowledgementUseCase`)
7. **Live External Transports Intentionally Stubbed Until Host Wiring:**
   - `AttentionReadAdapter` (`GET /v1/attention` returns `unavailable` until an external attention reader is bound).
   - `VerificationExecutorAdapter` and `IndependentReviewAdapter` (report `unknown` / `unavailable` until remote verification/review hosts are bound; operators record receipts via `record-verification` / `record-review`).
   - `Staging K8s API Runtime` (`deploy/staging/app.yaml` currently deploys `@fleet/web` without `FLEET_STATE_DIR` / `FLEET_API_URL` so unauthenticated LAN requests cannot trigger live `ocm-run` or `gh` subprocesses).
