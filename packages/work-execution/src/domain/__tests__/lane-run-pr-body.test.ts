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
    const secret = 'sk-live-0123456789abcdef0123456789abcdef';
    expect(renderPrBody({ ...baseInput(), title: `Fix ${secret}` }))
      .toEqual({ ok: false, reason: 'secret-shaped' });
    expect(renderPrBody({ ...baseInput(), frozen: { hardToUndo: secret, assumptions: 'a', challengeThis: 'c' } }))
      .toEqual({ ok: false, reason: 'secret-shaped' });
    const reviews = [{ ...baseInput().reviews[0]!, reviewerModel: secret }];
    expect(renderPrBody({ ...baseInput(), reviews }))
      .toEqual({ ok: false, reason: 'secret-shaped' });
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
