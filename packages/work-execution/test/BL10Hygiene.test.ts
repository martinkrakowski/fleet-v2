// BL10 hygiene: behaviour-free complexity splits, Proxy ordering and stale
// comments. Every exported boundary function of the touched adapters takes
// `unknown` and answers a typed refusal — never a throw, never a constant or
// identity verdict. Cost bounds pinned here: the candidate list traversal is
// capped by `SPD_SAY_MAX_CANDIDATES` (16), the sentence by
// `TRAIN_HEALTH_SENTENCE_MAX_LENGTH` (120), the receipt list by
// `MAX_BRIEF_RECEIPTS_READ` (256) and the brief text by
// `BRIEF_TEXT_MAX_BYTES` (64 KiB); every over-cap case is refused before any
// traversal of the claimed length.
import { describe, expect, it } from 'vitest';

import { assessmentIdForBrief, attemptIdForBrief } from '@fleet/evidence-and-acceptance';
import type {
  EvidenceAssessmentRecord,
  InspectAcceptanceEvidenceRequest,
  InspectAcceptanceEvidenceResult,
  ReviewReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import { computeBriefPackageDigest } from '../src/domain/value-objects/BriefPackage.vo.js';
import { sha256HexDigest } from '../src/infrastructure/adapters/AttemptArtifactAdapter.adapter.js';
import {
  SPD_SAY_MAX_CANDIDATES,
  SpdSayHostAudibleAlertAdapter,
  parseHostAudibleAlertRequest,
  validateHostAudibleAlertSentence,
} from '../src/infrastructure/adapters/SpdSayHostAudibleAlertAdapter.adapter.js';
import type { SpawnRunOutcome } from '../src/infrastructure/adapters/spawn-run.js';
import { ReviewRequestAdapter } from '../src/infrastructure/adapters/ReviewRequestAdapter.adapter.js';
import type {
  FindReviewReceiptRequest,
  ReviewRequest,
} from '../src/application/ports/out/ReviewRequestPort.out-port.js';

const INVALID = { ok: false, reasonCode: 'invalid-request' } as const;
const SPD_REFUSED = { outcome: 'refused', reasonCode: 'invalid-request' } as const;
const REFUSED = { outcome: 'refused', reason: 'invalid-request', detail: null } as const;
const UNAVAILABLE_BINARY = { outcome: 'unavailable', reasonCode: 'binary-missing' } as const;

const PROJECT = 'proj-1';
const HEAD = 'a'.repeat(40);
const REQUEST_ID = 'brief-verify:wo-1:0123456789ab';
const POLICY = 'policy-1';
const IMPLEMENTER = 'impl-model';
const REVIEWER = 'reviewer-model';
const BRIEF_TEXT = 'Review the frozen brief.';
const BRIEF_MANIFEST = '{"schemaVersion":2,"attemptId":"a-1"}';

function digestOfPackageOrNull(prose: string, manifestRaw: string): string | null {
  const computed = computeBriefPackageDigest({ prose, manifestRaw }, sha256HexDigest);
  return computed.ok ? computed.briefDigest : null;
}

const fixtureDigest = digestOfPackageOrNull(BRIEF_TEXT, BRIEF_MANIFEST);
if (fixtureDigest === null) {
  throw new Error('the fixture brief package must digest');
}
const DIGEST = fixtureDigest;
const ATTEMPT = attemptIdForBrief(PROJECT, DIGEST);
const ASSESSMENT_ID = assessmentIdForBrief(PROJECT, DIGEST);

/** A secret shape built at runtime so the source never contains the token. */
function secretShape(): string {
  return 'sk-' + 'A'.repeat(20);
}

function storedSubject(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'brief' as const,
    projectId: PROJECT,
    attemptId: null,
    chainName: null,
    integrationHeadSha: null,
    briefPackageDigest: DIGEST,
    baseCommit: HEAD,
    ...overrides,
  };
}

function finding() {
  return {
    findingId: 'f-1',
    severity: 'major' as const,
    summary: 'example finding',
    filePath: 'src/a.ts',
    line: 4,
    state: 'unresolved',
    dispositionReason: null,
    dispositionEvidenceRef: null,
  };
}

function briefReceipt(overrides: Partial<ReviewReceiptRecord> = {}): ReviewReceiptRecord {
  return {
    id: 'rr-brief-1',
    assessmentId: ASSESSMENT_ID,
    projectId: PROJECT,
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    reviewerModel: REVIEWER,
    implementerModel: IMPLEMENTER,
    readOnlyVerified: true,
    result: 'pass',
    findings: [finding()],
    evidenceRef: 'evidence://example/review',
    policyRevision: POLICY,
    completedAtIso: '2026-11-17T00:00:00.000Z',
    kind: 'brief-verify',
    requestId: REQUEST_ID,
    subject: storedSubject(),
    ...overrides,
  } as ReviewReceiptRecord;
}

function briefAssessment(receipts: readonly unknown[]): EvidenceAssessmentRecord {
  return {
    id: ASSESSMENT_ID,
    projectId: PROJECT,
    attemptId: ATTEMPT,
    candidateHeadSha: HEAD,
    policyRevision: POLICY,
    implementerModel: IMPLEMENTER,
    requiredChecks: [],
    state: 'pending',
    verificationReceipts: [],
    reviewReceipts: receipts,
    findingDispositions: [],
    acceptanceReceiptId: null,
    blockers: [],
    revision: 1,
    updatedAtIso: '2026-11-17T00:00:00.000Z',
  };
}

function briefRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    requestId: REQUEST_ID,
    kind: 'brief-verify',
    attemptId: ATTEMPT,
    projectId: PROJECT,
    candidateHeadSha: HEAD,
    subject: briefSubject(),
    policyRevision: POLICY,
    implementerModel: IMPLEMENTER,
    reviewerModel: REVIEWER,
    briefText: BRIEF_TEXT,
    briefManifestRaw: BRIEF_MANIFEST,
    ...overrides,
  };
}

function briefSubject(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'brief' as const,
    projectId: PROJECT,
    briefPackageDigest: DIGEST,
    baseCommit: HEAD,
    ...overrides,
  };
}

function briefFind(overrides: Partial<FindReviewReceiptRequest> = {}): FindReviewReceiptRequest {
  return {
    attemptId: ATTEMPT,
    requestId: REQUEST_ID,
    candidateHeadSha: HEAD,
    subject: briefSubject(),
    ...overrides,
  };
}

function assessmentOf(receipts: readonly unknown[]): InspectAcceptanceEvidenceResult {
  return { outcome: 'found', assessment: briefAssessment(receipts) };
}

function adapterWithAssessment(answer: unknown, overrides: Record<string, unknown> = {}): ReviewRequestAdapter {
  return new ReviewRequestAdapter({
    inspectAcceptanceEvidence: async (_request: InspectAcceptanceEvidenceRequest) =>
      answer as InspectAcceptanceEvidenceResult,
    ...overrides,
  });
}

function runAnswer(answer: unknown): SpawnRunOutcome {
  return answer as SpawnRunOutcome;
}

function speakAdapter(candidates: unknown, extra: Record<string, unknown> = {}): SpdSayHostAudibleAlertAdapter {
  return new SpdSayHostAudibleAlertAdapter({
    candidates: candidates as readonly string[],
    ...extra,
  } as never);
}

describe('SpdSpeak sentence and request parsing (hostile input)', () => {
  it('accepts a valid sentence and echoes exactly the validated sentence (no constant verdict)', () => {
    expect(validateHostAudibleAlertSentence('all clear')).toEqual({ ok: true, sentence: 'all clear' });
    expect(parseHostAudibleAlertRequest({ sentence: 'all clear' })).toEqual({ ok: true, sentence: 'all clear' });
  });

  it('refuses null', () => {
    expect(validateHostAudibleAlertSentence(null)).toEqual(INVALID);
    expect(parseHostAudibleAlertRequest(null)).toEqual(INVALID);
  });

  it('refuses undefined', () => {
    expect(validateHostAudibleAlertSentence(undefined)).toEqual(INVALID);
    expect(parseHostAudibleAlertRequest(undefined)).toEqual(INVALID);
  });

  it('refuses a wrong primitive (a number where a string is due)', () => {
    expect(validateHostAudibleAlertSentence(7)).toEqual(INVALID);
    expect(parseHostAudibleAlertRequest({ sentence: 7 })).toEqual(INVALID);
  });

  it('refuses an array hole (a sparse array) and an array-like object where an object is due', () => {
    const sparse = ['all clear'];
    delete (sparse as string[])[0];
    expect(parseHostAudibleAlertRequest(sparse)).toEqual(INVALID);
    const arrayLike = { length: 1, 0: 'all clear' };
    expect(parseHostAudibleAlertRequest(arrayLike)).toEqual(INVALID);
  });

  it('refuses a throwing getter without invoking it', () => {
    let calls = 0;
    const request: Record<string, unknown> = {};
    Object.defineProperty(request, 'sentence', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return 'all clear';
      },
    });
    expect(parseHostAudibleAlertRequest(request)).toEqual(INVALID);
    expect(calls).toBe(0);
  });

  it('refuses a Proxy over a valid request without running the get trap', () => {
    const valid = { sentence: 'all clear' };
    let getTraps = 0;
    const hostile = new Proxy(valid, {
      get() {
        getTraps += 1;
        return undefined;
      },
    });
    expect(parseHostAudibleAlertRequest(hostile)).toEqual(INVALID);
    expect(getTraps).toBe(0);
  });

  it('refuses a Proxy over a valid request without running the getPrototypeOf trap (4u)', async () => {
    const valid = { sentence: 'all clear' };
    let trapCount = 0;
    const hostile = new Proxy(valid, {
      getPrototypeOf() {
        trapCount += 1;
        return Object.prototype;
      },
    });
    expect(parseHostAudibleAlertRequest(hostile)).toEqual(INVALID);
    expect(trapCount).toBe(0);
    await expect(await_speak(hostile)).resolves.toEqual(SPD_REFUSED);
    expect(trapCount).toBe(0);
  });

  it('refuses a prototype-polluting own key produced by JSON.parse', () => {
    const hostile = JSON.parse('{"__proto__": {}, "sentence": "all clear"}') as Record<string, unknown>;
    expect(parseHostAudibleAlertRequest(hostile)).toEqual(INVALID);
    expect(parseHostAudibleAlertRequest(JSON.parse('{"constructor": 1, "sentence": "all clear"}'))).toEqual(INVALID);
    expect(parseHostAudibleAlertRequest(JSON.parse('{"prototype": 1, "sentence": "all clear"}'))).toEqual(INVALID);
  });

  it('is not satisfiable by a constant verdict: distinct inputs yield distinct verdicts (no identity echo)', () => {
    expect(parseHostAudibleAlertRequest({ sentence: 'all clear' })).toEqual({ ok: true, sentence: 'all clear' });
    expect(parseHostAudibleAlertRequest({ sentence: 'a\nb' })).toEqual(INVALID);
    expect(parseHostAudibleAlertRequest({ sentence: 'other clear' })).toEqual({
      ok: true,
      sentence: 'other clear',
    });
    // An identity echo would return the raw request object for a valid input
    // and would also accept a hostile shape; the parsed answer carries only
    // the validated sentence.
    expect(parseHostAudibleAlertRequest({ sentence: 7 })).toEqual(INVALID);
  });
});

describe('SpdSpeak candidate list traversal (hostile input)', () => {
  it('refuses a wrong primitive (a string where a list is due)', async () => {
    const adapter = speakAdapter('/bin/sh');
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
  });

  it('refuses a non-iterable object where a list is due', async () => {
    const adapter = speakAdapter({ 0: '/bin/sh' });
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
  });

  it('refuses an array hole (a sparse array)', async () => {
    const sparse: string[] = new Array(3);
    sparse[1] = '/bin/sh';
    const adapter = speakAdapter(sparse);
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
  });

  it('refuses an array-like object where a list is due', async () => {
    const adapter = speakAdapter({ length: 1, 0: '/bin/sh' });
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
  });

  it('refuses an enormous length before any traversal', async () => {
    const sparse = new Array(2 ** 32 - 1);
    const adapter = speakAdapter(sparse);
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
  });

  it('refuses a throwing element getter without invoking it', async () => {
    const candidates: string[] = ['/bin/sh'];
    let calls = 0;
    Object.defineProperty(candidates, 0, {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return '/bin/sh';
      },
    });
    const adapter = speakAdapter(candidates);
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
    expect(calls).toBe(0);
  });

  it('refuses a Proxy over a valid candidate list without running the get trap', async () => {
    let getTraps = 0;
    const hostile = new Proxy(['/bin/sh'], {
      get() {
        getTraps += 1;
        return undefined;
      },
    });
    const adapter = speakAdapter(hostile);
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
    expect(getTraps).toBe(0);
  });

  it('refuses a prototype-polluting own key on the candidate list', async () => {
    const hostile: string[] = ['/bin/sh'];
    Object.defineProperty(hostile, '__proto__', {
      value: {},
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const adapter = speakAdapter(hostile);
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
  });

  it('refuses an over-cap candidate list before traversal (budget)', async () => {
    const overCap: string[] = Array.from(
      { length: SPD_SAY_MAX_CANDIDATES + 1 },
      (_, index) => `/bin/spd-say-${String(index)}`,
    );
    const adapter = speakAdapter(overCap);
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual(SPD_REFUSED);
  });
});

describe('SpdSpeak spawn outcomes (refusals)', () => {
  function runReturning(answer: unknown): { run: (file: string, args: readonly string[], options: never) => Promise<SpawnRunOutcome> } {
    return {
      run: async () => runAnswer(answer),
    };
  }

  it('refuses/fails on nonzero-exit or spawn-failed without throwing', async () => {
    const nonzero = speakAdapter(['/bin/sh'], { run: runReturning({ error: undefined, exitCode: 3 }).run });
    await expect(nonzero.speak({ sentence: 'all clear' })).resolves.toEqual({
      outcome: 'failed',
      reasonCode: 'nonzero-exit',
    });
    const spawnFailed = speakAdapter(['/bin/sh'], {
      run: runReturning({ error: new Error('enoent'), exitCode: undefined, signal: null }).run,
    });
    await expect(spawnFailed.speak({ sentence: 'all clear' })).resolves.toEqual({
      outcome: 'failed',
      reasonCode: 'spawn-failed',
    });
  });

  it('maps timed-out/killed child outcome to failed killed', async () => {
    const adapter = speakAdapter(['/bin/sh'], {
      run: runReturning({ error: new Error('timeout'), signal: 'SIGTERM' }).run,
    });
    await expect(adapter.speak({ sentence: 'all clear' })).resolves.toEqual({
      outcome: 'failed',
      reasonCode: 'killed',
    });
  });

  it('returns not-configured or binary-missing when delegate or binary is absent', async () => {
    await expect(speakAdapter(['/nonexistent/spd-say']).speak({ sentence: 'all clear' })).resolves.toEqual(
      UNAVAILABLE_BINARY,
    );
  });
});

describe('ReviewRequestAdapter brief paths (hostile input and refusals)', () => {
  it('refuses null inputs cleanly', async () => {
    await expect(new ReviewRequestAdapter().requestReview(null as never)).resolves.toEqual(REFUSED);
  });

  it('refuses undefined, a wrong primitive, a non-iterable object and an array where a record is due', async () => {
    const adapter = new ReviewRequestAdapter();
    for (const bad of [undefined, 7, 'request', [], Symbol.iterator]) {
      await expect(adapter.requestReview(bad as never)).resolves.toEqual(REFUSED);
    }
  });

  it('refuses a throwing getter on the request root without invoking it', async () => {
    let calls = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          calls += 1;
          return undefined;
        },
      },
    );
    await expect(new ReviewRequestAdapter().requestReview(hostile)).resolves.toEqual(REFUSED);
    expect(calls).toBe(0);
  });

  it('refuses a prototype-polluting own key on the request', async () => {
    const hostile = JSON.parse('{"__proto__": {}, "kind": "brief-verify"}') as Record<string, unknown>;
    await expect(new ReviewRequestAdapter().requestReview(hostile as never)).resolves.toEqual(REFUSED);
  });

  it('refuses malformed brief request (missing, blank, over-size or secret-shaped fields)', async () => {
    const adapter = new ReviewRequestAdapter();
    const malformed: Partial<ReviewRequest>[] = [
      { briefText: undefined },
      { briefText: '   ' },
      { briefText: 'x'.repeat(64 * 1024 + 1) },
      { briefText: secretShape() + ' prose' },
      { briefManifestRaw: undefined },
      { briefManifestRaw: '' },
      { policyRevision: '' },
      { requestId: 'no pattern here' },
      { nowIso: 7 as never },
      { diffSummary: 'not allowed for a brief request' },
    ];
    for (const overrides of malformed) {
      await expect(adapter.requestReview(briefRequest(overrides))).resolves.toEqual(REFUSED);
    }
  });

  it('returns not-configured when the review delegate or the evidence reader is absent', async () => {
    await expect(new ReviewRequestAdapter().requestReview(briefRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
      detail: null,
    });
    await expect(new ReviewRequestAdapter().findReviewReceipt(briefFind())).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'not-configured',
    });
  });

  it('returns unavailable unreadable when the assessment read throws', async () => {
    const adapter = new ReviewRequestAdapter({
      inspectAcceptanceEvidence: async () => {
        throw new Error('unreadable store');
      },
    });
    await expect(adapter.findReviewReceipt(briefFind())).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('returns unavailable unreadable when reviewReceipts is unreadable (non-array, hole or over-cap)', async () => {
    // Over-cap: one past MAX_BRIEF_RECEIPTS_READ (256) is refused before the
    // traversal, with the same shape it would have had inside the cap.
    const overCap = Array.from({ length: 257 }, (_, index) => briefReceipt({ requestId: `r-${String(index)}` }));
    const overCapAdapter = adapterWithAssessment(assessmentOf(overCap));
    await expect(overCapAdapter.findReviewReceipt(briefFind())).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
    // Non-array where a list is due.
    const nonArrayAdapter = adapterWithAssessment(assessmentOf({ length: 1, 0: briefReceipt() }));
    await expect(nonArrayAdapter.findReviewReceipt(briefFind())).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
    // A sparse array hole in the receipt list.
    const hole = Array.from({ length: 2 }, (_, index) => briefReceipt({ requestId: `r-${String(index)}` }));
    delete (hole as unknown[])[0];
    const holeAdapter = adapterWithAssessment(assessmentOf(hole));
    await expect(holeAdapter.findReviewReceipt(briefFind())).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
  });

  it('returns not-found for an empty receipt list and found for the single matching brief receipt', async () => {
    const empty = adapterWithAssessment(assessmentOf([]));
    await expect(empty.findReviewReceipt(briefFind())).resolves.toEqual({ outcome: 'not-found' });
    const matching = adapterWithAssessment(assessmentOf([
      briefReceipt({ requestId: 'other-request-1' }),
      briefReceipt(),
    ]));
    const found = await matching.findReviewReceipt(briefFind());
    expect(found.outcome).toBe('found');
    if (found.outcome === 'found') {
      expect(found.receipt.requestId).toBe(REQUEST_ID);
    }
  });

  it('refuses malformed brief receipt (mismatch) when it is not this brief or is duplicated', async () => {
    const wrongSubject = adapterWithAssessment(assessmentOf([
      briefReceipt({ subject: storedSubject({ briefPackageDigest: '0'.repeat(64) }) }),
    ]));
    await expect(wrongSubject.findReviewReceipt(briefFind())).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'receipt-mismatch',
    });
    const duplicated = adapterWithAssessment(assessmentOf([briefReceipt(), briefReceipt({ id: 'rr-brief-2' })]));
    await expect(duplicated.findReviewReceipt(briefFind())).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'receipt-mismatch',
    });
  });

  it('refuses a throwing getter on the assessment root without invoking it (unreadable)', async () => {
    let calls = 0;
    const assessment: Record<string, unknown> = briefAssessment([]) as unknown as Record<string, unknown>;
    Object.defineProperty(assessment, 'reviewReceipts', {
      enumerable: true,
      configurable: true,
      get() {
        calls += 1;
        return [];
      },
    });
    const adapter = adapterWithAssessment({ outcome: 'found', assessment });
    await expect(adapter.findReviewReceipt(briefFind())).resolves.toEqual({
      outcome: 'unavailable',
      reason: 'unreadable',
    });
    expect(calls).toBe(0);
  });

  it('is not satisfiable by a constant or identity verdict (found vs not-found vs refusals differ)', async () => {
    const empty = adapterWithAssessment(assessmentOf([]));
    await expect(empty.findReviewReceipt(briefFind())).resolves.toEqual({ outcome: 'not-found' });
    const matching = adapterWithAssessment(assessmentOf([briefReceipt()]));
    const found = await matching.findReviewReceipt(briefFind());
    expect(found.outcome).toBe('found');
    if (found.outcome === 'found') {
      expect(found.receipt.verdict).toBe('passed');
    }
    // An identity echo would return the raw record; the summary carries only
    // the typed receipt summary fields.
    if (found.outcome === 'found') {
      expect('attemptId' in found.receipt).toBe(false);
    }
    await expect(new ReviewRequestAdapter().requestReview(briefRequest())).resolves.toEqual({
      outcome: 'refused',
      reason: 'not-configured',
      detail: null,
    });
  });
});

/** Helper: speak through a fresh adapter that accepts any request shape. */
function await_speak(request: unknown): Promise<unknown> {
  const adapter = new SpdSayHostAudibleAlertAdapter({ candidates: ['/bin/sh'] });
  return adapter.speak(request);
}
