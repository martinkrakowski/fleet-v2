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

/** Stands in for the SDK binding, which reports that it declared no tools. */
function answers(object: unknown): ApiReviewGenerate {
  return async (): Promise<ApiReviewGenerateResult> => ({ object, readOnly: true });
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
      schemaEnforcement: 'native-json-schema',
      location: location(),
      generate: answers({ result: 'pass', findings: [] }),
    });
    await expect(run(request)).rejects.toThrow(/base URL/);
  });

  it('refuses when no provider call is bound', async () => {
    const run = createApiReviewTransport({
      baseURL: 'http://10.0.0.1:4176/inception/v1',
      model: 'mercury-3',
      schemaEnforcement: 'native-json-schema',
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

  it('a cyclic answer carries an extra key, so it is unknown and still serialises', async () => {
    const cyclic: Record<string, unknown> = { result: 'pass', findings: [] };
    cyclic['self'] = cyclic;
    const run = transport(answers(cyclic));
    const result = await run(request);
    // The extra key fails additionalProperties, so it never reaches a pass, and
    // rawOutput is built from the decoded verdict rather than the cyclic object.
    expect(result.result).toBe('unknown');
    expect(result.unknownReason).toBe('unparseable-verdict');
    expect(JSON.parse(result.rawOutput)).toEqual({ result: 'unknown', unknownReason: 'unparseable-verdict', findings: [] });
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

describe('review round 1: the defects both reviewers found', () => {
  it('a blank diff is refused, not graded (the production case base === head)', async () => {
    let called = false;
    const run = transport(
      async () => {
        called = true;
        return { object: { result: 'pass', findings: [] } };
      },
      { readDiff: async () => '' },
    );
    await expect(run(request)).rejects.toThrow(/could not be seen/);
    expect(called).toBe(false);
  });

  it('a whitespace-only diff is refused too', async () => {
    const run = transport(answers({ result: 'pass', findings: [] }), { readDiff: async () => '\n  \t\n' });
    await expect(run(request)).rejects.toThrow(/could not be seen/);
  });

  it('an extra top-level key fails additionalProperties and never passes', () => {
    expect(decodeApiVerdict({ result: 'pass', findings: [], note: 'anything' })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
  });

  it('an extra key on a finding is rejected', () => {
    expect(
      decodeApiVerdict({
        result: 'fail',
        findings: [{ severity: 'major', summary: 'x', filePath: null, line: 1, extra: 'text' }],
      }),
    ).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
  });

  it('a TOP-LEVEL getter cannot supply a pass and cannot throw out of the decoder', () => {
    expect(
      decodeApiVerdict({
        get result() {
          return 'pass';
        },
        findings: [],
      }),
    ).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });

    expect(() =>
      decodeApiVerdict({
        get result(): string {
          throw new Error('should not escape');
        },
        findings: [],
      }),
    ).not.toThrow();
  });

  it('a revoked Proxy is unknown, not a thrown TypeError', () => {
    const revocable = Proxy.revocable({ result: 'pass', findings: [] }, {});
    revocable.revoke();
    expect(() => decodeApiVerdict(revocable.proxy)).not.toThrow();
    expect(decodeApiVerdict(revocable.proxy)).toMatchObject({ result: 'unknown' });
  });

  it('a Proxy whose descriptor trap throws is unknown, not a throw', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(): never {
          throw new Error('trap');
        },
        ownKeys(): never {
          throw new Error('trap');
        },
      },
    );
    expect(() => decodeApiVerdict(hostile)).not.toThrow();
    expect(decodeApiVerdict(hostile)).toMatchObject({ result: 'unknown' });
  });

  it('an index-level getter on the findings array cannot run', () => {
    const arr: unknown[] = [];
    Object.defineProperty(arr, '0', {
      enumerable: true,
      configurable: true,
      get(): never {
        throw new Error('should not run');
      },
    });
    arr.length = 1;
    expect(() => decodeApiVerdict({ result: 'fail', findings: arr })).not.toThrow();
    expect(decodeApiVerdict({ result: 'fail', findings: arr })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
  });

  it('a line number that is an integer but not a SAFE integer is rejected', () => {
    expect(
      decodeApiVerdict({ result: 'fail', findings: [{ severity: 'major', summary: 'x', filePath: 'a.ts', line: 1e100 }] }),
    ).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
  });

  it('an answer the library could not parse is unparseable, not an unreachable endpoint', async () => {
    const run = transport(async () => ({ object: undefined, noObject: true }));
    const result = await run(request);
    expect(result.result).toBe('unknown');
    expect(result.unknownReason).toBe('unparseable-verdict');
  });

  it('a declared schema the endpoint ignored is a refusal, not a decoder-only grade', async () => {
    const run = transport(async () => ({
      object: { result: 'pass', findings: [] },
      warnings: ['unsupported:responseFormat'],
    }));
    await expect(run(request)).rejects.toThrow(/did not enforce the declared response schema/);
  });

  it('the same warning is not a refusal for a seat that declared json-object', async () => {
    const run = createApiReviewTransport({
      baseURL: 'http://10.0.0.1:4176/inception/v1',
      model: 'mercury-3',
      schemaEnforcement: 'json-object',
      location: location(),
      makeNonce: () => '0123456789abcdef',
      generate: async () => ({
        object: { result: 'pass', findings: [] },
        warnings: ['unsupported:responseFormat'],
      }),
    });
    await expect(run(request)).resolves.toMatchObject({ result: 'pass' });
  });

  it('rawOutput carries only validated fields, never provider text the decoder rejected', async () => {
    const run = transport(
      answers({
        result: 'fail',
        findings: [{ severity: 'major', summary: 'real finding', filePath: 'a.ts', line: 3 }],
      }),
    );
    const result = await run(request);
    expect(JSON.parse(result.rawOutput)).toEqual({
      result: 'fail',
      findings: [{ severity: 'major', summary: 'real finding', filePath: 'a.ts', line: 3 }],
    });
  });
});

describe('review round 2: the remaining findings', () => {
  it('a throwing getter on the provider error cannot escape the classification', async () => {
    const hostile = {};
    Object.defineProperty(hostile, 'statusCode', {
      enumerable: true,
      get(): never {
        throw new Error('sk-leaked-from-a-getter');
      },
    });
    const run = transport(async () => {
      throw hostile;
    });
    // It must be a typed transport error with a fixed reason, not the hostile one.
    await expect(run(request)).rejects.toThrow(/^the reviewer endpoint could not be reached$/);
  });

  it('an accessor-backed name is not trusted as a timeout', async () => {
    const hostile = {};
    Object.defineProperty(hostile, 'name', { enumerable: true, get: () => 'AbortError' });
    const run = transport(async () => {
      throw hostile;
    });
    await expect(run(request)).rejects.toThrow(/could not be reached/);
  });

  it('a finding missing filePath or line is rejected: the schema requires them', () => {
    expect(decodeApiVerdict({ result: 'fail', findings: [{ severity: 'major', summary: 'x', line: 1 }] })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
    expect(
      decodeApiVerdict({ result: 'fail', findings: [{ severity: 'major', summary: 'x', filePath: 'a.ts' }] }),
    ).toMatchObject({ result: 'unknown', unknownReason: 'unparseable-verdict' });
  });

  it('an explicit null filePath and line are still accepted', () => {
    expect(
      decodeApiVerdict({ result: 'fail', findings: [{ severity: 'major', summary: 'x', filePath: null, line: null }] }),
    ).toMatchObject({ result: 'fail' });
  });

  it('read-only is reported by the call, not assumed of an arbitrary callback', async () => {
    const silent = createApiReviewTransport({
      baseURL: 'http://10.0.0.1:4176/inception/v1',
      model: 'mercury-3',
      schemaEnforcement: 'native-json-schema',
      location: location(),
      makeNonce: () => '0123456789abcdef',
      // A callback that does not say it was read-only: the transport must not claim it.
      generate: async () => ({ object: { result: 'pass', findings: [] } }),
    });
    await expect(silent(request)).resolves.toMatchObject({ result: 'pass', readOnlyVerified: false });
  });
});

describe('pre-merge re-check: a 429 that actually surfaces', () => {
  function retryWrapped(status: number): unknown {
    // The shape the library throws once the retry budget is exceeded: the
    // wrapper carries no statusCode of its own; the real error is in `errors`
    // and `lastError`.
    const inner = Object.assign(new Error('rate limited'), { statusCode: status });
    return Object.assign(new Error('maxRetriesExceeded'), {
      reason: 'maxRetriesExceeded',
      errors: [inner, inner],
      lastError: inner,
    });
  }

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

  it('a wrapped 429 is seat-busy, so the seat chain rotates', async () => {
    expect(await codeFor(retryWrapped(429))).toBe('seat-busy');
  });

  it('a wrapped 402 is transport-failed', async () => {
    expect(await codeFor(retryWrapped(402))).toBe('transport-failed');
  });

  it('a 429 nested behind cause is found too', async () => {
    const inner = Object.assign(new Error('rate limited'), { statusCode: 429 });
    expect(await codeFor(Object.assign(new Error('wrapped'), { cause: inner }))).toBe('seat-busy');
  });

  it('the chain walk terminates on a self-referencing error', async () => {
    const loop: Record<string, unknown> = { message: 'loop' };
    loop['cause'] = loop;
    loop['errors'] = [loop];
    expect(await codeFor(loop)).toBe('transport');
  });

  it('a getter in the chain cannot run', async () => {
    const hostile = {};
    Object.defineProperty(hostile, 'errors', {
      enumerable: true,
      get(): never {
        throw new Error('should not run');
      },
    });
    expect(await codeFor(hostile)).toBe('transport');
  });

  it('an over-long errors array is not walked', async () => {
    const inner = Object.assign(new Error('rate limited'), { statusCode: 429 });
    const many = new Array(20).fill(inner);
    expect(await codeFor(Object.assign(new Error('many'), { errors: many }))).toBe('transport');
  });

  it('more than 200 findings is still refused by the decoder, not by the schema', () => {
    const findings = new Array(201).fill({ severity: 'minor', summary: 'x', filePath: null, line: null });
    expect(decodeApiVerdict({ result: 'fail', findings })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
  });
});
