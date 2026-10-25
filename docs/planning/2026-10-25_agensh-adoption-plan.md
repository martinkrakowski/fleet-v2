# Plan: three ideas from microsoft/Agensh

- **Date:** 2026-10-25
- **Target repository:** `fleet-v2`
- **Status:** draft for the owner's decisions (§6). Nothing built. Anchors checked against `main` on 2026-10-25 (§2).
- **Owner request (2026-10-25):** "Make a list of features we can pull into fleet-v2", then "write it up". This follows a read-only review of [microsoft/Agensh](https://github.com/microsoft/Agensh): MIT licence, v1.0 of 2026-10-23, a research harness that runs up to 1,024 Copilot agents with no central orchestrator. The review found ten candidate features. This plan takes the three that fit fleet-v2's rules and are cheapest to prove. The other seven are listed in §3.4.
- **Builds on:** `2026-10-24_live-updates-and-state-resilience-plan.md` (§3.6 safe worktree removal; E1 quarantine, check and restore, merged in #180–#202).

## 1. Goal

1. **No placeholder evidence.** A receipt or disposition whose evidence says "tbd", "should work", "looks right", "n/a" or nothing at all is refused at the domain boundary. This turns "model confidence is never evidence" from a rule in prose into a check.
2. **Fix rounds know what already failed.** A fresh fix-round session starts with no memory of the round before. A short, bounded list of approaches that were tried and disproved enters its frozen brief, so it does not repeat them.
3. **Nothing is torn down before it is sealed.** Artifact collection writes a manifest (sizes and SHA-256 of what was kept) atomically. Worktree removal is refused until that manifest exists and checks out.

## 2. What exists (checked 2026-10-25)

| Area | On `main` | Gap |
|---|---|---|
| Evidence records | `packages/evidence-and-acceptance/src/domain/evidence-records.ts`: receipts carry `evidenceRef`, review findings carry `summary`, and dispositions carry `reason`; entities in `domain/entities/{ReviewReceipt,VerificationReceipt,FindingDisposition}.ts`. The constructors already reject empty or whitespace-only `evidenceRef`, finding `summary` and disposition `reason` | Placeholder text ("should work", "tbd", "n/a") is accepted. Placeholder detection is the new check |
| Knowledge entries | `packages/brief-knowledge/src/domain/knowledge-records.ts`: `KnowledgeEntryRecord` with `claimText`, disposition, checks, triage flag | No notion of claim kind. A disproved approach cannot be told apart from a fact, so context selection cannot give it to the next round |
| Artifact collection | `work-execution` `CollectAttemptArtifactsPort` (in) and `AttemptArtifactPort` (out): "bounded immutable artifacts after lane completion" | No sealed manifest proving what was collected before anything is removed |
| Worktree removal | Not built. `WorkspacePort.removeWorktree` is host-programs plan P5; its safety rules are in the live-updates plan §3.6 | Nothing yet ties removal to proven collection |

## 3. The shape

### 3.1 Placeholder evidence (evidence-and-acceptance, domain)

- **Rejecter:** a pure function `isPlaceholderEvidence(text: string): boolean` in `packages/evidence-and-acceptance/src/domain/`. After trimming and lower-casing, it is true when the text is empty or starts with one of a fixed, exported list: `tbd`, `todo`, `n/a`, `na`, `none`, `should work`, `looks right`, `looks good`, `lgtm`, `probably`, `i think`, `seems`. Matching is whole-word at the start; it never matches inside a word. This is adapted from Agensh's `board-service/verifier.py`, 56 lines, MIT; credited in a header comment if code is copied rather than re-written.
- **Where it applies:**
  - `ReviewReceipt`: `evidenceRef` and each finding's `summary`.
  - `VerificationReceipt`: `evidenceRef` only. Its props have no `summary`.
  - `FindingDisposition`: `evidenceRef`, where present, and `reason`.

  Empty values are already refused today; this adds placeholder text. The refusal names the field, never echoes the value (the value may be long or credential-shaped).
- **Records already on disk.** A stored receipt that fails the new check would make its store unreadable, so it would be quarantined (E1). Default (D1): the check applies to **new** writes only. The reader keeps the old shape-only validation. A later lane may tighten the readers after `state check` shows no store would be affected.

### 3.2 "Already failed" notes in fix-round briefs (brief-knowledge)

- **New field:** `claimKind` on `KnowledgeEntryRecord`, one of `fact`, `observed` or `failed`. It is optional, so existing records load as `fact`.
- **What a `failed` entry is:** "approach X was tried and disproved because Y". It has the same attribution (source attempt, commit, checker) and the same keeper path as any claim: capture proposes, only a check and disposition accept it. Nothing passes live between workers.
- **Length:** `claimText` for `failed` is capped at 300 characters. Detail goes in the source attempt's artifacts, referenced by the existing `sourceAttemptId`. This follows Agensh's capped notes with full text behind a label.
- **Context selection:** for a fix-round brief on work order W, while preparing attempt N:
  1. Take the attempt ids from `AttemptRepositoryPort.listAttemptsByWorkOrder(W)` (creation order) that come before N.
  2. Select the `failed` entries whose `sourceAttemptId` is one of those ids, `disposition` is accepted and `supersededById` is null.
  3. Order them by the source attempt's position in that list, newest attempt first; within one attempt, by the entry's `createdAtIso`, newest first.
  4. Take at most 10.

  Entries from other work orders are never selected. They go in their own brief section, "Already tried and disproved; do not repeat", which counts toward the brief's size budget.
- **Capture:** the orchestrator, or a reviewer's numbered finding marked "disproved", proposes a `failed` candidate through the existing capture use case only when the finding states both the approach tried and the reason it failed. The candidate's `claimText` holds the two parts in the §3.2 form. A finding without both parts is not proposed. No new port.

### 3.3 Sealed artifact manifest before teardown (work-execution)

- **Writing the manifest:** `CollectAttemptArtifacts` finishes by writing `artifacts-manifest.json`:
  - the attempt id;
  - one entry per collected file: relative path, size and SHA-256;
  - the total.

  It is written with `writeJsonAtomically` (temp file, then rename) and then read back to confirm it. Only then is the collection reported complete. This is Agensh's `agent/archive.py` pattern: the manifest is complete only after size and digest are recorded and the write is atomic.
- **A new check:** `verifyArtifactManifest(attemptId)` re-hashes every listed file and returns `sealed`, `missing` or `mismatch`.
- **Gating removal:** `WorkspacePort.removeWorktree` (host-programs P5, live-updates §3.6) gets one more precondition. It refuses unless the attempt's manifest verifies as `sealed`. Without a manifest the reason is `artifacts not collected`; on a mismatch it is `artifacts changed since collection`. A manual override exists only through `--force-unsealed`. The flag alone bypasses nothing: removal also needs an owner approval through the existing authorization path (an owner question answered with a decision), scoped to this one removal (the attempt id and worktree path). The removal's journal entry records that approval's reference.

### 3.4 Not in this plan

Kept for later, as ideas only:
- boolean search over knowledge (brief-knowledge retrieval, migration step 6);
- showing expired claims as stale on reservations (shown only, never released: unknown state never frees capacity);
- a durable outbox delivery state machine;
- deadline reminders in the 45-minute lane brief template;
- an explicit list of allowed variables in brief rendering;
- run provenance in `doctor`.

Rejected, because each conflicts with fleet-v2's rules:
- peer self-organisation and agents merging their own work;
- notes passed between live workers mid-turn;
- credentials or token files on worker hosts;
- tool deny-lists in place of runtime isolation;
- the Gitea, Mattermost and MySQL stack;
- console logging in service code.

## 4. Workbook

| Lane | Scope | Tier | Depends on |
|---|---|---|---|
| A1 | `isPlaceholderEvidence` plus its tests (table of accepted and refused strings, whole-word rule) | 1 | none |
| A2 | Wire A1 into the three evidence constructors for new writes; API and CLI refusal messages name the field | 2 (user-facing) | A1 |
| B1 | `claimKind` on knowledge records (optional, default `fact`), the 300-character cap for `failed`, record and parity tests | 2 (data) | none |
| B2 | Context selection adds the "Already tried and disproved" section to fix-round briefs; brief size budget test | 2 | B1 |
| C1 | `artifacts-manifest.json` written atomically by collection; `verifyArtifactManifest`; tests for sealed, missing and mismatch | 2 (data) | none |
| C2 | `removeWorktree` refuses without a sealed manifest | 2 | C1, host-programs P5 |

Each lane follows the standard pipeline: Mercury-3, gate, Grok, Argon fix rounds, the Fable pass on Tier 2. A1, B1 and C1 are independent and can run in parallel.

## 5. Hard to undo

- **A2 refuses writes the system accepts today.** A tool or script that writes "n/a" summaries will start failing. This is a two-way door, since the list is one constant, but a visible behaviour change. D2 decides whether it ships behind a warning first.
- **B1 adds a field to stored knowledge records.** It is optional and defaults on read, so it can be undone, but records written with it stay written.

## 6. Decisions for the owner

| # | Question | Default |
|---|---|---|
| D1 | Does the placeholder check also apply to receipts already stored? | **No:** new writes only. Tighten readers later, after `state check` |
| D2 | Should placeholder evidence be refused outright, or warned about for a while first? | **Refuse.** Receipts are written by the orchestrator, not by end users |
| D3 | Who may propose a `failed` note? | **The orchestrator and reviewers.** Never a lane about itself |
| D4 | What overrides the sealed-manifest gate on worktree removal? | **`--force-unsealed` plus an owner approval** scoped to that removal through the existing authorization path; the journal records the approval's reference |
| D5 | Copy Agensh's verifier code (MIT, with credit), or re-write it from the idea? | **Re-write.** It is 56 lines of Python; a TypeScript domain function is simpler written fresh |

## 7. Assumptions

- **The phrase list:** a fixed list catches the common placeholders without refusing real evidence. It might fail on an honest summary that starts with "Seems …" followed by real proof. The whole-word, start-only rule and the D2 default bound that; the list is one exported constant.
- **Disproved approaches reach later rounds:** fix rounds in this pipeline do fail on repeated dead ends often enough to pay for B1–B2. If they rarely do, B2's section stays empty and costs nothing.
- **Host-programs P5 lands:** C2 assumes `removeWorktree` is built. Until then C1 stands alone as proof of what collection kept.

## Challenge this

Is §3.2 worth a new field? The cheaper alternative is to write disproved approaches as plain prose into each fix-round handover brief, which the orchestrator already does by hand. B1–B2 make it structured, kept and selectable across sessions, but they add a data-model change for something a human-written brief already carries.
