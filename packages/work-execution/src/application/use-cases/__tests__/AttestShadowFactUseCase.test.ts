// Lane AT1: tests for AttestShadowFactUseCase. Every refusal and unknown code
// has a titled test, nothing is ever written on a refused or unknown outcome,
// and the hostile inputs the domain parser refuses are exercised at the use
// case boundary too.
import { describe, expect, it } from 'vitest';

import {
  SHADOW_ATTESTATION_FACTS,
  SHADOW_ATTESTATION_SCHEMA_VERSION,
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

  it('maps intent-after-result to journal-refused', async () => {
    const { useCase: attest, deps } = useCase();
    deps.journal.nextRefusal = 'intent-after-result';
    expect(await attest.execute(baseInput())).toEqual({ outcome: 'refused', reason: 'journal-refused' });
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
    // before the evaluation day, so neither may still say `not-yet-observed`.
    // There is no release tree wired here, so S10/S11 stay
    // `release-tree-unreadable` — that is not this use case's concern.
    const evaluations = evaluateShadowOneTimeCriteria({
      day: '2026-06-16',
      releaseSha: RELEASE_SHA,
      attestations: deps.attestations.ledger,
      releaseTests: [],
    });
    expect(evaluations.S2.reason).not.toBe('not-yet-observed');
    expect(evaluations.S3.reason).not.toBe('not-yet-observed');
  });
});
