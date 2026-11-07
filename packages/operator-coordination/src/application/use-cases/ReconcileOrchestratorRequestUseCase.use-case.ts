/**
 * ReconcileOrchestratorRequestUseCase implements ReconcileOrchestratorRequestPort.
 * It reconciles one stored orchestrator request against the K1b journal key
 * `request/<requestId>` for exactly four kinds — `start-lane-run`,
 * `prepare-fix`, `request-review`, `resume-run` — in three closed actions:
 * `claim` (gate the kind, session and dispatcher host, then claim), `record-intent`
 * (append the full request digest before any caller would act), and `record-result`
 * (append the result after). The use case never starts a run, prepares a fix,
 * requests a review or resumes a run; it only claims and journals. Every other
 * stored kind, including `dispatch-attempt`, is refused `policy` and writes
 * nothing. The clock, the digest function and the entry-id mint are injected; a
 * request body never supplies "now". Results carry fixed codes only, never
 * paths, hosts, journal detail or error messages.
 */

import { containsSecretShape } from '@fleet/shared';

import {
  OrchestratorRequest,
  ORCHESTRATOR_REQUEST_CLAIM_LEASE_SECONDS,
  ORCHESTRATOR_REQUEST_ID_PATTERN,
  isOrchestratorRequestClaimable,
} from '../../domain/entities/OrchestratorRequest.js';
import type {
  OrchestratorRequestRefusalCode,
  OrchestratorRequestResult,
} from '../../domain/entities/OrchestratorRequest.js';
import {
  ORCHESTRATOR_REQUEST_LINK_KEY,
  ORCHESTRATOR_REQUEST_REASON_KINDS,
} from '../../domain/orchestrator-request-records.js';
import type { OrchestratorRequestRecord } from '../../domain/orchestrator-request-records.js';
import type { OrchestratorRequestKind } from '../../domain/orchestrator-session-records.js';
import { readPlainObject } from '../../domain/record-input.js';
import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import type { OrchestratorRequestRepositoryPort } from '../ports/out/OrchestratorRequestRepositoryPort.out-port.js';
import type {
  OrchestratorSessionRepositoryPort,
  StoredOrchestratorSession,
} from '../ports/out/OrchestratorSessionRepositoryPort.out-port.js';
import type { ProjectProfileRepositoryPort } from '../ports/out/ProjectProfileRepositoryPort.out-port.js';
import type {
  OrchestratorRequestJournalEntry,
  OrchestratorRequestJournalPort,
} from '../ports/out/OrchestratorRequestJournalPort.out-port.js';
import type {
  ReconcileOrchestratorRequestPort,
  ReconcileOrchestratorRequestResult,
} from '../ports/in/ReconcileOrchestratorRequestPort.in-port.js';

export interface ReconcileOrchestratorRequestDependencies {
  readonly requestRepo: OrchestratorRequestRepositoryPort;
  readonly sessionRepo: OrchestratorSessionRepositoryPort;
  readonly profileRepo: ProjectProfileRepositoryPort;
  readonly journal: OrchestratorRequestJournalPort;
  readonly clock: { readonly nowIso: () => string };
  readonly hashDigest: (canonical: string) => string;
  readonly mintEntryId: () => string;
}

/** The four kinds this use case enables (plan §3.6, O2c). */
const ENABLED_KINDS: readonly OrchestratorRequestKind[] = [
  'start-lane-run',
  'prepare-fix',
  'request-review',
  'resume-run',
];

const CLAIM_BODY_KEYS = ['requestId', 'orchestratorId', 'expectedRevision'] as const;
const INTENT_BODY_KEYS = [...CLAIM_BODY_KEYS, 'fence'] as const;
const RESULT_BODY_KEYS = [
  ...INTENT_BODY_KEYS,
  'outcome',
  'reasonCode',
  'reasonKind',
  'linkedId',
] as const;

const SAVE_LOCK_TIMEOUT_MS = 10_000;
const JOURNAL_KEY_PREFIX = 'request/';
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/;
const RESULT_OUTCOMES = ['completed', 'refused', 'not-started', 'ambiguous'] as const;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ID_MAX_BYTES = 256;

type ReconcileAction = 'claim' | 'record-intent' | 'record-result';

function isValidId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength <= ID_MAX_BYTES &&
    !containsSecretShape(value)
  );
}

function refused(code: string, requestId: string | null): ReconcileOrchestratorRequestResult {
  return { outcome: 'refused', code, requestId };
}

function unknown(code: string, requestId: string | null): ReconcileOrchestratorRequestResult {
  return { outcome: 'unknown', code, requestId };
}

function invalidRequest(): ReconcileOrchestratorRequestResult {
  return { outcome: 'refused', code: 'invalid-request', requestId: null };
}

export class ReconcileOrchestratorRequestUseCase implements ReconcileOrchestratorRequestPort {
  constructor(private readonly deps?: ReconcileOrchestratorRequestDependencies) {}

  async execute(action: unknown, body: unknown): Promise<ReconcileOrchestratorRequestResult> {
    // Unconfigured is 501 and is checked before any body validation.
    if (!this.deps) {
      throw new Error('Not implemented: ReconcileOrchestratorRequestUseCase');
    }
    // A configured call wraps the whole body: a throw that is not a typed
    // result is `refused` / `invalid-request` and the message is dropped.
    try {
      return await this.executeAction(action, body);
    } catch {
      return invalidRequest();
    }
  }

  private depsRequired(): ReconcileOrchestratorRequestDependencies {
    if (!this.deps) {
      throw new Error('Not implemented: ReconcileOrchestratorRequestUseCase');
    }
    return this.deps;
  }

  private async executeAction(action: unknown, body: unknown): Promise<ReconcileOrchestratorRequestResult> {
    let actionName: ReconcileAction;
    if (action === 'claim') {
      actionName = 'claim';
    } else if (action === 'record-intent') {
      actionName = 'record-intent';
    } else if (action === 'record-result') {
      actionName = 'record-result';
    } else {
      return invalidRequest();
    }
    const keys =
      actionName === 'claim'
        ? CLAIM_BODY_KEYS
        : actionName === 'record-intent'
          ? INTENT_BODY_KEYS
          : RESULT_BODY_KEYS;
    const input = readPlainObject(body, keys);
    if (input === null) {
      return invalidRequest();
    }
    if (!this.validateBody(actionName, input)) {
      return invalidRequest();
    }
    if (actionName === 'claim') {
      return this.executeClaim(input);
    }
    if (actionName === 'record-intent') {
      return this.executeRecordIntent(input);
    }
    return this.executeRecordResult(input);
  }

  private validateBody(action: ReconcileAction, input: Record<string, unknown>): boolean {
    if (typeof input.requestId !== 'string') {
      return false;
    }
    if (!ORCHESTRATOR_REQUEST_ID_PATTERN.test(input.requestId)) {
      return false;
    }
    if (!isValidId(input.orchestratorId)) {
      return false;
    }
    if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) {
      return false;
    }
    if (action === 'claim') {
      return true;
    }
    if (!Number.isSafeInteger(input.fence) || (input.fence as number) < 1) {
      return false;
    }
    if (action === 'record-intent') {
      return true;
    }
    if (!RESULT_OUTCOMES.includes(input.outcome as (typeof RESULT_OUTCOMES)[number])) {
      return false;
    }
    const outcome = input.outcome as (typeof RESULT_OUTCOMES)[number];
    if (input.reasonCode !== null) {
      if (typeof input.reasonCode !== 'string' || !REASON_CODE_PATTERN.test(input.reasonCode)) {
        return false;
      }
    }
    if (input.reasonKind !== null) {
      if (!ORCHESTRATOR_REQUEST_REASON_KINDS.includes(input.reasonKind as never)) {
        return false;
      }
    }
    // A refused transition needs its typed reason kind: `refuse` rejects a
    // null reason kind, so accepting one here would append a final result the
    // request can never be moved by (fix round 1, item 1).
    if (outcome === 'refused' && input.reasonKind === null) {
      return false;
    }
    if (outcome === 'completed') {
      if (!isValidId(input.linkedId)) {
        return false;
      }
    } else if (input.linkedId !== null) {
      return false;
    }
    return true;
  }

  private nowIso(): string {
    return this.depsRequired().clock.nowIso();
  }

  /** The canonical closed payload, in this key order only (O2c). */
  private canonicalRequest(record: OrchestratorRequestRecord): string {
    return JSON.stringify({
      requestId: record.requestId,
      kind: record.kind,
      projectId: record.projectId,
      target: record.target,
      requestedBy: { via: record.requestedBy.via, sessionId: record.requestedBy.sessionId },
      createdAtIso: record.createdAtIso,
      expiresAtIso: record.expiresAtIso,
    });
  }

  /** The full SHA-256 hex digest; null when the injected function throws or is not 64 hex. */
  private computeDigest(record: OrchestratorRequestRecord): string | null {
    let digest: unknown;
    try {
      digest = this.depsRequired().hashDigest(this.canonicalRequest(record));
    } catch {
      return null;
    }
    if (typeof digest !== 'string' || !DIGEST_HEX_PATTERN.test(digest)) {
      return null;
    }
    return digest;
  }

  private async executeClaim(input: Record<string, unknown>): Promise<ReconcileOrchestratorRequestResult> {
    const deps = this.depsRequired();
    const requestId = input.requestId as string;
    const orchestratorId = input.orchestratorId as string;
    const expectedRevision = input.expectedRevision as number;

    const load = await deps.requestRepo.get(requestId);
    if (load.outcome === 'missing') {
      return refused('not-found', requestId);
    }
    if (load.outcome !== 'found') {
      return unknown('unreadable-request', requestId);
    }
    const record = load.request;

    if (!ENABLED_KINDS.includes(record.kind)) {
      return refused('policy', requestId);
    }

    const gate = await this.sessionGate(record.kind, orchestratorId, record.projectId, requestId);
    if (!gate.ok) {
      return gate.result;
    }

    const journalRead = await deps.journal.read(JOURNAL_KEY_PREFIX + requestId);
    if (journalRead.outcome === 'unknown') {
      return unknown('unreadable-journal', requestId);
    }
    const entries = journalRead.entries;

    const digest = this.computeDigest(record);
    if (digest === null) {
      return unknown('digest-failed', requestId);
    }

    const finalResult = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous');
    if (finalResult !== undefined) {
      const intent = entries.find((entry) => entry.kind === 'intent');
      if (
        intent === undefined ||
        intent.digest === null ||
        !DIGEST_HEX_PATTERN.test(intent.digest) ||
        intent.digest !== digest
      ) {
        return unknown('digest-failed', requestId);
      }
      if (record.state === 'dispatched') {
        return { outcome: 'already-dispatched', requestId };
      }
      if (record.state === 'refused') {
        return { outcome: 'already-refused', requestId };
      }
      const reconciled = await this.reconcileFinalTransition(record, finalResult, requestId);
      if (!reconciled.ok) {
        return reconciled.result;
      }
      return reconciled.outcome === 'already-refused'
        ? { outcome: 'already-refused', requestId }
        : { outcome: 'already-dispatched', requestId };
    }

    const intentEntry = entries.find((entry) => entry.kind === 'intent');
    if (intentEntry !== undefined) {
      const claim = record.claim;
      if (
        record.state === 'claimed' &&
        claim !== null &&
        claim.orchestratorId === orchestratorId &&
        Date.parse(this.nowIso()) < Date.parse(claim.leaseUntilIso)
      ) {
        return { outcome: 'reconcile', requestId, revision: record.revision, fence: claim.fence };
      }
      if (claim !== null && claim.orchestratorId !== orchestratorId) {
        return refused('holder', requestId);
      }
      if (isOrchestratorRequestClaimable(record, this.nowIso())) {
        return this.claimForOrchestrator(record, orchestratorId, expectedRevision, requestId, 'reconcile');
      }
      return refused('holder', requestId);
    }

    if (record.state === 'dispatched') {
      return { outcome: 'already-dispatched', requestId };
    }
    if (record.state === 'refused') {
      return { outcome: 'already-refused', requestId };
    }
    if (record.state === 'claimed') {
      const claim = record.claim;
      if (
        claim !== null &&
        claim.orchestratorId === orchestratorId &&
        Date.parse(this.nowIso()) < Date.parse(claim.leaseUntilIso)
      ) {
        return { outcome: 'claimed', requestId, revision: record.revision, fence: claim.fence };
      }
      return refused('holder', requestId);
    }
    if (isOrchestratorRequestClaimable(record, this.nowIso())) {
      return this.claimForOrchestrator(record, orchestratorId, expectedRevision, requestId, 'claimed');
    }
    return refused('policy', requestId);
  }

  private async sessionGate(
    kind: OrchestratorRequestKind,
    orchestratorId: string,
    projectId: string,
    requestId: string,
  ): Promise<{ ok: true } | { ok: false; result: ReconcileOrchestratorRequestResult }> {
    const deps = this.depsRequired();
    let stored: StoredOrchestratorSession | null;
    try {
      stored = await deps.sessionRepo.get(orchestratorId);
    } catch {
      return { ok: false, result: unknown('unreadable-session', requestId) };
    }
    if (stored === null) {
      return { ok: false, result: refused('policy', requestId) };
    }
    const session = stored.session;
    if (session.status !== 'active') {
      return { ok: false, result: refused('policy', requestId) };
    }
    if (Date.parse(this.nowIso()) >= Date.parse(session.leaseUntilIso)) {
      return { ok: false, result: refused('policy', requestId) };
    }
    if (!session.claims.includes(kind)) {
      return { ok: false, result: refused('policy', requestId) };
    }
    if (kind === 'start-lane-run') {
      if (session.cliKind !== 'conductor') {
        return { ok: false, result: refused('policy', requestId) };
      }
      let profile: ProjectProfileRecord | null;
      try {
        profile = await deps.profileRepo.findProfileById(projectId);
      } catch {
        return { ok: false, result: unknown('unreadable-profile', requestId) };
      }
      if (profile === null) {
        return { ok: false, result: refused('no-profile', requestId) };
      }
      if (profile.designatedDispatcherHost !== session.host) {
        return { ok: false, result: refused('dispatcher-host', requestId) };
      }
    }
    return { ok: true };
  }

  private async claimForOrchestrator(
    record: OrchestratorRequestRecord,
    orchestratorId: string,
    expectedRevision: number,
    requestId: string,
    outcome: 'claimed' | 'reconcile',
  ): Promise<ReconcileOrchestratorRequestResult> {
    const entityResult = OrchestratorRequest.create(record);
    if (!entityResult.success) {
      return unknown('unreadable-request', requestId);
    }
    const claimResult = entityResult.value.claim(
      { orchestratorId, expectedRevision },
      this.nowIso(),
      ORCHESTRATOR_REQUEST_CLAIM_LEASE_SECONDS,
    );
    if (!claimResult.success) {
      return this.mapClaimRefusal(claimResult.code, requestId);
    }
    const next = claimResult.value.toRecord();
    const saved = await this.saveRecord(next, record.revision, requestId);
    if (!saved.ok) {
      return saved.result;
    }
    const claim = saved.record.claim;
    return {
      outcome,
      requestId,
      revision: saved.record.revision,
      fence: claim === null ? 0 : claim.fence,
    };
  }

  private async executeRecordIntent(input: Record<string, unknown>): Promise<ReconcileOrchestratorRequestResult> {
    const deps = this.depsRequired();
    const requestId = input.requestId as string;
    const orchestratorId = input.orchestratorId as string;
    const expectedRevision = input.expectedRevision as number;
    const fence = input.fence as number;

    const load = await deps.requestRepo.get(requestId);
    if (load.outcome === 'missing') {
      return refused('not-found', requestId);
    }
    if (load.outcome !== 'found') {
      return unknown('unreadable-request', requestId);
    }
    const record = load.request;

    if (!ENABLED_KINDS.includes(record.kind)) {
      return refused('policy', requestId);
    }

    const holder = this.holderCheck(record, orchestratorId, expectedRevision, fence, requestId);
    if (!holder.ok) {
      return holder.result;
    }

    const digest = this.computeDigest(record);
    if (digest === null) {
      return unknown('digest-failed', requestId);
    }

    const appended = await deps.journal.appendIntent(JOURNAL_KEY_PREFIX + requestId, {
      entryId: deps.mintEntryId(),
      recordedAtIso: this.nowIso(),
      digest,
    });
    if (appended.outcome === 'appended') {
      return { outcome: 'intent-recorded', requestId };
    }
    if (appended.outcome === 'unknown') {
      return unknown('lock-timeout', requestId);
    }
    if (appended.reason === 'duplicate-key') {
      const reread = await deps.journal.read(JOURNAL_KEY_PREFIX + requestId);
      if (reread.outcome === 'unknown') {
        return unknown('unreadable-journal', requestId);
      }
      const existingIntent = reread.entries.find((entry) => entry.kind === 'intent');
      if (existingIntent === undefined) {
        return unknown('digest-failed', requestId);
      }
      if (existingIntent.digest === digest) {
        return { outcome: 'unchanged', requestId };
      }
      return refused('digest-mismatch', requestId);
    }
    return refused(appended.reason, requestId);
  }

  private async executeRecordResult(input: Record<string, unknown>): Promise<ReconcileOrchestratorRequestResult> {
    const deps = this.depsRequired();
    const requestId = input.requestId as string;
    const orchestratorId = input.orchestratorId as string;
    const expectedRevision = input.expectedRevision as number;
    const fence = input.fence as number;
    const outcome = input.outcome as (typeof RESULT_OUTCOMES)[number];
    const reasonCode = input.reasonCode as string | null;
    const reasonKind = input.reasonKind as string | null;
    const linkedId = input.linkedId as string | null;

    const load = await deps.requestRepo.get(requestId);
    if (load.outcome === 'missing') {
      return refused('not-found', requestId);
    }
    if (load.outcome !== 'found') {
      return unknown('unreadable-request', requestId);
    }
    const record = load.request;

    if (!ENABLED_KINDS.includes(record.kind)) {
      return refused('policy', requestId);
    }

    const holder = this.holderCheck(record, orchestratorId, expectedRevision, fence, requestId);
    if (!holder.ok) {
      return holder.result;
    }

    const journalRead = await deps.journal.read(JOURNAL_KEY_PREFIX + requestId);
    if (journalRead.outcome === 'unknown') {
      return unknown('unreadable-journal', requestId);
    }
    const entries = journalRead.entries;

    const digest = this.computeDigest(record);
    if (digest === null) {
      return unknown('digest-failed', requestId);
    }

    const intent = entries.find((entry) => entry.kind === 'intent');
    if (intent === undefined || intent.digest === null || intent.digest !== digest) {
      return unknown('digest-failed', requestId);
    }

    const finalResult = entries.find((entry) => entry.kind === 'result' && entry.outcome !== 'ambiguous');
    if (finalResult !== undefined) {
      if (finalResult.outcome === outcome && finalResult.reasonCode === reasonCode) {
        if (
          (outcome === 'completed' || outcome === 'refused') &&
          record.state !== 'dispatched' &&
          record.state !== 'refused'
        ) {
          const applied = await this.applyResultTransition(
            record,
            { orchestratorId, expectedRevision, fence },
            { outcome, reasonCode, reasonKind, linkedId },
            requestId,
          );
          if (!applied.ok) {
            return applied.result;
          }
        }
        return { outcome: 'unchanged', requestId };
      }
      return refused('result-after-final', requestId);
    }

    const appended = await deps.journal.appendResult(JOURNAL_KEY_PREFIX + requestId, {
      entryId: deps.mintEntryId(),
      recordedAtIso: this.nowIso(),
      outcome,
      reasonCode,
      // The result carries exactly what its transition needs, so a recovery
      // reader applies the recorded transition without inventing a link or a
      // reason kind (fix round 1, item 3).
      reasonKind,
      linkedId: outcome === 'completed' ? linkedId : null,
    });
    if (appended.outcome === 'appended') {
      if (outcome === 'completed' || outcome === 'refused') {
        const applied = await this.applyResultTransition(
          record,
          { orchestratorId, expectedRevision, fence },
          { outcome, reasonCode, reasonKind, linkedId },
          requestId,
        );
        if (!applied.ok) {
          return applied.result;
        }
      }
      return { outcome: 'result-recorded', requestId };
    }
    if (appended.outcome === 'unknown') {
      return unknown('lock-timeout', requestId);
    }
    if (appended.reason === 'result-after-final') {
      return refused('result-after-final', requestId);
    }
    return refused(appended.reason, requestId);
  }

  /** Only from a live claim by this orchestrator at the matching fence and revision. */
  private holderCheck(
    record: OrchestratorRequestRecord,
    orchestratorId: string,
    expectedRevision: number,
    fence: number,
    requestId: string,
  ): { ok: true } | { ok: false; result: ReconcileOrchestratorRequestResult } {
    if (record.state === 'cancel-requested') {
      return { ok: false, result: refused('cancel-requested', requestId) };
    }
    // Both journal actions operate only from `claimed`. Terminal transitions
    // (`dispatched`, `refused`) retain the claim, so the state check — not
    // only the cancel check — keeps a matching holder from appending to a
    // request the journal has already closed (fix round 1, item 2).
    if (record.state !== 'claimed') {
      return { ok: false, result: refused('holder', requestId) };
    }
    const claim = record.claim;
    if (claim === null) {
      return { ok: false, result: refused('holder', requestId) };
    }
    if (Date.parse(this.nowIso()) >= Date.parse(claim.leaseUntilIso)) {
      return { ok: false, result: refused('claim-lease', requestId) };
    }
    if (record.revision !== expectedRevision) {
      return { ok: false, result: refused('revision', requestId) };
    }
    if (claim.orchestratorId !== orchestratorId || claim.fence !== fence) {
      return { ok: false, result: refused('holder', requestId) };
    }
    return { ok: true };
  }

  private async applyResultTransition(
    record: OrchestratorRequestRecord,
    holder: { orchestratorId: string; expectedRevision: number; fence: number },
    result: {
      outcome: 'completed' | 'refused';
      reasonCode: string | null;
      reasonKind: string | null;
      linkedId: string | null;
    },
    requestId: string,
  ): Promise<{ ok: true } | { ok: false; result: ReconcileOrchestratorRequestResult }> {
    const entityResult = OrchestratorRequest.create(record);
    if (!entityResult.success) {
      return { ok: false, result: unknown('unreadable-request', requestId) };
    }
    let transition: OrchestratorRequestResult;
    if (result.outcome === 'completed') {
      const linkKey = ORCHESTRATOR_REQUEST_LINK_KEY[record.kind];
      transition = entityResult.value.complete(
        holder,
        { [linkKey]: result.linkedId as string, journalKey: JOURNAL_KEY_PREFIX + requestId },
        this.nowIso(),
      );
    } else {
      transition = entityResult.value.refuse(
        holder,
        { reasonKind: result.reasonKind as string, detail: null },
        this.nowIso(),
      );
    }
    if (!transition.success) {
      return { ok: false, result: this.mapTransitionRefusal(transition.code, requestId) };
    }
    return this.saveRecord(transition.value.toRecord(), record.revision, requestId);
  }

  /** Recover a transition a writer left between the journal result and its save. */
  private async reconcileFinalTransition(
    record: OrchestratorRequestRecord,
    finalResult: OrchestratorRequestJournalEntry,
    requestId: string,
  ): Promise<
    | { ok: true; outcome: 'already-dispatched' | 'already-refused' }
    | { ok: false; result: ReconcileOrchestratorRequestResult }
  > {
    const claim = record.claim;
    if (claim === null) {
      return { ok: false, result: unknown('digest-failed', requestId) };
    }
    const entityResult = OrchestratorRequest.create(record);
    if (!entityResult.success) {
      return { ok: false, result: unknown('unreadable-request', requestId) };
    }
    const holder = {
      orchestratorId: claim.orchestratorId,
      fence: claim.fence,
      expectedRevision: record.revision,
    };
    let transition: OrchestratorRequestResult;
    if (finalResult.outcome === 'refused') {
      // The recorded reason kind is the only one recovery may apply: the
      // journal result's reason code is a token, not a reason kind, and
      // inventing one would move the request on a reason nobody recorded
      // (fix round 1, item 3). A result without one is not recoverable.
      if (finalResult.reasonKind === null) {
        return { ok: false, result: unknown('digest-failed', requestId) };
      }
      transition = entityResult.value.refuse(
        holder,
        { reasonKind: finalResult.reasonKind, detail: null },
        this.nowIso(),
      );
    } else {
      // The recorded link id is the only one recovery may apply: the request
      // target names the *requested* object, not the id the action minted
      // (wrong for `prepare-fix`, absent for `start-lane-run`), so it is
      // never invented here. A completion without its recorded link id is
      // not recoverable.
      const linkValue = finalResult.linkedId;
      if (typeof linkValue !== 'string' || linkValue.length === 0) {
        return { ok: false, result: unknown('digest-failed', requestId) };
      }
      const linkKey = ORCHESTRATOR_REQUEST_LINK_KEY[record.kind];
      transition = entityResult.value.complete(
        holder,
        { [linkKey]: linkValue, journalKey: JOURNAL_KEY_PREFIX + requestId },
        this.nowIso(),
      );
    }
    if (!transition.success) {
      return { ok: false, result: this.mapTransitionRefusal(transition.code, requestId) };
    }
    const saved = await this.saveRecord(transition.value.toRecord(), record.revision, requestId);
    if (!saved.ok) {
      return { ok: false, result: saved.result };
    }
    return {
      ok: true,
      outcome: finalResult.outcome === 'refused' ? 'already-refused' : 'already-dispatched',
    };
  }

  private async saveRecord(
    next: OrchestratorRequestRecord,
    expectedRevision: number,
    requestId: string,
  ): Promise<{ ok: true; record: OrchestratorRequestRecord } | { ok: false; result: ReconcileOrchestratorRequestResult }> {
    const saved = await this.depsRequired().requestRepo.save(next, expectedRevision, {
      lockTimeoutMs: SAVE_LOCK_TIMEOUT_MS,
    });
    switch (saved.outcome) {
      case 'saved':
        return { ok: true, record: saved.request };
      case 'unchanged':
        return { ok: true, record: saved.request };
      case 'refused':
        if (saved.code === 'lock-timeout') {
          return { ok: false, result: refused('lock-timeout', requestId) };
        }
        if (saved.code === 'revision-conflict') {
          return { ok: false, result: refused('revision', requestId) };
        }
        return { ok: false, result: unknown(saved.code, requestId) };
      case 'unknown':
        return { ok: false, result: unknown(saved.code, requestId) };
    }
  }

  private mapClaimRefusal(
    code: OrchestratorRequestRefusalCode,
    requestId: string,
  ): ReconcileOrchestratorRequestResult {
    switch (code) {
      case 'revision':
        return refused('revision', requestId);
      case 'state':
        return refused('policy', requestId);
      case 'expired':
        return refused('policy', requestId);
      case 'holder':
        return refused('holder', requestId);
      case 'lease':
        return refused('claim-lease', requestId);
      case 'invalid':
        return refused('invalid-request', requestId);
    }
  }

  private mapTransitionRefusal(
    code: OrchestratorRequestRefusalCode,
    requestId: string,
  ): ReconcileOrchestratorRequestResult {
    switch (code) {
      case 'revision':
        return refused('revision', requestId);
      case 'holder':
        return refused('holder', requestId);
      case 'lease':
        return refused('claim-lease', requestId);
      case 'state':
        return refused('holder', requestId);
      case 'expired':
        return refused('policy', requestId);
      case 'invalid':
        return refused('invalid-request', requestId);
    }
  }
}
