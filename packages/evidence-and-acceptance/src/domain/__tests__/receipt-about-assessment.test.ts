import { describe, expect, it } from 'vitest';
import type { ReceiptSubject } from '../evidence-records.js';
import { isReceiptAboutAssessment } from '../review-selection.js';

const HEAD = '1111111111111111111111111111111111111111';
const DIGEST = 'd'.repeat(64);
const ATTEMPT_ASSESSMENT = { projectId: 'proj-1', attemptId: 'att-1' };
const CHAIN_ASSESSMENT = { projectId: 'proj-1', attemptId: 'chain:proj-1:main' };
const BRIEF_ASSESSMENT = { projectId: 'proj-1', attemptId: `brief:proj-1:${DIGEST}` };

function subject(overrides: Partial<ReceiptSubject>): ReceiptSubject {
  return {
    kind: 'attempt', projectId: 'proj-1', attemptId: null, chainName: null, integrationHeadSha: null,
    briefPackageDigest: null, baseCommit: null, ...overrides,
  };
}

const attemptSubject = (attemptId: string, projectId = 'proj-1'): ReceiptSubject => subject({ attemptId, projectId });
const chainSubject = (chainName: string): ReceiptSubject =>
  subject({ kind: 'chain', chainName, integrationHeadSha: HEAD });
const briefSubject = (digest: string): ReceiptSubject =>
  subject({ kind: 'brief', briefPackageDigest: digest, baseCommit: HEAD });

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { projectId: 'proj-1', attemptId: 'att-1', ...overrides };
}

describe('isReceiptAboutAssessment (CO18a7a)', () => {
  it('a receipt without a subject is about the assessment that has its attemptId and projectId', () => {
    expect(isReceiptAboutAssessment(receipt(), ATTEMPT_ASSESSMENT)).toBe(true);
  });

  it('an attempt subject naming the same attempt and project is about the assessment', () => {
    expect(isReceiptAboutAssessment(receipt({ subject: attemptSubject('att-1') }), ATTEMPT_ASSESSMENT)).toBe(true);
  });

  it('an attempt subject naming another attempt is not about the assessment', () => {
    expect(isReceiptAboutAssessment(receipt({ subject: attemptSubject('att-OTHER') }), ATTEMPT_ASSESSMENT)).toBe(false);
  });

  it('an attempt subject naming another project is not about the assessment', () => {
    expect(isReceiptAboutAssessment(receipt({ subject: attemptSubject('att-1', 'proj-2') }), ATTEMPT_ASSESSMENT)).toBe(false);
  });

  it('a chain subject or a brief subject is not about an attempt assessment', () => {
    expect(isReceiptAboutAssessment(receipt({ subject: chainSubject('main') }), ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(receipt({ subject: briefSubject(DIGEST) }), ATTEMPT_ASSESSMENT)).toBe(false);
  });

  it('a receipt whose own attemptId or projectId differs from the assessment is not about it', () => {
    expect(isReceiptAboutAssessment(receipt({ attemptId: 'att-2' }), ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(receipt({ projectId: 'proj-2' }), ATTEMPT_ASSESSMENT)).toBe(false);
  });

  it('a chain subject is about the chain assessment of that project and chain name only', () => {
    const own = receipt({ attemptId: 'chain:proj-1:main', subject: chainSubject('main') });
    const other = receipt({ attemptId: 'chain:proj-1:main', subject: chainSubject('other') });
    expect(isReceiptAboutAssessment(own, CHAIN_ASSESSMENT)).toBe(true);
    expect(isReceiptAboutAssessment(other, CHAIN_ASSESSMENT)).toBe(false);
  });

  it('a brief subject is about the brief assessment of that project and digest only', () => {
    const own = receipt({ attemptId: BRIEF_ASSESSMENT.attemptId, subject: briefSubject(DIGEST) });
    const other = receipt({ attemptId: BRIEF_ASSESSMENT.attemptId, subject: briefSubject('e'.repeat(64)) });
    expect(isReceiptAboutAssessment(own, BRIEF_ASSESSMENT)).toBe(true);
    expect(isReceiptAboutAssessment(other, BRIEF_ASSESSMENT)).toBe(false);
  });

  it('an attempt subject whose id differs only by case, surrounding whitespace or a look-alike letter is not about the assessment', () => {
    for (const attemptId of ['ATT-1', 'att-1 ', ' att-1', 'att-1\n', '\u0430tt-1']) {
      expect(isReceiptAboutAssessment(receipt({ subject: attemptSubject(attemptId) }), ATTEMPT_ASSESSMENT)).toBe(false);
    }
    expect(isReceiptAboutAssessment(receipt({ subject: attemptSubject('att-1', 'proj-1 ') }), ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(receipt({ subject: attemptSubject('att-1', 'Proj-1') }), ATTEMPT_ASSESSMENT)).toBe(false);
  });

  it('a subject carrying a field of another kind beside its own is not about the assessment', () => {
    const mixed = subject({ attemptId: 'att-1', chainName: 'main', integrationHeadSha: HEAD });
    expect(isReceiptAboutAssessment(receipt({ subject: mixed }), ATTEMPT_ASSESSMENT)).toBe(false);
  });

  it('a receipt without a subject is about the chain assessment that has its attemptId and projectId', () => {
    expect(isReceiptAboutAssessment(receipt({ attemptId: 'chain:proj-1:main' }), CHAIN_ASSESSMENT)).toBe(true);
  });

  it('a subject of an unknown kind, or one missing the fields of its kind, is not about the assessment', () => {
    expect(isReceiptAboutAssessment(receipt({ subject: { kind: 'lane', projectId: 'proj-1' } }), ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(receipt({ subject: subject({ kind: 'attempt' }) }), ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(receipt({ subject: null }), ATTEMPT_ASSESSMENT)).toBe(false);
  });

  it('null, a string, an array and an empty object are never about an assessment', () => {
    for (const value of [null, undefined, 'att-1', [], {}]) {
      expect(isReceiptAboutAssessment(value, ATTEMPT_ASSESSMENT)).toBe(false);
      expect(isReceiptAboutAssessment(receipt(), value)).toBe(false);
    }
  });

  it('an accessor subject or attemptId reads as not about the assessment and the getter never runs', () => {
    let ran = 0;
    const withSubjectGetter = receipt();
    Object.defineProperty(withSubjectGetter, 'subject', { enumerable: true, get() { ran += 1; return undefined; } });
    const withAttemptGetter: Record<string, unknown> = { projectId: 'proj-1' };
    Object.defineProperty(withAttemptGetter, 'attemptId', { enumerable: true, get() { ran += 1; return 'att-1'; } });
    expect(isReceiptAboutAssessment(withSubjectGetter, ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(withAttemptGetter, ATTEMPT_ASSESSMENT)).toBe(false);
    expect(ran).toBe(0);
  });

  it('ids of the wrong primitive type are never a match, even when both sides carry the same value', () => {
    expect(isReceiptAboutAssessment(receipt({ attemptId: 7 }), { projectId: 'proj-1', attemptId: 7 })).toBe(false);
    expect(isReceiptAboutAssessment(receipt({ projectId: 7 }), { projectId: 7, attemptId: 'att-1' })).toBe(false);
    expect(isReceiptAboutAssessment(receipt({ attemptId: '' }), { projectId: 'proj-1', attemptId: '' })).toBe(false);
  });

  it('inherited ids and a prototype-polluting __proto__ key never supply the ids of a receipt', () => {
    const inherited = Object.create({ projectId: 'proj-1', attemptId: 'att-1' }) as Record<string, unknown>;
    const polluted = JSON.parse('{"__proto__":{"projectId":"proj-1","attemptId":"att-1"}}') as Record<string, unknown>;
    expect(isReceiptAboutAssessment(inherited, ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(polluted, ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(receipt(), inherited)).toBe(false);
  });

  it('a receipt whose property descriptors cannot be read is not about the assessment and nothing throws', () => {
    const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } });
    expect(isReceiptAboutAssessment(hostile, ATTEMPT_ASSESSMENT)).toBe(false);
    expect(isReceiptAboutAssessment(receipt(), hostile)).toBe(false);
  });
});
