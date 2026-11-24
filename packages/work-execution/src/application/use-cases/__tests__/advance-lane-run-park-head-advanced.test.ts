/**
 * CE2: the dirty-worktree fact's optional `headAdvanced` key. The fact is
 * asserted directly: present (`true`/`false`) only when BOTH the inspection's
 * `checkedOutCommit` and the attempt's collected `headCommit` are valid
 * lowercase 40-hex SHAs, and it is their strict inequality (a difference, not
 * a proven advance — SPLIT_NEXT: the recollect must verify ancestry). The key
 * is absent for a missing, malformed, uppercase or getter-backed
 * `checkedOutCommit`. No port other than a fake `worktreeInspect` is touched.
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { WorktreeInspection } from '../../ports/out/WorkspacePort.out-port.js';
import type { AdvanceStepContext } from '../advance-lane-run/step-context.js';
import { dirtyWorktreeFactOf } from '../advance-lane-run/step-context.js';

const NOW = '2026-10-27T10:00:00.000Z';
const WORKTREE = '/tmp/opencode/wo-example-1/wt-example-1';
const BASE_COMMIT = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);

const CONDUCTED_RUNNER = {
  kind: 'opencode' as const,
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: BASE_COMMIT,
    state: 'collected',
    outcome: null,
    briefDigest: 'b'.repeat(64),
    briefPackagePath: '.lane/brief-package',
    sessionId: null,
    completionReceipt: null,
    artifacts: {
      headCommit: HEAD,
      commitsSinceBase: [HEAD],
      collectedArtifactPaths: [],
      notes: 'present',
    },
    seatPlan: {
      version: 1,
      'first-pass': [{ id: 'fp-1', model: 'model-example-1', tool: 'opencode' }],
      fix: [],
      review: [],
    },
    seatSelection: {
      role: 'first-pass',
      seatIndex: 0,
      seatId: 'fp-1',
      model: 'model-example-1',
      tool: 'opencode',
      variant: null,
      agent: null,
    },
    stopReason: 'none',
    runner: CONDUCTED_RUNNER,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    ...overrides,
  } as AttemptRecord;
}

function inspectionFixture(overrides: Partial<WorktreeInspection> = {}): WorktreeInspection {
  return {
    worktreePath: WORKTREE,
    checkedOutCommit: HEAD,
    matchesBaseCommit: false,
    uncommittedPaths: [],
    untrackedPaths: [],
    residueFromEarlierAttempts: [],
    missingExpectedArtifacts: [],
    ...overrides,
  };
}

/** A minimal context: only `deps.worktreeInspect` is read by the fact. */
function ctxOf(inspection: unknown): AdvanceStepContext {
  return {
    deps: {
      worktreeInspect: {
        inspectWorktree: async () => inspection,
      },
    },
  } as unknown as AdvanceStepContext;
}

describe('dirtyWorktreeFactOf headAdvanced (CE2)', () => {
  it('returns headAdvanced true when the head differs from the attempt head and false when it matches', async () => {
    expect(await dirtyWorktreeFactOf(ctxOf(inspectionFixture({ checkedOutCommit: OTHER_HEAD })), attemptFixture())).toEqual({
      trackedFilesChanged: 0,
      headAdvanced: true,
    });
    expect(await dirtyWorktreeFactOf(ctxOf(inspectionFixture({ checkedOutCommit: HEAD })), attemptFixture())).toEqual({
      trackedFilesChanged: 0,
      headAdvanced: false,
    });
  });

  it('leaves headAdvanced absent for a missing, malformed, uppercase or getter-backed checkedOutCommit', async () => {
    const attempt = attemptFixture();
    // Missing key.
    const missing = inspectionFixture();
    Reflect.deleteProperty(missing as unknown as Record<string, unknown>, 'checkedOutCommit');
    expect(await dirtyWorktreeFactOf(ctxOf(missing), attempt)).toEqual({ trackedFilesChanged: 0 });
    // Malformed values.
    for (const checkedOutCommit of [null, undefined, 7, 'main', HEAD.slice(0, 12), OTHER_HEAD.toUpperCase()]) {
      expect(
        await dirtyWorktreeFactOf(ctxOf(inspectionFixture({ checkedOutCommit } as unknown as Partial<WorktreeInspection>)), attempt),
        String(checkedOutCommit),
      ).toEqual({
        trackedFilesChanged: 0,
      });
    }
    // Getter-backed: the accessor's descriptor value is absent, so the fact
    // is returned without the key and without running the getter.
    let getterRuns = 0;
    const getterBacked = inspectionFixture() as unknown as Record<string, unknown>;
    Reflect.deleteProperty(getterBacked, 'checkedOutCommit');
    Object.defineProperty(getterBacked, 'checkedOutCommit', {
      enumerable: true,
      get: () => {
        getterRuns += 1;
        return OTHER_HEAD;
      },
    });
    expect(await dirtyWorktreeFactOf(ctxOf(getterBacked), attempt)).toEqual({ trackedFilesChanged: 0 });
    expect(getterRuns).toBe(0);
  });

  it('leaves headAdvanced absent when the attempt artifacts are unreadable or headCommit is malformed', async () => {
    // Missing artifacts.
    const noArtifacts = attemptFixture();
    Reflect.deleteProperty(noArtifacts as unknown as Record<string, unknown>, 'artifacts');
    expect(await dirtyWorktreeFactOf(ctxOf(inspectionFixture({ checkedOutCommit: OTHER_HEAD })), noArtifacts)).toEqual({
      trackedFilesChanged: 0,
    });
    // Malformed headCommit.
    const shortHead = attemptFixture({ artifacts: { headCommit: 'abc', commitsSinceBase: [], collectedArtifactPaths: [], notes: 'missing' } });
    expect(await dirtyWorktreeFactOf(ctxOf(inspectionFixture({ checkedOutCommit: OTHER_HEAD })), shortHead)).toEqual({
      trackedFilesChanged: 0,
    });
  });

  it('still counts tracked paths and stays undefined for an unwired port or unreadable inspection', async () => {
    const dirty = inspectionFixture({ uncommittedPaths: ['src/a.ts', 'src/b.ts'] });
    expect(await dirtyWorktreeFactOf(ctxOf(dirty), attemptFixture())).toEqual({
      trackedFilesChanged: 2,
      headAdvanced: false,
    });
    // Unwired port: undefined.
    const unwired = { deps: {} } as unknown as AdvanceStepContext;
    expect(await dirtyWorktreeFactOf(unwired, attemptFixture())).toBeUndefined();
    // A throwing inspection reads undefined, never a throw.
    const throwing = ctxOf(null);
    (throwing.deps as unknown as { worktreeInspect: { inspectWorktree: () => Promise<never> } }).worktreeInspect.inspectWorktree =
      async () => {
        throw new Error('boom');
      };
    expect(await dirtyWorktreeFactOf(throwing, attemptFixture())).toBeUndefined();
    // No latest attempt: undefined.
    expect(await dirtyWorktreeFactOf(ctxOf(dirty), null)).toBeUndefined();
  });
});
