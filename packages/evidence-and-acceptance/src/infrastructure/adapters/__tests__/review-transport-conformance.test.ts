/**
 * RTCONF1 — shared conformance suite for the three independent-review
 * transports. Each transport is driven only through its injectable seams
 * (`spawn` / `generate` / `makeScratchDir` / `makeNonce` / `location`); no
 * subprocess runs and no network call is made.
 *
 * Where a transport diverges from the shared contract today it is recorded
 * with `it.fails` and a `// FINDING (D1): ...` comment; the test-only brief
 * forbids editing production code.
 */

import { describe, expect, it } from 'vitest';

import { IndependentReviewAdapter } from '../IndependentReviewAdapter.adapter.js';
import { decodeApiVerdict } from '../ApiReviewTransport.adapter.js';
import { ReviewTransportError } from '../OcmReviewTransport.adapter.js';
import {
  cliStdout,
  CONFORMANCE_BASE_SHA,
  CONFORMANCE_DIFF,
  CONFORMANCE_HEAD_SHA,
  jsonReply,
  makeApiGenerate,
  makeApiGenerateRejecting,
  makeCliSpawn,
  makeConformanceRequest,
  makeConformanceTransport,
  makeFakeReviewLocation,
  makeOcmSpawn,
  type ConformanceTransportOptions,
} from './review-transport-fakes.js';

describe.each(['cli', 'opencode', 'api'] as const)('review transport conformance: %s', (kind) => {
  const transport = (opts: ConformanceTransportOptions = {}) => makeConformanceTransport(kind, opts);

  // Happy-Path Sanity

  it('returns completed pass with findings=[] and readOnlyVerified=true when output is valid', async () => {
    const result = await transport()(makeConformanceRequest());
    expect(result.result).toBe('pass');
    expect(result.findings).toEqual([]);
    expect(result.readOnlyVerified).toBe(true);
  });

  it('returns completed fail with findings when a blocker finding is reported', async () => {
    const opts: ConformanceTransportOptions =
      kind === 'api'
        ? {
            api: {
              generate: makeApiGenerate({
                object: { result: 'fail', findings: [{ severity: 'blocker', summary: 'data loss', filePath: 'a.txt', line: 1 }] },
                readOnly: true,
              }),
            },
          }
        : kind === 'cli'
          ? {
              cli: {
                spawn: makeCliSpawn(jsonReply('FAIL', [{ severity: 'blocker', file: 'a.txt', line: 1, summary: 'data loss' }])),
              },
            }
          : {
              opencode: {
                spawn: makeOcmSpawn(jsonReply('FAIL', [{ severity: 'blocker', file: 'a.txt', line: 1, summary: 'data loss' }])),
              },
            };
    const result = await transport(opts)(makeConformanceRequest());
    expect(result.result).toBe('fail');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('blocker');
  });

  // Refusals

  // FINDING (D1): cli (CliReviewTransport.adapter.ts:307-309, 418-421) throws
  // `Error('reviewer CLI returned an empty response')` instead of returning
  // `{ result: 'unknown', unknownReason: 'empty' }`; opencode's
  // step_start/step_finish + empty text path returns unknown/empty, and api's
  // null-object decode does too — those two pass; cli is recorded as a fail.
  const emptyTest = kind === 'cli' ? it.fails : it;
  emptyTest('empty transport output returns unknown/empty without throwing or passing', async () => {
    const opts: ConformanceTransportOptions =
      kind === 'cli'
        ? { cli: { spawn: makeCliSpawn('') } }
        : kind === 'opencode'
          ? { opencode: { spawn: makeOcmSpawn('') } }
          : { api: { generate: makeApiGenerate({ object: null, readOnly: true }) } };
    const result = await transport(opts)(makeConformanceRequest());
    expect(result.result).toBe('unknown');
    expect(result.result).not.toBe('pass');
    expect(result.unknownReason).toBe('empty');
  });

  if (kind === 'opencode') {
    // FINDING (D1): opencode (OcmReviewTransport.adapter.ts:1538-1546) with
    // completely empty stdout (no step_finish) returns unknown with
    // `rawOutput: 'stream-incomplete'` and omits `unknownReason: 'empty'`,
    // where the step_start/step_finish + empty text path does carry it.
    it.fails('completely empty opencode stdout returns unknown without an unknownReason', async () => {
      const transport = makeConformanceTransport('opencode', {
        opencode: { spawn: makeOcmSpawn('', { stream: '' }) },
      });
      const result = await transport(makeConformanceRequest());
      expect(result.result).toBe('unknown');
      expect(result.unknownReason).toBe('empty');
    });
  }

  it('malformed output returns unknown/unparseable-verdict without throwing or passing', async () => {
    const opts: ConformanceTransportOptions =
      kind === 'cli'
        ? { cli: { spawn: makeCliSpawn(cliStdout('This is prose.\nNo verdict here.')) } }
        : kind === 'opencode'
          ? { opencode: { spawn: makeOcmSpawn('This is prose.\nNo verdict here.') } }
          : {
              api: {
                generate: makeApiGenerate({ object: { result: 'passed', findings: [] }, readOnly: true }),
              },
            };
    const result = await transport(opts)(makeConformanceRequest());
    expect(result.result).toBe('unknown');
    expect(result.result).not.toBe('pass');
    expect(result.unknownReason).toBe('unparseable-verdict');
  });

  if (kind === 'api') {
    // FINDING (D1): covered by the api case above — the api transport reports
    // a non-JSON reply as `unparseable-verdict` (never a transport failure).
    it('malformed output with noObject returns unknown/unparseable-verdict', async () => {
      const result = await transport({ api: { generate: makeApiGenerate({ object: null, noObject: true }) } })(
        makeConformanceRequest(),
      );
      expect(result.result).toBe('unknown');
      expect(result.unknownReason).toBe('unparseable-verdict');
    });
  }

  it('fail verdict with zero findings returns unknown/no-findings-on-fail', async () => {
    const opts: ConformanceTransportOptions =
      kind === 'api'
        ? { api: { generate: makeApiGenerate({ object: { result: 'fail', findings: [] }, readOnly: true }) } }
        : kind === 'cli'
          ? { cli: { spawn: makeCliSpawn(jsonReply('FAIL', [])) } }
          : { opencode: { spawn: makeOcmSpawn(jsonReply('FAIL', [])) } };
    const result = await transport(opts)(makeConformanceRequest());
    expect(result.result).toBe('unknown');
    expect(result.findings).toEqual([]);
    expect(result.unknownReason).toBe('no-findings-on-fail');
  });

  // FINDING (D1): cli (CliReviewTransport.adapter.ts:353-355) throws a plain
  // `Error` instead of `ReviewTransportError(..., 'transport-failed')`;
  // opencode (OcmReviewTransport.adapter.ts:1393-1407) returns
  // `{ result: 'unknown', rawOutput: 'diff-unavailable' }` instead of
  // throwing `ReviewTransportError(..., 'transport-failed')`. Only api
  // throws the typed error today, so only api asserts it directly.
  const blankDiffTest = kind === 'api' ? it : it.fails;
  blankDiffTest('blank diff is refused with ReviewTransportError code transport-failed', async () => {
    const opts: ConformanceTransportOptions =
      kind === 'cli'
        ? { cli: { location: makeFakeReviewLocation({ readDiff: async () => '' }) } }
        : kind === 'opencode'
          ? { opencode: { readDiff: async () => '' } }
          : { api: { location: makeFakeReviewLocation({ readDiff: async () => '' }) } };
    await expect(transport(opts)(makeConformanceRequest())).rejects.toMatchObject({
      code: 'transport-failed',
    });
  });

  it('null diff from location.readDiff is refused and never passes', async () => {
    const opts: ConformanceTransportOptions =
      kind === 'cli'
        ? { cli: { location: makeFakeReviewLocation({ readDiff: async () => null }) } }
        : kind === 'opencode'
          ? { opencode: { readDiff: async () => null } }
          : { api: { location: makeFakeReviewLocation({ readDiff: async () => null }) } };
    const attempt = transport(opts)(makeConformanceRequest());
    if (kind === 'opencode') {
      // FINDING (D1): opencode returns `unknown` / `diff-unavailable` instead
      // of throwing `ReviewTransportError(..., 'transport-failed')`.
      const result = await attempt;
      expect(result.result).toBe('unknown');
      expect(result.result).not.toBe('pass');
    } else {
      await expect(attempt).rejects.toThrow();
    }
  });

  it('timeout throws ReviewTransportError with code timeout', async () => {
    const opts: ConformanceTransportOptions =
      kind === 'cli'
        ? {
            cli: {
              spawn: async () => ({
                exitCode: null,
                signal: null,
                stdout: '',
                stderr: '',
                error: 'command exceeded its timeout',
              }),
            },
          }
        : kind === 'opencode'
          ? { opencode: { spawn: makeOcmSpawn('', { timeout: true }) } }
          : {
              api: {
                generate: makeApiGenerateRejecting(
                  Object.assign(new Error('aborted'), { name: 'AbortError' }),
                ),
              },
            };
    const attempt = transport(opts)(makeConformanceRequest());
    await expect(attempt).rejects.toBeInstanceOf(ReviewTransportError);
    await expect(attempt).rejects.toMatchObject({ code: 'timeout' });
  });

  it('capability honesty reports readOnlyVerified=false when read-only proof is absent or voided', async () => {
    let readHeadCalls = 0;
    const opts: ConformanceTransportOptions =
      kind === 'cli'
        ? {
            cli: {
              location: makeFakeReviewLocation({
                readHead: async () => {
                  readHeadCalls += 1;
                  return readHeadCalls === 1 ? CONFORMANCE_HEAD_SHA : 'sha-moved-after-review';
                },
              }),
            },
          }
        : kind === 'opencode'
          ? { opencode: { spawn: makeOcmSpawn(jsonReply('PASS', []), { bashTool: true }) } }
          : {
              api: {
                // The provider call omits `readOnly`; the transport reports
                // `readOnlyVerified: false` rather than assuming it.
                generate: makeApiGenerate({ object: { result: 'pass', findings: [] } }),
              },
            };
    const result = await transport(opts)(makeConformanceRequest());
    expect(result.readOnlyVerified).toBe(false);
  });

  it('over-cap diff is refused rather than silently truncated', async () => {
    const overCap = 'x'.repeat(525_000);
    const opts: ConformanceTransportOptions =
      kind === 'cli'
        ? { cli: { location: makeFakeReviewLocation({ readDiff: async () => overCap }) } }
        : kind === 'opencode'
          ? { opencode: { readDiff: async () => overCap } }
          : { api: { location: makeFakeReviewLocation({ readDiff: async () => overCap }) } };
    const attempt = transport(opts)(makeConformanceRequest());
    if (kind === 'opencode') {
      // FINDING (D1): opencode returns `{ result: 'unknown', rawOutput:
      // 'diff-truncated' }` instead of throwing
      // `ReviewTransportError(..., 'transport-failed')`.
      const result = await attempt;
      expect(result.result).toBe('unknown');
      expect(result.result).not.toBe('pass');
    } else {
      // FINDING (D1): api throws the typed ReviewTransportError
      // ('transport-failed'); cli throws a plain `Error` (no `code`).
      await expect(attempt).rejects.toThrow();
    }
  });

  it('decodeApiVerdict and IndependentReviewAdapter reject null, non-array findings, sparse arrays, and throwing getters without throwing', async () => {
    expect(decodeApiVerdict(null)).toMatchObject({ result: 'unknown', unknownReason: 'empty' });
    expect(decodeApiVerdict(undefined)).toMatchObject({ result: 'unknown', unknownReason: 'empty' });
    expect(decodeApiVerdict({ result: 'pass', findings: 'not-array' })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
    // A sparse findings array: a hole reads as `undefined` and never as a finding.
    const sparse: unknown[] = new Array(1);
    expect(decodeApiVerdict({ result: 'pass', findings: sparse })).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });
    // A throwing getter is never invoked, never a crash, never a verdict.
    const hostile = Object.defineProperty({}, 'result', {
      get() {
        throw new Error('hostile');
      },
      enumerable: true,
    });
    (hostile as Record<string, unknown>).findings = [];
    expect(decodeApiVerdict(hostile)).toMatchObject({
      result: 'unknown',
      unknownReason: 'unparseable-verdict',
    });

    // The adapter with no transport configured is an unavailable transport,
    // never a crash and never a review.
    const adapter = new IndependentReviewAdapter({});
    const outcome = await adapter.runIndependentReview(makeConformanceRequest());
    expect(outcome).toMatchObject({ outcome: 'unavailable', code: 'transport-missing' });
  });
});

describe('review transport conformance: shared constants', () => {
  it('the fakes agree on the request, head, base and diff they feed every transport', () => {
    expect(CONFORMANCE_BASE_SHA).not.toBe(CONFORMANCE_HEAD_SHA);
    expect(CONFORMANCE_DIFF).not.toBe('');
    expect(typeof cliStdout('x')).toBe('string');
  });
});
