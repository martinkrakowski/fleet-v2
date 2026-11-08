import { describe, expect, it } from 'vitest';

import { createApiReviewTransport, decodeApiVerdict, MAX_API_REVIEW_DIFF_BYTES } from './ApiReviewTransport.adapter.js';
import type { ApiReviewGenerate, ApiReviewGenerateResult } from './ApiReviewTransport.adapter.js';
import { ReviewTransportError } from './OcmReviewTransport.adapter.js';
import type { ReviewLocation } from './ReviewTransportRouter.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function location(overrides: Partial<ReviewLocation> = {}): ReviewLocation {
  return {
    worktreePath: '/tmp/wt',
    baseCommit: BASE,
    route: { kind: 'none', reason: 'not an opencode route' },
    readHead: async () => HEAD,
    readStatus: async () => '',
    readDiff: async () => 'diff --git a/x b/x\n+one line\n',
    ...overrides,
  };
}

function transport(generate: ApiReviewGenerate, locationOverrides: Partial<ReviewLocation> = {}) {
  return createApiReviewTransport({
    baseURL: 'http://10.0.0.1:4176/inception/v1',
    model: 'mercury-3',
    schemaEnforcement: 'native-json-schema',
    location: location(locationOverrides),
    makeNonce: () => '0123456789abcdef',
    generate,
  });
}

const request = {
  attemptId: 'att-1',
  candidateHeadSha: HEAD,
  implementerModel: 'inception/mercury-3',
  reviewerModel: 'openai/gpt-6-luna',
};

function answers(object: unknown): ApiReviewGenerate {
  return async (): Promise<ApiReviewGenerateResult> => ({ object });
}

describe('decodeApiVerdict: a malformed verdict is unknown with a reason, never a pass', () => {
  it('decodes a clean pass', () => {
    expect(decodeApiVerdict({ result: 'pass', findings: [] })).toEqual({ result: 'pass', findings: [] });
  });

  it('decodes findings and numbers them', () => {
    const parsed = decodeApiVerdict({
      result: 'fail',
      findings: [
        { severity: 'blocker', summary: 'unchecked input', filePath: 'src/a.ts', line: 12 },
        { severity: 'minor', summary: 'naming', filePath: null, line: null },
      ],
    });
    expect(parsed.result).toBe('fail');
    expect(parsed.findings.map((f) => f.findingId)).toEqual(['review-1', 'review-2']);
    expect(parsed.findings[0]).toMatchObject({ severity: 'blocker', filePath: 'src/a.ts', line: 12, state: 'unresolved' });
  });

  it('a null or undefined answer is unknown/empty, not a pass', () => {
    expect(decodeApiVerdict(null)).toMatchObject({ result: 'unknown', unknownReason: 'empty' });
    expect(decodeApiVerdict(undefined)).toMatchObject({ result: 'unknown', unknownReason: 'empty' });
  });

  it('a non-object answer is unparseable, not a pass', () => {
    expect(decodeApiVerdict('NO DEFECTS')).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
    expect(decodeApiVerdict([])).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
  });

  it('an unrecognised result is unparseable', () => {
    expect(decodeApiVerdict({ result: 'passed', findings: [] })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
  });

  it('a missing findings array is unparseable, even with result pass', () => {
    expect(decodeApiVerdict({ result: 'pass' })).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
  });

  it('fail with no findings is no-findings-on-fail, never a pass', () => {
    expect(decodeApiVerdict({ result: 'fail', findings: [] })).toMatchObject({
      result: 'unknown',
      unknownReason: 'no-findings-on-fail',
    });
  });

  it('result unknown stays unknown and keeps its reason', () => {
    expect(decodeApiVerdict({ result: 'unknown', findings: [] })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
  });

  // json-object enforcement promises valid JSON and nothing about the shape, so
  // every one of these is a shape the schema should have excluded and did not.
  it('an unrecognised severity is unparseable', () => {
    expect(
      decodeApiVerdict({ result: 'fail', findings: [{ severity: 'critical', summary: 'x', filePath: null, line: null }] }),
    ).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
  });

  it('a blank summary is unparseable', () => {
    expect(
      decodeApiVerdict({ result: 'fail', findings: [{ severity: 'major', summary: '   ', filePath: null, line: null }] }),
    ).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
  });

  it('a non-integer or zero line is unparseable', () => {
    for (const line of [1.5, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, '12']) {
      expect(
        decodeApiVerdict({ result: 'fail', findings: [{ severity: 'major', summary: 'x', filePath: null, line }] }),
      ).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
    }
  });

  it('a hole in a sparse findings array is unparseable, not skipped', () => {
    const sparse: unknown[] = [{ severity: 'major', summary: 'x', filePath: null, line: 1 }];
    sparse.length = 3;
    expect(decodeApiVerdict({ result: 'fail', findings: sparse })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
  });

  it('a throwing getter on a finding is unparseable and never invoked as a value', () => {
    const hostile = {
      severity: 'major',
      summary: 'x',
      filePath: null,
      get line(): number {
        throw new Error('should never be read');
      },
    };
    expect(decodeApiVerdict({ result: 'fail', findings: [hostile] })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
  });

  it('an inherited result is not an own property and is unparseable', () => {
    const inherited = Object.create({ result: 'pass', findings: [] }) as Record<string, unknown>;
    expect(decodeApiVerdict(inherited)).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
  });

  it('a summary longer than the cap is truncated, not dropped', () => {
    const parsed = decodeApiVerdict({
      result: 'fail',
      findings: [{ severity: 'major', summary: 'y'.repeat(5000), filePath: null, line: null }],
    });
    expect(parsed.result).toBe('fail');
    expect(parsed.findings[0]?.summary.length).toBe(2000);
  });
});

describe('createApiReviewTransport: configuration is declared, never inferred', () => {
  it('refuses an unrecognised schemaEnforcement rather than guessing one', async () => {
    const run = createApiReviewTransport({
      baseURL: 'http://10.0.0.1:4176/inception/v1',
      model: 'mercury-3',
      // A value no operator declared: the point is that this refuses.
      schemaEnforcement: 'whatever' as never,
      location: location(),
      generate: answers({ result: 'pass', findings: [] }),
    });
    await expect(run(request)).rejects.toThrow(ReviewTransportError);
  });

  it('refuses a missing base URL', async () => {
    const run = createApiReviewTransport({
      baseURL: '   ',
      model: 'mercury-3',
      schemaEnforcement: 'tool',
      location: location(),
      generate: answers({ result: 'pass', findings: [] }),
    });
    await expect(run(request)).rejects.toThrow(/base URL/);
  });

  it('refuses when no provider call is bound', async () => {
    const run = createApiReviewTransport({
      baseURL: 'http://10.0.0.1:4176/inception/v1',
      model: 'mercury-3',
      schemaEnforcement: 'tool',
      location: location(),
    });
    await expect(run(request)).rejects.toThrow(/provider call/);
  });
});

describe('createApiReviewTransport: the head and the diff are checked before the call', () => {
  it('refuses when the head moved under the review', async () => {
    let called = false;
    const run = transport(
      async () => {
        called = true;
        return { object: { result: 'pass', findings: [] } };
      },
      { readHead: async () => 'c'.repeat(40) },
    );
    await expect(run(request)).rejects.toThrow(/head moved/);
    expect(called).toBe(false);
  });

  it('refuses an oversized diff rather than truncating it', async () => {
    const run = transport(answers({ result: 'pass', findings: [] }), {
      readDiff: async () => 'x'.repeat(MAX_API_REVIEW_DIFF_BYTES + 1),
    });
    await expect(run(request)).rejects.toThrow(/larger than this transport forwards/);
  });

  it('refuses when the diff cannot be read', async () => {
    const run = transport(answers({ result: 'pass', findings: [] }), { readDiff: async () => null });
    await expect(run(request)).rejects.toThrow(/could not be read/);
  });
});

describe('createApiReviewTransport: provider failures map onto the existing codes', () => {
  async function codeFor(error: unknown): Promise<string> {
    const run = transport(async () => {
      throw error;
    });
    try {
      await run(request);
    } catch (thrown) {
      return thrown instanceof ReviewTransportError ? thrown.code : 'not-a-transport-error';
    }
    return 'no-error';
  }

  it('an abort is a timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(await codeFor(abort)).toBe('timeout');
  });

  it('a 429 is seat-busy, so the seat chain rotates', async () => {
    expect(await codeFor(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe('seat-busy');
  });

  it('a 402 is transport-failed', async () => {
    expect(await codeFor(Object.assign(new Error('payment required'), { statusCode: 402 }))).toBe('transport-failed');
  });

  it('anything else is transport', async () => {
    expect(await codeFor(new Error('socket hang up'))).toBe('transport');
  });

  it('the refusal message carries no provider text, only the class', async () => {
    const run = transport(async () => {
      throw Object.assign(new Error('sk-leaked-key-material is invalid'), { statusCode: 401 });
    });
    await expect(run(request)).rejects.toThrow(/^the reviewer endpoint refused the request$/);
  });
});

describe('createApiReviewTransport: the completed result', () => {
  it('reports read-only structurally, with no claim from the model', async () => {
    const run = transport(answers({ result: 'pass', findings: [] }));
    const result = await run(request);
    expect(result.readOnlyVerified).toBe(true);
    expect(result.result).toBe('pass');
    expect(result.findings).toEqual([]);
    expect(result.completedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('serialises the raw answer itself rather than echoing provider text', async () => {
    const run = transport(answers({ result: 'pass', findings: [] }));
    const result = await run(request);
    expect(JSON.parse(result.rawOutput)).toEqual({ result: 'pass', findings: [] });
  });

  it('survives an unserialisable answer without throwing', async () => {
    const cyclic: Record<string, unknown> = { result: 'pass', findings: [] };
    cyclic['self'] = cyclic;
    const run = transport(answers(cyclic));
    const result = await run(request);
    // The verdict still decodes; only the raw copy degrades.
    expect(result.result).toBe('pass');
    expect(result.rawOutput).toBe('null');
  });

  it('sends the brief and the diff wrapped as untrusted input', async () => {
    let seenPrompt = '';
    const run = transport(async (input) => {
      seenPrompt = input.prompt;
      return { object: { result: 'pass', findings: [] } };
    });
    await run({ ...request, kind: 'brief-check', briefText: 'do the thing' });
    expect(seenPrompt).toContain('0123456789abcdef');
    expect(seenPrompt).toContain('do the thing');
    expect(seenPrompt).toContain('diff --git');
  });

  it('refuses an oversized brief rather than truncating it', async () => {
    const run = transport(answers({ result: 'pass', findings: [] }));
    await expect(run({ ...request, kind: 'brief-check', briefText: 'z'.repeat(70 * 1024) })).rejects.toThrow(
      /brief is larger/,
    );
  });

  it('tells the model it is read-only and that input is untrusted', async () => {
    let seenSystem = '';
    const run = transport(async (input) => {
      seenSystem = input.system;
      return { object: { result: 'pass', findings: [] } };
    });
    await run(request);
    expect(seenSystem).toMatch(/read-only/);
    expect(seenSystem).toMatch(/no command/);
  });
});
