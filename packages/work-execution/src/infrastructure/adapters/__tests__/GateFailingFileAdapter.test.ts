// PT1a: the gate failing file on verification receipts, written by the gate and read back for the park class.
import { describe, expect, it } from 'vitest';

import type { EvidenceAssessmentRecord, VerificationReceiptRecord } from '@fleet/evidence-and-acceptance';

import { GateFailingFileAdapter } from '../GateFailingFileAdapter.adapter.js';
import { GateReceiptAdapter } from '../GateReceiptAdapter.adapter.js';
import { parseStoredPredicateResult } from '../../../application/use-cases/RequestAttemptAcceptanceUseCase.use-case.js';
import type { ActionJournalEntryRecord } from '../../../domain/execution-records.js';

/** Ids copied from `.fleet/state/assessments.json` shapes; no content. */
const ATTEMPT = 'attempt-01M64PT1PX2MAZVQDYAYMZ7WNB';
const HEAD = '8ec0027892085ac2ff9a28c3107fc705f95aefcc';

function receipt(overrides: Partial<VerificationReceiptRecord>): VerificationReceiptRecord {
  return {
    id: 'verify-attempt-01M64PT1PX2MAZVQDYAYMZ7WNB-typecheck-8ec002789208',
    assessmentId: 'assessment-' + ATTEMPT,
    projectId: 'fleet-v2',
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    hostId: 'solstice',
    procedureName: 'typecheck',
    result: 'fail',
    exitCode: 1,
    evidenceRef: 'run-journal:run-01M63WPH4GMF2CA3NQ7JAM4HS1/r2/gate@8ec002789208',
    policyRevision: 'policy:conductor@7844746b0277',
    completedAtIso: '2026-10-29T20:57:25.119Z',
    ...overrides,
  };
}

function assessment(receipts: readonly VerificationReceiptRecord[]): EvidenceAssessmentRecord {
  return {
    id: 'assessment-' + ATTEMPT,
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    verificationReceipts: receipts,
  } as unknown as EvidenceAssessmentRecord;
}

function adapterOver(found: EvidenceAssessmentRecord | null): GateFailingFileAdapter {
  return new GateFailingFileAdapter({
    inspector: {
      inspectAcceptanceEvidence: async () =>
        found === null ? { outcome: 'not-found' } : { outcome: 'found', assessment: found },
    } as never,
  });
}

describe('GateFailingFileAdapter (PT1a)', () => {
  it('reads the latest failing receipt that names a screened file at the head', async () => {
    const adapter = adapterOver(
      assessment([
        receipt({ procedureName: 'lint', failingFile: 'apps/cli/src/older.ts' }),
        receipt({ procedureName: 'typecheck', failingFile: 'packages/work-execution/src/domain/park-class.ts' }),
        receipt({ procedureName: 'build', result: 'pass', failingFile: 'apps/cli/src/ignored-pass.ts' }),
      ]),
    );
    expect(await adapter.readGateFailingFile({ attemptId: ATTEMPT, headSha: HEAD })).toEqual({
      outcome: 'found',
      failingFile: 'packages/work-execution/src/domain/park-class.ts',
    });
  });

  it('is found with null when no receipt names a file, the file fails the screen or the assessment is missing', async () => {
    expect(await adapterOver(assessment([receipt({ failingFile: null })])).readGateFailingFile({ attemptId: ATTEMPT, headSha: HEAD })).toEqual({
      outcome: 'found',
      failingFile: null,
    });
    expect(await adapterOver(assessment([receipt({ failingFile: '/etc/passwd' })])).readGateFailingFile({ attemptId: ATTEMPT, headSha: HEAD })).toEqual({
      outcome: 'found',
      failingFile: null,
    });
    expect(await adapterOver(null).readGateFailingFile({ attemptId: ATTEMPT, headSha: HEAD })).toEqual({ outcome: 'found', failingFile: null });
    // A receipt for another head never answers.
    expect(
      await adapterOver(assessment([receipt({ candidateHeadSha: 'f'.repeat(40), failingFile: 'a/b.ts' })])).readGateFailingFile({ attemptId: ATTEMPT, headSha: HEAD }),
    ).toEqual({ outcome: 'found', failingFile: null });
  });

  it('is unavailable when unwired or when the read throws, never a throw', async () => {
    expect(await new GateFailingFileAdapter().readGateFailingFile({ attemptId: ATTEMPT, headSha: HEAD })).toEqual({ outcome: 'unavailable' });
    const throwing = new GateFailingFileAdapter({
      inspector: {
        inspectAcceptanceEvidence: async () => {
          throw new Error('store unreadable');
        },
      } as never,
    });
    expect(await throwing.readGateFailingFile({ attemptId: ATTEMPT, headSha: HEAD })).toEqual({ outcome: 'unavailable' });
  });
});

describe('GateReceiptAdapter failingFile (PT1a)', () => {
  it('writes the failing file onto the verification receipt, and null as null, and omits it for a pass', async () => {
    const recorded: VerificationReceiptRecord[] = [];
    const adapter = new GateReceiptAdapter({
      recordVerificationReceipt: async ({ receipt: record }) => {
        recorded.push(record);
        return { outcome: 'recorded' };
      },
      assessmentIdOf: (attemptId) => 'assessment-' + attemptId,
    });
    const answer = await adapter.recordGateReceipts({
      attemptId: ATTEMPT,
      projectId: 'fleet-v2',
      candidateHeadSha: HEAD,
      hostId: 'solstice',
      policyRevision: 'policy:conductor@7844746b0277',
      completedAtIso: '2026-10-29T20:57:25.119Z',
      evidenceRef: 'run-journal:run-01M63WPH4GMF2CA3NQ7JAM4HS1/r0/gate@8ec002789208',
      receipts: [
        { procedureName: 'typecheck', result: 'fail', exitCode: 1, failingFile: 'apps/cli/src/conductor.ts' },
        { procedureName: 'lint', result: 'fail', exitCode: 1, failingFile: null },
        { procedureName: 'build', result: 'pass', exitCode: 0 },
      ],
    });
    expect(answer).toEqual({ outcome: 'recorded', count: 3 });
    expect(recorded[0]?.failingFile).toBe('apps/cli/src/conductor.ts');
    expect(recorded[1]?.failingFile).toBeNull();
    expect('failingFile' in (recorded[2] ?? {})).toBe(false);
  });
});

describe('stored gate predicate result (PT1a)', () => {
  function entry(detail: Record<string, unknown>): ActionJournalEntryRecord {
    return {
      id: ATTEMPT + ':accept:' + HEAD + ':0',
      attemptId: ATTEMPT,
      workOrderId: 'wo-fleet-v2-sr1c-dedupe-2026-10-29',
      action: 'accept',
      baseCommit: 'b'.repeat(40),
      recordedAtIso: '2026-10-29T20:57:25.119Z',
      sessionId: null,
      status: 'failed',
      detail: JSON.stringify({
        predicate: 'command 1: yarn typecheck',
        kind: 'command',
        verdict: 'fail',
        exitCode: 1,
        durationMs: 10,
        detail: 'exit 1',
        ...detail,
      }),
    } as unknown as ActionJournalEntryRecord;
  }

  it('re-reads a stored failing file through the screen, and an unusable one as null', () => {
    expect(parseStoredPredicateResult(entry({ failingFile: 'apps/cli/src/conductor.ts' }))?.failingFile).toBe('apps/cli/src/conductor.ts');
    expect(parseStoredPredicateResult(entry({ failingFile: '../x.ts' }))?.failingFile).toBeNull();
    expect(parseStoredPredicateResult(entry({ failingFile: null }))?.failingFile).toBeNull();
    expect(parseStoredPredicateResult(entry({}))).not.toHaveProperty('failingFile');
  });
});
