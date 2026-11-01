// Lane CB1: `parseBaseBranch`, the resolvers, and the WorkOrder round-trips.
import { describe, expect, it } from 'vitest';

import {
  BASE_BRANCH_INVALID_MESSAGE,
  DEFAULT_BASE_BRANCH,
  parseBaseBranch,
  resolveLaneRunBaseBranch,
  resolveWorkOrderBaseBranch,
} from '../base-branch.js';
import { WorkOrder } from '../entities/WorkOrder.js';
import type { WorkOrderRecord } from '../execution-records.js';

/** Secret-shaped fakes are assembled from inert pieces (lane-run.test.ts precedent). */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

function workOrderRecord(overrides?: Partial<WorkOrderRecord>): WorkOrderRecord {
  return {
    id: 'wo-base-branch-1',
    projectId: 'project-example-1',
    taskId: 'task-example-1',
    laneId: 'lane-example-1',
    repository: 'repo-example-1',
    baseCommit: 'a'.repeat(40),
    ownedPaths: ['packages/example/src'],
    policyRevision: 'policy-example-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 1,
    createdAtIso: '2026-10-27T10:00:00.000Z',
    updatedAtIso: '2026-10-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('parseBaseBranch', () => {
  it.each(['main', 'chain/example-1', 'chain/main'])('parses %j', (branch) => {
    expect(parseBaseBranch(branch)).toBe(branch);
  });

  it.each([
    'Main',
    ' main',
    'main ',
    'chain/',
    'chain/a-',
    'chain/a--b',
    'chain/A',
    'chain/a/b',
    'origin/main',
    '',
    'chain/' + 'a'.repeat(195),
  ])('refuses %j', (branch) => {
    expect(parseBaseBranch(branch)).toBeUndefined();
  });

  it('refuses a 201-character chain name (the boundary past 200)', () => {
    expect(parseBaseBranch('chain/' + 'a'.repeat(196))).toBeUndefined();
    expect(parseBaseBranch('chain/' + 'a'.repeat(195))).toBeUndefined();
    expect(parseBaseBranch('chain/' + 'a'.repeat(194))).toBe('chain/' + 'a'.repeat(194));
  });

  it('refuses a non-string and a secret-shaped string without echoing either', () => {
    expect(parseBaseBranch(42)).toBeUndefined();
    expect(parseBaseBranch(null)).toBeUndefined();
    expect(parseBaseBranch(fakeSecretShape())).toBeUndefined();
  });

  it('exposes the fixed invalid message the entity callers use', () => {
    expect(BASE_BRANCH_INVALID_MESSAGE).toBe('baseBranch must be main or chain/<lowercase-dashes>');
  });
});

describe('resolveWorkOrderBaseBranch and resolveLaneRunBaseBranch', () => {
  it('returns main when the key is absent', () => {
    expect(resolveWorkOrderBaseBranch(workOrderRecord())).toBe(DEFAULT_BASE_BRANCH);
    expect(
      resolveLaneRunBaseBranch({ runId: 'run-01JB0000000000000000000000', workOrderId: 'wo-1' } as never),
    ).toBe(DEFAULT_BASE_BRANCH);
  });

  it('ignores an inherited property and an unparsable value', () => {
    const inherited = Object.create({ baseBranch: 'chain/inherited' }) as { baseBranch?: string };
    expect(resolveWorkOrderBaseBranch(inherited as never)).toBe(DEFAULT_BASE_BRANCH);

    expect(resolveWorkOrderBaseBranch(workOrderRecord({ baseBranch: 'release' } as never))).toBe(
      DEFAULT_BASE_BRANCH,
    );
    expect(resolveWorkOrderBaseBranch(workOrderRecord({ baseBranch: 'chain/example' }))).toBe(
      'chain/example',
    );
  });
});

describe('WorkOrder baseBranch (lane CB1)', () => {
  it('round-trips a record with baseBranch and getBaseBranch returns it', () => {
    const record = workOrderRecord({ baseBranch: 'chain/example' });
    const order = WorkOrder.fromRecord(record);
    expect(order.toRecord()).toEqual(record);
    expect(order.getBaseBranch()).toBe('chain/example');
  });

  it('round-trips a record without the key and getBaseBranch reads main', () => {
    const record = workOrderRecord();
    const order = WorkOrder.fromRecord(record);
    const stored = order.toRecord();
    expect(Object.hasOwn(stored, 'baseBranch')).toBe(false);
    expect(order.getBaseBranch()).toBe(DEFAULT_BASE_BRANCH);
  });

  it('throws the fixed message for a bad own value and never echoes it', () => {
    expect(() => WorkOrder.fromRecord(workOrderRecord({ baseBranch: 'release' } as never))).toThrow(
      'WorkOrder baseBranch must be main or chain/<lowercase-dashes>',
    );
    expect(() => WorkOrder.fromRecord(workOrderRecord({ baseBranch: 'main' }))).not.toThrow();
  });
});
