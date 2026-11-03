import { describe, expect, it } from 'vitest';

import type { LaneRef } from '../work-board-facts.js';
import {
  LANE_DECLARATION_RECORD_VERSION,
  LANE_BRIEF_READ_RECORD_VERSION,
  parseBriefReadBody,
  parseLaneDeclarationBody,
} from '../lane-activity-records.js';

const NOW = '2026-10-27T10:00:00.000Z';
const LANE: LaneRef = { kind: 'plan', projectId: 'example-project', planId: 'plan-1', laneId: 'lane-1' };

function declarationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { lane: LANE, step: 'gate', seatRole: 'builder', model: 'example-model', ...overrides };
}

function briefReadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lane: LANE,
    path: 'docs/plans/plan-1/lane-1.brief.md',
    outcome: 'read',
    sha256: 'a'.repeat(64),
    bytes: 42,
    ...overrides,
  };
}

describe('parseLaneDeclarationBody', () => {
  it('builds the record from the clock, never the body', () => {
    const parsed = parseLaneDeclarationBody(declarationBody(), NOW, 90);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual({
      version: LANE_DECLARATION_RECORD_VERSION,
      lane: LANE,
      step: 'gate',
      seatRole: 'builder',
      model: 'example-model',
      declaredAtIso: NOW,
      lapsesAtIso: '2026-10-27T11:30:00.000Z',
    });
  });

  it('refuses a wrong key set', () => {
    const extra = { ...declarationBody(), declaredAtIso: NOW };
    expect(parseLaneDeclarationBody(extra, NOW, 90)).toEqual({
      ok: false,
      error: 'body must have exactly the keys lane, step, seatRole and model',
    });
    expect(parseLaneDeclarationBody({}, NOW, 90).ok).toBe(false);
  });

  it('refuses a non-canonical clock time and a body-supplied time is ignored', () => {
    expect(parseLaneDeclarationBody(declarationBody(), '2026-10-27T10:00:00Z', 90)).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
    expect(parseLaneDeclarationBody(declarationBody(), 'not-a-time', 90)).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
  });

  it('refuses an unknown step', () => {
    expect(parseLaneDeclarationBody(declarationBody({ step: 'merge' }), NOW, 90)).toEqual({
      ok: false,
      error: 'invalid step',
    });
  });

  it('refuses a control character in seatRole', () => {
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'build\u0000er' }), NOW, 90)).toEqual({
      ok: false,
      error: 'invalid seatRole',
    });
    expect(parseLaneDeclarationBody(declarationBody({ seatRole: 'two\nlines' }), NOW, 90)).toEqual({
      ok: false,
      error: 'invalid seatRole',
    });
  });

  it('refuses an over-long model', () => {
    expect(parseLaneDeclarationBody(declarationBody({ model: 'm'.repeat(121) }), NOW, 90)).toEqual({
      ok: false,
      error: 'invalid model',
    });
  });

  it('refuses an invalid ttlMinutes', () => {
    expect(parseLaneDeclarationBody(declarationBody(), NOW, 0)).toEqual({
      ok: false,
      error: 'invalid ttlMinutes',
    });
  });
});

describe('parseBriefReadBody', () => {
  it('builds the record from the clock with the digest and byte count', () => {
    const parsed = parseBriefReadBody(briefReadBody(), NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual({
      version: LANE_BRIEF_READ_RECORD_VERSION,
      lane: LANE,
      path: 'docs/plans/plan-1/lane-1.brief.md',
      outcome: 'read',
      sha256: 'a'.repeat(64),
      bytes: 42,
      readAtIso: NOW,
    });
  });

  it('refuses a read without a valid sha256 or bytes', () => {
    expect(parseBriefReadBody(briefReadBody({ sha256: 'zz' }), NOW)).toEqual({
      ok: false,
      error: 'invalid sha256',
    });
    expect(parseBriefReadBody(briefReadBody({ bytes: -1 }), NOW)).toEqual({
      ok: false,
      error: 'invalid bytes',
    });
  });

  it('forces null digest and byte count on a failed read, ignoring the body values', () => {
    const parsed = parseBriefReadBody(
      briefReadBody({ outcome: 'failed', sha256: 'b'.repeat(64), bytes: 7 }),
      NOW,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.sha256).toBeNull();
    expect(parsed.record.bytes).toBeNull();
  });

  it('refuses a wrong key set, a bad path and a non-canonical clock', () => {
    expect(parseBriefReadBody({ ...briefReadBody(), extra: 1 }, NOW)).toEqual({
      ok: false,
      error: 'body must have exactly the keys lane, path, outcome, sha256 and bytes',
    });
    expect(parseBriefReadBody(briefReadBody({ path: 'x'.repeat(257) }), NOW)).toEqual({
      ok: false,
      error: 'invalid path',
    });
    expect(parseBriefReadBody(briefReadBody(), 'nope')).toEqual({
      ok: false,
      error: 'invalid nowIso',
    });
  });
});
