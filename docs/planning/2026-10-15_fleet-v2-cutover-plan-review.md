# Grok 4.7 Review Receipt — Fleet v2 Cutover Plan (2026-10-15)

- **Reviewer Model:** `grok-4.7` (`grok -m grok-4.7 --permission-mode plan --no-subagents`)
- **Plan Reviewed:** `docs/planning/2026-10-15_fleet-v2-cutover-plan.md`
- **Final Verdict:** **Ready for implementation**

---

## Round 1 Findings & Refinements Applied

1. **CLI `--state-dir` Stripping & Runtime Precedence:**
   - *Finding:* `--state-dir` must be stripped before group dispatch and before `parseFlags` so it does not leak into the command payload; an explicitly injected `runtime` parameter must remain authoritative; normal paths that resolve cleanly via `path.resolve()` should not be rejected.
   - *Resolution:* Added `extractStateDirOption(argv, process.env.FLEET_STATE_DIR)` before group dispatch and kept `runtime ?? createFleetCliRuntime({ stateDir })`.
2. **Cross-Process Persistence of `acceptedReceiptByHead` and `resolveCoordinates`:**
   - *Finding:* Both `createFleetCliRuntime` and `configureFleetApiRuntime` kept `acceptedReceiptByHead` and `resolveCoordinates` only in process memory, causing multi-process CLI calls or restarted API processes sharing a `stateDir` to lose acceptance receipts and authorization coordinates.
   - *Resolution:* Persisted `<stateDir>/accepted-receipts.json` and `<stateDir>/authorization-coordinates.json` atomically (`writeFileSync` to temp file + `renameSync`) and reloaded before each check (also checking `evidenceAssessmentRepository.findAssessmentByHead(expectedHeadSha)`).
3. **501 vs Validation Error Split:**
   - *Finding:* Several use cases combined `!this.deps || typeof request !== 'object'` into `throw new Error(NOT_IMPLEMENTED)`, causing a configured runtime with an invalid/empty body to return HTTP `501`.
   - *Resolution:* Separated `if (!this.deps) throw new Error(NOT_IMPLEMENTED)` from request validation so configured use cases return structured domain rejections rather than `501`.
4. **Staging Exposure & Web `FLEET_API_URL` Binding:**
   - *Finding:* `apps/web` did not read `FLEET_API_URL`, and exposing a configured `FLEET_STATE_DIR` on `https://fleet-v2.midnight.lan/v1/*` without an authentication platform would expose mutating dispatch/forge routes on the LAN.
   - *Resolution:* Wired `process.env.FLEET_API_URL ?? process.env.NEXT_PUBLIC_FLEET_API_URL` into `createFleetWebApiClient` when `options.baseUrl` is `undefined`, and kept `deploy/staging/app.yaml` unconfigured by default.

---

## Round 2 Finding & Final Verification

- *Finding:* `POST /v1/verifications/:id/receipt`, `POST /v1/reviews/:id/receipt`, and `POST /v1/findings/:id/disposition` must not overwrite `body.assessmentId` with `:id`; `:id` is `receipt.id` or `disposition.findingId`.
- *Resolution:* Updated all three route mappings to leave `body.assessmentId` untouched and merge `:id` into `receipt.id` / `disposition.findingId` when the nested object is present.

### Final Grok 4.7 Verdict

> **Verdict: ready for implementation.** The remaining evidence-route finding is closed. The three receipt and disposition mappings now match the inbound contracts.
>
> `RecordVerificationReceiptRequest` and `RecordReviewReceiptRequest` take `assessmentId` plus `receipt`, and the receipt's own id is `receipt.id`. `RecordFindingDispositionRequest` takes `assessmentId` plus `disposition`, and the finding id is `disposition.findingId`. `receipt.assessmentId` and `disposition.assessmentId` stay separate fields on those records.
>
> The updated plan does that:
> - `POST /v1/verifications/:id/receipt` leaves `body.assessmentId` alone and writes `:id` into `receipt.id` only when `receipt` is a plain object.
> - `POST /v1/reviews/:id/receipt` does the same for `receipt.id`.
> - `POST /v1/findings/:id/disposition` leaves `body.assessmentId` alone and writes `:id` into `disposition.findingId` only when `disposition` is a plain object.
>
> The earlier gaps stay closed in this text: `--state-dir` stripping, an injected runtime staying authoritative, atomic `accepted-receipts.json` and `authorization-coordinates.json`, the 501-versus-validation split, `createFleetWebApiClient` reading `FLEET_API_URL` then `NEXT_PUBLIC_FLEET_API_URL`, staging left unpublished, and the pilot proof omitting a shared in-memory runtime.
