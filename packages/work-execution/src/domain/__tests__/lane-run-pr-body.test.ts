import { describe, expect, it } from 'vitest';

import { renderPrBody } from '../lane-run-pr-body.js';
import type { RenderPrBodyInput } from '../lane-run-pr-body.js';

const WORK_ORDER_ID = 'wo-01JB0000000000000000000000';
const RUN_ID = 'run-01JB0000000000000000000000';
const TITLE = 'Add the K6 render step';

function baseInput(): RenderPrBodyInput {
  return {
    workOrderId: WORK_ORDER_ID,
    title: TITLE,
    tier: 2,
    runId: RUN_ID,
    rounds: 2,
    gate: 'passed',
    reviews: [
      {
        kind: 'code-review',
        reviewerModel: 'review-model-a',
        round: 1,
        verdict: 'passed',
        findingCounts: { blocker: 0, major: 0, minor: 1, nit: 0 },
      },
    ],
    frozen: {
      hardToUndo: 'Rewrites the lane table in place.',
      assumptions: 'The journal is the only source of truth.',
      challengeThis: 'Revert with the lane rollback script if wrong.',
    },
  };
}

describe('renderPrBody', () => {
  it('renders the sections in order: What, Proof, Hard to undo, Assumptions, Challenge this', () => {
    const result = renderPrBody(baseInput());
    if (!result.ok) {
      throw new Error('unreachable: expected ok');
    }
    const order = [
      result.body.indexOf('## What'),
      result.body.indexOf('## Proof'),
      result.body.indexOf('## Hard to undo'),
      result.body.indexOf('## Assumptions'),
      result.body.indexOf('## Challenge this'),
    ];
    for (const index of order) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('names the frozen title and the work order id under What', () => {
    const result = renderPrBody(baseInput());
    if (!result.ok) {
      throw new Error('unreachable: expected ok');
    }
    expect(result.title).toBe(TITLE);
    expect(result.body).toContain(TITLE);
    expect(result.body).toContain(`Work order: ${WORK_ORDER_ID}`);
  });

  it('states tier, gate and one line per review round under Proof', () => {
    const result = renderPrBody(baseInput());
    if (!result.ok) {
      throw new Error('unreachable: expected ok');
    }
    expect(result.body).toContain('Tier 2');
    expect(result.body).toContain('gate passed');
    expect(result.body).toContain('- code-review round 1: passed');
  });

  it('carries the reviewer model name and counts and severities, never a finding summary', () => {
    const input = baseInput();
    const result = renderPrBody(input);
    if (!result.ok) {
      throw new Error('unreachable: expected ok');
    }
    expect(result.body).toContain('review-model-a');
    expect(result.body).toContain('minor 1');
    // The record shape has no reviewer text; a smuggled extra field never reaches the body.
    const smuggled = { ...input.reviews[0]!, findingSummary: 'SMUGGLED-FINDING-TEXT' } as unknown as RenderPrBodyInput['reviews'][number];
    const smuggledResult = renderPrBody({ ...input, reviews: [smuggled] });
    if (!smuggledResult.ok) {
      throw new Error('unreachable: expected ok');
    }
    expect(smuggledResult.body).not.toContain('SMUGGLED-FINDING-TEXT');
  });

  it('carries the three frozen D7 sections verbatim', () => {
    const result = renderPrBody(baseInput());
    if (!result.ok) {
      throw new Error('unreachable: expected ok');
    }
    expect(result.body).toContain('Rewrites the lane table in place.');
    expect(result.body).toContain('The journal is the only source of truth.');
    expect(result.body).toContain('Revert with the lane rollback script if wrong.');
  });

  it('refuses with missing-pr-notes when any frozen section is empty', () => {
    const blank = '';
    const whitespace = '   \n  ';
    for (const empty of [blank, whitespace]) {
      expect(renderPrBody({ ...baseInput(), frozen: { hardToUndo: empty, assumptions: 'a', challengeThis: 'c' } }))
        .toEqual({ ok: false, reason: 'missing-pr-notes' });
      expect(renderPrBody({ ...baseInput(), frozen: { hardToUndo: 'h', assumptions: empty, challengeThis: 'c' } }))
        .toEqual({ ok: false, reason: 'missing-pr-notes' });
      expect(renderPrBody({ ...baseInput(), frozen: { hardToUndo: 'h', assumptions: 'a', challengeThis: empty } }))
        .toEqual({ ok: false, reason: 'missing-pr-notes' });
    }
  });

  it('refuses with secret-shaped when any declared input carries a secret shape', () => {
    // Built from parts so the repository's own secret scan does not flag the fixture.
    const secret = ['sk', 'live', '0123456789abcdef0123456789abcdef'].join('-');
    expect(renderPrBody({ ...baseInput(), title: `Fix ${secret}` }))
      .toEqual({ ok: false, reason: 'secret-shaped' });
    expect(renderPrBody({ ...baseInput(), frozen: { hardToUndo: secret, assumptions: 'a', challengeThis: 'c' } }))
      .toEqual({ ok: false, reason: 'secret-shaped' });
    const reviews = [{ ...baseInput().reviews[0]!, reviewerModel: secret }];
    expect(renderPrBody({ ...baseInput(), reviews }))
      .toEqual({ ok: false, reason: 'secret-shaped' });
  });

  it.each([
    ['a secret-shaped kind', { kind: ['sk', 'live', '0123456789abcdef0123456789abcdef'].join('-') }],
    ['an unknown verdict', { verdict: 'approved-by-me' }],
    ['a negative count', { findingCounts: { blocker: -1, major: 0, minor: 0, nit: 0 } }],
    ['a non-numeric count', { findingCounts: { blocker: 0, major: Number.NaN, minor: 0, nit: 0 } }],
    ['a missing count', { findingCounts: { blocker: 0, major: 0, minor: 0 } }],
    ['a fractional round', { round: 1.5 }],
  ])('refuses with invalid-review for %s, never rendering it', (_label, patch) => {
    const reviews = [{ ...baseInput().reviews[0]!, ...patch }] as unknown as RenderPrBodyInput['reviews'];
    expect(renderPrBody({ ...baseInput(), reviews })).toEqual({ ok: false, reason: 'invalid-review' });
  });

  it('reports no findings only when every count is zero', () => {
    const reviews = [{ ...baseInput().reviews[0]!, findingCounts: { blocker: 0, major: 0, minor: 0, nit: 0 } }];
    const result = renderPrBody({ ...baseInput(), reviews });
    expect(result.ok && result.body).toContain('(no findings)');
  });

  it('refuses with too-long when the body exceeds the size cap', () => {
    const pad = 'x'.repeat(60_001);
    expect(renderPrBody({ ...baseInput(), frozen: { hardToUndo: pad, assumptions: 'a', challengeThis: 'c' } }))
      .toEqual({ ok: false, reason: 'too-long' });
  });

  it('adds no attribution footer', () => {
    const result = renderPrBody(baseInput());
    if (!result.ok) {
      throw new Error('unreachable: expected ok');
    }
    expect(result.body.toLowerCase()).not.toContain('generated by');
    expect(result.body.toLowerCase()).not.toContain('co-authored-by');
  });
});

describe('renderPrBody carried minors (GB1)', () => {
  it('renders one line per carried minor under Challenge this, using its actual severity', () => {
    const result = renderPrBody({
      ...baseInput(),
      carriedMinors: [
        { severity: 'minor', filePath: 'src/ex.ts', line: 4 },
        { severity: 'nit', filePath: 'src/other.ts', line: 9 },
        { severity: 'nit', filePath: null, line: 3 },
        { severity: 'minor', filePath: 'src/no-line.ts', line: null },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable: expected ok');
    }
    const challenge = result.body.slice(result.body.indexOf('## Challenge this'));
    expect(challenge).toContain('- [minor] src/ex.ts:4');
    expect(challenge).toContain('- [nit] src/other.ts:9');
    expect(challenge).toContain('- [nit] (no path)');
    expect(challenge).toContain('- [minor] src/no-line.ts');
    // The lines come after the frozen paragraph, in input order.
    expect(challenge.indexOf('Revert with the lane rollback script')).toBeLessThan(challenge.indexOf('- [minor] src/ex.ts:4'));
    expect(challenge.indexOf('- [minor] src/ex.ts:4')).toBeLessThan(challenge.indexOf('- [nit] src/other.ts:9'));
  });

  it('without carriedMinors the body is byte-identical to the pre-GB1 rendering; an empty list too', () => {
    const plain = renderPrBody(baseInput());
    const withEmpty = renderPrBody({ ...baseInput(), carriedMinors: [] });
    expect(withEmpty).toEqual(plain);
    if (!plain.ok) {
      throw new Error('unreachable: expected ok');
    }
    expect(plain.body.endsWith('Revert with the lane rollback script if wrong.\n')).toBe(true);
  });

  it.each([
    ['a blocker severity', [{ severity: 'blocker', filePath: 'src/ex.ts', line: 4 }]],
    ['a major severity', [{ severity: 'major', filePath: 'src/ex.ts', line: 4 }]],
    ['a non-integer line', [{ severity: 'minor', filePath: 'src/ex.ts', line: 1.5 }]],
    ['a zero line', [{ severity: 'minor', filePath: 'src/ex.ts', line: 0 }]],
    ['a non-string path', [{ severity: 'minor', filePath: 42, line: 4 }]],
    ['an absolute path', [{ severity: 'minor', filePath: '/etc/passwd', line: 1 }]],
    ['a dot-dot component', [{ severity: 'minor', filePath: 'src/../secret.ts', line: 1 }]],
    ['an empty component', [{ severity: 'minor', filePath: 'src//ex.ts', line: 1 }]],
    ['an empty path', [{ severity: 'minor', filePath: '', line: 1 }]],
    ['an over-long path', [{ severity: 'minor', filePath: 'a'.repeat(301), line: 1 }]],
    ['a path with a newline', [{ severity: 'minor', filePath: 'src/ex.ts\ninjected', line: 1 }]],
  ])('refuses invalid-review for %s', (_label, carriedMinors) => {
    expect(renderPrBody({ ...baseInput(), carriedMinors: carriedMinors as never }))
      .toEqual({ ok: false, reason: 'invalid-review' });
  });

  it('refuses a secret-shaped filePath with secret-shaped', () => {
    const secret = ['sk', 'live', '0123456789abcdef0123456789abcdef'].join('-');
    expect(renderPrBody({ ...baseInput(), carriedMinors: [{ severity: 'minor', filePath: secret, line: 1 }] }))
      .toEqual({ ok: false, reason: 'secret-shaped' });
  });

  it('refuses too-long when the carried lines push the body past the cap', () => {
    const carriedMinors = Array.from({ length: 220 }, (_value, index) => ({
      severity: 'minor' as const,
      filePath: 'src/' + String(index).padStart(3, '0') + '/' + 'a'.repeat(291),
      line: index + 1,
    }));
    expect(renderPrBody({ ...baseInput(), carriedMinors }))
      .toEqual({ ok: false, reason: 'too-long' });
  });
});
