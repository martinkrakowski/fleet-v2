// Lane AT1: tests for AttestShadowFactUseCase. Every refusal and unknown code
// has a titled test, nothing is ever written on a refused or unknown outcome,
// and the hostile inputs the domain parser refuses are exercised at the use
// case boundary too.
import { describe, expect, it } from 'vitest';

import {
  SHADOW_ATTESTATION_FACTS,
  SHADOW_ATTESTATION_SCHEMA_VERSION,
  SHADOW_ONE_TIME_REQUIREMENTS,
  type ShadowAttestation,
  type ShadowAttestationLedger,
} from '../../../domain/shadow-attestations.js';
import type {
  ShadowAttestationCasResult,
  ShadowAttestationPort,
  ShadowAttestationReadResult,
} from '../../ports/out/ShadowAttestationPort.out-port.js';
import type {
  CutoverJournalEntry,
  CutoverJournalPort,
} from '../../ports/out/CutoverJournalPort.out-port.js';
import { AttestShadowFactUseCase, type AttestShadowFactDependencies } from '../AttestShadowFactUseCase.use-case.js';

const FORGE = 's2-forge-error-backoff';
const CANARY = 's2-canary-parks';
const DIGEST_A = 'a'.repeat(64);
const RELEASE_SHA = 'c'.repeat(40);
const NOW = '2026-06-15T12:00:00.000Z';
/** A secret-shaped string built at runtime so the source holds no secret literal. */
const SECRET_TEXT = `sk-${'b'.repeat(24)}`;

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fact: FORGE,
    note: 'verified in the release tree',
    expectedRevision: 0,
    operationId: 'attest-1',
    authority: 'owner',
    ...overrides,
  };
}

class FakeAttestations implements ShadowAttestationPort {
  ledger: ShadowAttestationLedger | null = null;
  readResult: ShadowAttestationReadResult | null = null;
  casResult: ShadowAttestationCasResult | null = null;
  writes = 0;

  constructor(readonly readOnly = false) {}

  async read(): Promise<ShadowAttestationReadResult> {
    if (this.readResult !== null) return this.readResult;
    if (this.ledger === null) return { status: 'missing' };
    return { status: 'ok', ledger: this.ledger };
  }

  async compareAndSet(request: { expectedRevision: number; next: ShadowAttestationLedger }): Promise<ShadowAttestationCasResult> {
    this.writes += 1;
    if (this.casResult !== null) return this.casResult;
    if (this.readOnly) return { outcome: 'refused', reason: 'read-only' };
    const currentRevision = this.ledger?.revision ?? 0;
    if (request.expectedRevision !== currentRevision) {
      return { outcome: 'conflict', currentRevision };
    }
    this.ledger = request.next;
    return { outcome: 'saved', ledger: request.next };
  }
}

class FakeJournal implements CutoverJournalPort {
  entries: CutoverJournalEntry[] = [];
  unreadable = false;
  /** The refusal the next append returns, or null to append normally. */
  nextRefusal: string | null = null;

  async append(entry: CutoverJournalEntry) {
    if (this.nextRefusal !== null) {
      return { outcome: 'refused' as const, reason: this.nextRefusal as never };
    }
    if (this.entries.some((existing) => existing.key === entry.key && existing.kind === entry.kind)) {
      return { outcome: 'refused' as const, reason: 'duplicate-intent' as const };
    }
    if (
      entry.kind === 'intent' &&
      this.entries.some((existing) => existing.key === entry.key && existing.kind === 'result')
    ) {
      return { outcome: 'refused' as const, reason: 'intent-after-result' as const };
    }
    if (
      entry.kind === 'result' &&
      !this.entries.some((existing) => existing.key === entry.key && existing.kind === 'intent')
    ) {
      return { outcome: 'refused' as const, reason: 'result-without-intent' as const };
    }
    this.entries.push({ ...entry });
    return { outcome: 'appended' as const, entry };
  }

  async listByKeyPrefix(prefix: string) {
    if (this.unreadable) return { outcome: 'unreadable' as const };
    return {
      outcome: 'listed' as const,
      entries: this.entries.filter((entry) => entry.key.startsWith(prefix)),
    };
  }
}

interface FakeDeps {
  attestations: FakeAttestations;
  journal: FakeJournal;
  nowIso: () => string;
}


function useCase(overrides: Partial<FakeDeps> = {}): { useCase: AttestShadowFactUseCase; deps: FakeDeps } {
  const deps: FakeDeps = {
    attestations: new FakeAttestations(),
    journal: new FakeJournal(),
    nowIso: () => NOW,
    ...overrides,
  };
  const bound: AttestShadowFactDependencies = {
    attestations: deps.attestations,
    cutoverJournal: deps.journal,
    releaseSha: async () => RELEASE_SHA,
    computeDigest: (text) => (text.includes('different') ? DIGEST_A : `d${text.length.toString(16).padStart(63, '0')}`),
    mintEntryId: () => `entry-${bound ? deps.journal.entries.length : 0}`,
    nowIso: deps.nowIso,
  };
  return { useCase: new AttestShadowFactUseCase(bound), deps };
}

function storedLedger(attestations: readonly ShadowAttestation[]): ShadowAttestationLedger {
  return { schemaVersion: SHADOW_ATTESTATION_SCHEMA_VERSION, revision: attestations.length, attestations };
}

function attestationFor(fact: string, day = '2026-06-14'): ShadowAttestation {
  return {
    fact: fact as ShadowAttestation['fact'],
    observedDay: day,
    releaseSha: RELEASE_SHA,
    reason: 'owner-attested',
    digest: DIGEST_A,
    recordedAtIso: '2026-06-14T00:00:00.000Z',
  };
}

describe('AttestShadowFactUseCase (AT1)', () => {
  it('attests a fact at revision 0 and returns the stored record', async () => {
    const { useCase: attest, deps } = useCase();
    const result = await attest.execute(baseInput());
    expect(result.outcome).toBe('attested');
    if (result.outcome !== 'attested') return;
    expect(result.ledger.revision).toBe(1);
    expect(result.attestation.fact).toBe(FORGE);
    expect(result.attestation.observedDay).toBe('2026-06-15');
    expect(result.attestation.releaseSha).toBe(RELEASE_SHA);
    expect(result.attestation.reason).toBe('owner-attested');
    expect(deps.attestations.ledger?.revision).toBe(1);
    const kinds = deps.journal.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(['intent', 'result']);
  });

  it('derives observedDay from the daemon clock, not from the stored clock instant alone', async () => {
    // 2026-06-16T02:00+10:00 is 2026-06-15T16:00Z: the UTC day is the 15th.
    const { useCase: attest } = useCase({ nowIso: () => '2026-06-16T02:00:00+10:00' });
    const result = await attest.execute(baseInput());
    expect(result.outcome).toBe('attested');
    if (result.outcome !== 'attested') return;
    expect(result.attestation.observedDay).toBe('2026-06-15');
    expect(result.attestation.recordedAtIso).toBe('2026-06-15T16:00:00.000Z');
  });

  it('never stores note, evidence or authority, and hashes them into the digest', async () => {
    const { useCase: attest, deps } = useCase();
    const result = await attest.execute(
      baseInput({ note: 'secret note text', evidence: 'evidence text', authority: 'owner label' }),
    );
    expect(result.outcome).toBe('attested');
    const serialized = JSON.stringify({
      ledger: deps.attestations.ledger,
      journal: deps.journal.entries,
    });
    expect(serialized).not.toContain('secret note text');
    expect(serialized).not.toContain('evidence text');
    expect(serialized).not.toContain('owner label');
  });

  it('replays the same operation id and payload without writing or bumping the revision', async () => {
    const { useCase: attest, deps } = useCase();
    const first = await attest.execute(baseInput());
    expect(first.outcome).toBe('attested');
    const writesAfterFirst = deps.attestations.writes;
    const second = await attest.execute(baseInput());
    expect(second.outcome).toBe('attested');
    if (second.outcome !== 'attested' || first.outcome !== 'attested') return;
    expect(second.ledger).toEqual(first.ledger);
    expect(second.attestation).toEqual(first.attestation);
    expect(deps.attestations.writes).toBe(writesAfterFirst);
  });

  it('refuses a mismatched operation-id replay with operation-id-conflict', async () => {
    const { useCase: attest, deps } = useCase();
    expect((await attest.execute(baseInput())).outcome).toBe('attested');
    const replay = await attest.execute(baseInput({ note: 'different note' }));
    expect(replay).toEqual({ outcome: 'refused', reason: 'operation-id-conflict' });
    expect(deps.attestations.ledger?.attestations).toHaveLength(1);
  });

  it('refuses a replay of a prior refused operation id with journal-refused', async () => {
    const { useCase: attest, deps } = useCase();
    // First call hits a stale revision: refused and recorded as a final refused result.
    expect((await attest.execute(baseInput({ expectedRevision: 5 }))).outcome).toBe('refused');
    const writes = deps.attestations.writes;
    const replay = await attest.execute(baseInput({ expectedRevision: 0 }));
    expect(replay).toEqual({ outcome: 'refused', reason: 'journal-refused' });
    expect(deps.attestations.writes).toBe(writes);
  });

  it('refuses a stale revision with revision-conflict and writes nothing to the store', async () => {
    const { useCase: attest, deps } = useCase();
    deps.attestations.ledger = storedLedger([attestationFor(CANARY)]);
    const result = await attest.execute(baseInput({ expectedRevision: 0 }));
    expect(result).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    expect(deps.attestations.ledger?.attestations).toHaveLength(1);
  });

  it('refuses missing authority without writing', async () => {
    const { useCase: attest, deps } = useCase();
    const input = baseInput();
    delete input['authority'];
    expect(await attest.execute(input)).toEqual({ outcome: 'refused', reason: 'authority-required' });
    expect(await attest.execute(baseInput({ authority: '   ' }))).toEqual({
      outcome: 'refused',
      reason: 'authority-required',
    });
    expect(deps.attestations.ledger).toBeNull();
    expect(deps.journal.entries).toHaveLength(0);
  });

  it('refuses secret-shaped input without echoing it', async () => {
    const { useCase: attest, deps } = useCase();
    const result = await attest.execute(baseInput({ note: SECRET_TEXT }));
    expect(result).toEqual({ outcome: 'refused', reason: 'secret-shaped' });
    expect(JSON.stringify(result)).not.toContain(SECRET_TEXT);
    expect(deps.attestations.ledger).toBeNull();
    expect(deps.journal.entries).toHaveLength(0);
  });

  it('refuses an unknown fact id', async () => {
    const { useCase: attest, deps } = useCase();
    expect(await attest.execute(baseInput({ fact: 's9-made-up-fact' }))).toEqual({
      outcome: 'refused',
      reason: 'unknown-fact',
    });
    expect(deps.attestations.ledger).toBeNull();
  });

  it('refuses invalid input', async () => {
    const { useCase: attest, deps } = useCase();
    expect((await attest.execute(null)).outcome).toBe('refused');
    expect((await attest.execute(baseInput({ note: 42 }))).outcome).toBe('refused');
    expect((await attest.execute(baseInput({ expectedRevision: -1 }))).outcome).toBe('refused');
    expect((await attest.execute(baseInput({ operationId: 'bad id with spaces' }))).outcome).toBe('refused');
    expect((await attest.execute(baseInput({ nowIso: NOW }))).outcome).toBe('refused');
    expect(deps.attestations.ledger).toBeNull();
    expect(deps.journal.entries).toHaveLength(0);
  });

  it('refuses a read-only store', async () => {
    const readOnlyAttestations = new FakeAttestations(true);
    const { useCase: attest, deps } = useCase({ attestations: readOnlyAttestations });
    const result = await attest.execute(baseInput());
    expect(result).toEqual({ outcome: 'refused', reason: 'read-only' });
    expect(deps.journal.entries.some((entry) => entry.kind === 'result' && entry.outcome === 'refused')).toBe(true);
  });

  it('returns unknown on an unreadable journal and writes nothing', async () => {
    const { useCase: attest, deps } = useCase();
    deps.journal.unreadable = true;
    expect(await attest.execute(baseInput())).toEqual({ outcome: 'unknown', reason: 'journal-unreadable' });
    expect(deps.attestations.ledger).toBeNull();
  });

  it('returns unknown on an unknown-version attestation store', async () => {
    const { useCase: attest, deps } = useCase();
    deps.attestations.readResult = { status: 'unknown-version' };
    expect(await attest.execute(baseInput())).toEqual({
      outcome: 'unknown',
      reason: 'attestations-unknown-version',
    });
    expect(deps.journal.entries).toHaveLength(0);
  });

  it('returns unknown on an unreadable attestation store and writes nothing', async () => {
    const { useCase: attest, deps } = useCase();
    deps.attestations.readResult = { status: 'unreadable' };
    expect(await attest.execute(baseInput())).toEqual({
      outcome: 'unknown',
      reason: 'attestations-unreadable',
    });
    expect(deps.journal.entries).toHaveLength(0);
  });

  it('returns unknown when the deadline is exceeded', async () => {
    const { useCase: attest } = useCase({ nowIso: () => '2026-06-15T12:00:00.000Z' });
    const result = await attest.execute(baseInput({ deadlineIso: '2026-06-15T00:00:00.000Z' }));
    expect(result).toEqual({ outcome: 'unknown', reason: 'deadline-exceeded' });
  });

  it('completes an intent without a result on a matching digest, and refuses on a mismatch', async () => {
    // Crash recovery: an intent is durable but the attestation write never landed.
    const { useCase: attest, deps } = useCase();
    const digest = 'd'.repeat(64);
    deps.journal.entries.push({
      key: 'cutover/attest@attest-1',
      kind: 'intent',
      entryId: 'crashed',
      recordedAtIso: NOW,
      digest,
    });
    // The use case's own digest for this payload must match the crashed intent,
    // so recompute it the way the use case does: run a second use case whose
    // computeDigest is shared. Simplest: the fake digest is a pure function of
    // the payload, so mint the same one by executing and reading the intent.
    const probe = useCase();
    await probe.useCase.execute(baseInput({ operationId: 'probe' }));
    const probeDigest = probe.deps.journal.entries[0]?.digest;
    expect(typeof probeDigest).toBe('string');
    deps.journal.entries[0] = { ...deps.journal.entries[0]!, digest: probeDigest };
    const recovered = await attest.execute(baseInput());
    expect(recovered.outcome).toBe('attested');
    expect(deps.journal.entries.some((entry) => entry.kind === 'result' && entry.outcome === 'completed')).toBe(true);

    // A mismatching digest under the same operation id is a conflict.
    const other = useCase();
    other.deps.journal.entries.push({
      key: 'cutover/attest@other',
      kind: 'intent',
      entryId: 'crashed-2',
      recordedAtIso: NOW,
      digest: 'e'.repeat(64),
    });
    expect(await other.useCase.execute(baseInput({ operationId: 'other' }))).toEqual({
      outcome: 'refused',
      reason: 'operation-id-conflict',
    });
  });

  it('completes a crashed intent as attested (recovered) when the fact is already stored with a matching digest', async () => {
    // Crash after the compare-and-set landed but before the completed result
    // was appended: the intent has no result, the ledger holds the fact, and
    // the stored revision (1) no longer equals the caller's expectation (0).
    const { useCase: attest, deps } = useCase();
    expect((await attest.execute(baseInput())).outcome).toBe('attested');
    const writesAfterSave = deps.attestations.writes;
    const resultIndex = deps.journal.entries.findIndex((entry) => entry.kind === 'result');
    expect(resultIndex).toBeGreaterThanOrEqual(0);
    deps.journal.entries.splice(resultIndex, 1);
    const recovered = await attest.execute(baseInput());
    expect(recovered.outcome).toBe('attested');
    if (recovered.outcome !== 'attested') return;
    expect(recovered.attestation.fact).toBe(FORGE);
    expect(deps.attestations.writes).toBe(writesAfterSave);
    const result = deps.journal.entries.find((entry) => entry.kind === 'result');
    expect(result?.outcome).toBe('completed');
    expect(result?.reasonCode).toBe('recovered');
  });

  it('reads every field from the parsed snapshot: a Proxy get trap on the request never runs', async () => {
    const { useCase: attest } = useCase();
    let getTraps = 0;
    const target = baseInput({ deadlineIso: '2026-07-01T00:00:00.000Z' });
    const request = new Proxy(target, {
      get(inner, key, receiver) {
        getTraps += 1;
        return Reflect.get(inner, key, receiver);
      },
    });
    const result = await attest.execute(request);
    expect(result.outcome).toBe('attested');
    expect(getTraps).toBe(0);
  });

  it('replays a completed unchanged operation as unchanged, carrying the stored outcome and reason', async () => {
    const { useCase: attest, deps } = useCase();
    deps.attestations.ledger = storedLedger([attestationFor(FORGE)]);
    const first = await attest.execute(baseInput({ expectedRevision: 1 }));
    expect(first.outcome).toBe('unchanged');
    const second = await attest.execute(baseInput({ expectedRevision: 1 }));
    expect(second.outcome).toBe('unchanged');
    if (second.outcome !== 'unchanged' || first.outcome !== 'unchanged') return;
    expect(second.ledger).toEqual(first.ledger);
    expect(second.attestation).toEqual(first.attestation);
    const result = deps.journal.entries.filter((entry) => entry.kind === 'result');
    expect(result).toHaveLength(1);
    expect(result[0]?.outcome).toBe('completed');
    expect(result[0]?.reasonCode).toBe('unchanged');
    expect(deps.attestations.writes).toBe(0);
  });

  it('maps intent-after-result to journal-refused', async () => {
    const { useCase: attest, deps } = useCase();
    deps.journal.nextRefusal = 'intent-after-result';
    expect(await attest.execute(baseInput())).toEqual({ outcome: 'refused', reason: 'journal-refused' });
  });

  it('does not recover a different operation onto an attestation recorded on another day: it answers revision-conflict', async () => {
    // A different operation id with an identical payload, crashed after its
    // intent: the stored fact was written by an EARLIER operation on an
    // earlier day, so this operation's own write never landed. Recovery must
    // not claim it; the sticky path's revision check answers
    // `revision-conflict` for the caller's stale expectation.
    const { useCase: attest, deps } = useCase();
    // `computeDigest` mints DIGEST_A for any payload mentioning 'different',
    // so the stored attestation below carries this payload's exact digest.
    deps.attestations.ledger = storedLedger([attestationFor(FORGE, '2026-06-14')]);
    deps.journal.entries.push({
      key: 'cutover/attest@attest-2',
      kind: 'intent',
      entryId: 'crashed-other-operation',
      recordedAtIso: '2026-06-16T12:00:00.000Z',
      digest: DIGEST_A,
    });
    const result = await attest.execute(
      baseInput({ note: 'different note', expectedRevision: 0, operationId: 'attest-2' }),
    );
    expect(result).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    // The refused result is journaled under this operation's own key, and the
    // stored attestation is untouched.
    const resultEntry = deps.journal.entries.find((entry) => entry.kind === 'result');
    expect(resultEntry?.key).toBe('cutover/attest@attest-2');
    expect(resultEntry?.outcome).toBe('refused');
    expect(deps.attestations.ledger?.revision).toBe(1);
  });

  it('does not recover a different operation with an identical payload onto the record op A stored: it answers revision-conflict', async () => {
    // Op A succeeds and stores the fact. Then op B arrives with an IDENTICAL
    // payload (so the same request digest: the digest excludes the operation
    // id) under a NEW operation id, with a crashed intent of its own. The
    // stored record belongs to op A, not to op B, so recovery must not claim
    // it: op B takes the normal attest path and its stale expectation
    // answers `revision-conflict`, never `recovered`.
    const { useCase: attest, deps } = useCase();
    expect((await attest.execute(baseInput())).outcome).toBe('attested');
    const digestA = deps.journal.entries.find((entry) => entry.kind === 'intent')?.digest;
    expect(typeof digestA).toBe('string');
    // The two operation ids differ in length so the fake length-based
    // digest gives their bindings different values, as a real hash would.
    deps.journal.entries.push({
      key: 'cutover/attest@op-b-retry',
      kind: 'intent',
      entryId: 'crashed-operation-B',
      recordedAtIso: NOW,
      digest: digestA!,
    });
    const result = await attest.execute(baseInput({ operationId: 'op-b-retry' }));
    expect(result).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    expect(deps.journal.entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'recovered')).toBe(false);
    expect(deps.attestations.ledger?.revision).toBe(1);
  });

  it('answers revision-conflict for an unchanged attest with a stale expectedRevision', async () => {
    // Sticky-unchanged pin: the fact is already recorded, but the caller's
    // expected revision does not match the stored ledger, so the sticky path
    // refuses exactly as a compare-and-set would.
    const { useCase: attest, deps } = useCase();
    deps.attestations.ledger = storedLedger([attestationFor(FORGE)]);
    const result = await attest.execute(baseInput({ expectedRevision: 0, operationId: 'attest-stale' }));
    expect(result).toEqual({ outcome: 'refused', reason: 'revision-conflict' });
    expect(deps.attestations.writes).toBe(0);
    const resultEntry = deps.journal.entries.find((entry) => entry.kind === 'result');
    expect(resultEntry?.outcome).toBe('refused');
    expect(resultEntry?.reasonCode).toBe('revision-conflict');
  });

  it('attests every required one-time fact and the evaluator reads them back as satisfied', async () => {
    const { useCase: attest, deps } = useCase();
    let revision = 0;
    let operation = 0;
    for (const fact of SHADOW_ATTESTATION_FACTS) {
      operation += 1;
      const result = await attest.execute(
        baseInput({ fact, expectedRevision: revision, operationId: `attest-${operation}` }),
      );
      expect(result.outcome).toBe('attested');
      if (result.outcome === 'attested') {
        revision = result.ledger.revision;
      }
    }
    const { evaluateShadowOneTimeCriteria } = await import('../../../domain/shadow-attestations.js');
    // S2 needs both of its facts and S3 its own; the attested day is on or
    // before the evaluation day. S2's required e2e path is reported present
    // and unquarantined so no `release-test-unreported` can mask the facts:
    // with all three facts attested, S2 AND S3 must actually pass. The
    // no-attestation control below proves the facts are what these passes
    // count. There is no release tree wired here, so S10/S11 stay
    // `release-tree-unreadable` — that is not this use case's concern.
    const releaseTests = [
      { path: SHADOW_ONE_TIME_REQUIREMENTS.S2.tests[0]!, present: true, quarantined: false },
    ];
    const evaluations = evaluateShadowOneTimeCriteria({
      day: '2026-06-16',
      releaseSha: RELEASE_SHA,
      attestations: deps.attestations.ledger,
      releaseTests,
    });
    expect(evaluations.S2).toEqual({ status: 'pass', reason: 'one-time-evidence-present' });
    expect(evaluations.S3).toEqual({ status: 'pass', reason: 'one-time-evidence-present' });
  });

  it('does not pass S2 or S3 without the attested facts (no-attestation control)', async () => {
    // Control for the test above: with an EMPTY attestation ledger, S2 (its
    // facts missing) and S3 must not pass, even with S2's e2e path reported
    // present and unquarantined.
    const { evaluateShadowOneTimeCriteria } = await import('../../../domain/shadow-attestations.js');
    const evaluations = evaluateShadowOneTimeCriteria({
      day: '2026-06-16',
      releaseSha: RELEASE_SHA,
      attestations: null,
      releaseTests: [{ path: SHADOW_ONE_TIME_REQUIREMENTS.S2.tests[0]!, present: true, quarantined: false }],
    });
    expect(evaluations.S2).toEqual({ status: 'unknown', reason: 'not-yet-observed' });
    expect(evaluations.S3).toEqual({ status: 'unknown', reason: 'not-yet-observed' });
  });
});
