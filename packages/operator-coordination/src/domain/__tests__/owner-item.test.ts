import { describe, expect, it } from 'vitest';

import { containsSecretShape } from '@fleet/shared';
import { COORDINATION_KINDS } from '../value-objects/CoordinationKind.vo.js';
import { OWNER_ITEM_KINDS } from '../value-objects/OwnerItemKind.vo.js';
import {
  isOwnerItemGating,
  ownerItemGatedBlocks,
  ownerItemKeys,
  ownerItemMergeKey,
  ownerItemPlanDecisionKey,
  ownerItemQuestionKey,
  OwnerItem,
} from '../entities/OwnerItem.js';
import type { OwnerItemRecord } from '../owner-item-records.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal; the scanner still recognises the
 * shape, which is the point under test.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const OPEN_MERGE = {
  itemId: 'oi-example-1',
  projectId: 'example-project',
  kind: 'merge',
  subject: null,
  refs: [{ kind: 'pr', repository: 'example-org/example-repo', number: 251 }],
  blocks: [{ kind: 'lane', ref: '2026-10-27_example/A1' }],
  createdBy: 'orch-example-1',
};

const NOW = '2026-10-27T10:00:00.000Z';

function opened(overrides: Record<string, unknown> = {}): OwnerItem {
  const result = OwnerItem.open({ ...OPEN_MERGE, ...overrides }, NOW);
  if (!result.success) {
    throw new Error('expected open to succeed');
  }
  return result.value;
}

function baseRecord(): OwnerItemRecord {
  const result = OwnerItem.open(OPEN_MERGE, NOW);
  if (!result.success) {
    throw new Error('fixture open failed');
  }
  return result.value.toRecord();
}

describe('OwnerItem open and create', () => {
  it('opens a valid merge and round-trips it', () => {
    const result = OwnerItem.open(OPEN_MERGE, NOW);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const record = result.value.toRecord();
    expect(record.version).toBe(1);
    expect(record.state).toBe('open');
    expect(record.history).toHaveLength(1);
    expect(record.history[0]).toEqual({ event: 'opened', atIso: NOW, reason: null });
    const roundTrip = OwnerItem.create(JSON.parse(JSON.stringify(record)));
    expect(roundTrip.success).toBe(true);
    if (roundTrip.success) {
      expect(roundTrip.value.toRecord()).toEqual(record);
    }
  });

  it('normalizes timestamps to ISO with milliseconds', () => {
    const record = baseRecord();
    const result = OwnerItem.create({
      ...record,
      createdAtIso: '2026-10-27T10:00:00Z',
      history: [{ event: 'opened', atIso: '2026-10-27T10:00:00Z', reason: null }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.toRecord().createdAtIso).toBe('2026-10-27T10:00:00.000Z');
      expect(result.value.toRecord().history[0].atIso).toBe('2026-10-27T10:00:00.000Z');
    }
  });

  it('accepts a 120-code-point subject', () => {
    const result = OwnerItem.create({ ...baseRecord(), kind: 'secret', subject: 'é'.repeat(120) });
    expect(result.success).toBe(true);
  });

  const refusalCases: Array<{ name: string; record: unknown; message: string }> = [
    {
      name: 'an extra key',
      record: { ...baseRecord(), extra: 1 },
      message: 'OwnerItem requires a record with exactly its fields',
    },
    { name: 'version 2', record: { ...baseRecord(), version: 2 }, message: 'OwnerItem version must be 1' },
    {
      name: 'kind deploy',
      record: { ...baseRecord(), kind: 'deploy' },
      message: 'OwnerItem kind is not one of merge, secret, decision, backup, other',
    },
    {
      name: 'other with a null subject',
      record: { ...baseRecord(), kind: 'other', subject: null },
      message: 'OwnerItem other requires a subject',
    },
    {
      name: 'a 121-code-point subject',
      record: { ...baseRecord(), kind: 'secret', subject: 'é'.repeat(121) },
      message: 'OwnerItem subject must be single-line plain text of at most 120 characters',
    },
    {
      name: 'a subject with a newline',
      record: { ...baseRecord(), kind: 'secret', subject: 'line one\nline two' },
      message: 'OwnerItem subject must be single-line plain text of at most 120 characters',
    },
    {
      name: 'a subject with U+202E',
      record: { ...baseRecord(), kind: 'secret', subject: 'prefix\u202E' },
      message: 'OwnerItem subject must be single-line plain text of at most 120 characters',
    },
    {
      name: 'a subject with U+0085',
      record: { ...baseRecord(), kind: 'secret', subject: 'prefix\u0085' },
      message: 'OwnerItem subject must be single-line plain text of at most 120 characters',
    },
    {
      name: '17 blocks',
      record: {
        ...baseRecord(),
        blocks: Array.from({ length: 17 }, (_, i) => ({ kind: 'lane', ref: `2026-10-27_example/A${i + 1}` })),
      },
      message: 'OwnerItem blocks must be at most 16 distinct { kind, ref } entries',
    },
    {
      name: 'a one-part lane block',
      record: { ...baseRecord(), blocks: [{ kind: 'lane', ref: 'A1' }] },
      message: 'OwnerItem blocks[0] ref is not a lane reference',
    },
    {
      name: 'a four-part lane block',
      record: { ...baseRecord(), blocks: [{ kind: 'lane', ref: 'a/b/c/d' }] },
      message: 'OwnerItem blocks[0] ref is not a lane reference',
    },
    {
      name: 'a path-traversing lane block',
      record: { ...baseRecord(), blocks: [{ kind: 'lane', ref: 'x/../y' }] },
      message: 'OwnerItem blocks[0] ref is not a lane reference',
    },
    {
      name: 'a pr block with number 0',
      record: { ...baseRecord(), blocks: [{ kind: 'pr', ref: 'example-org/example-repo#0' }] },
      message: 'OwnerItem blocks[0] ref is not a pr reference',
    },
    {
      name: 'a pr block missing the repository',
      record: { ...baseRecord(), blocks: [{ kind: 'pr', ref: '#5' }] },
      message: 'OwnerItem blocks[0] ref is not a pr reference',
    },
    {
      name: 'a pr block with a leading zero',
      record: { ...baseRecord(), blocks: [{ kind: 'pr', ref: 'example-org/example-repo#05' }] },
      message: 'OwnerItem blocks[0] ref is not a pr reference',
    },
    {
      name: 'a merge without a pr ref',
      record: { ...baseRecord(), refs: [] },
      message: 'OwnerItem merge requires exactly one pr ref',
    },
    {
      name: 'a merge with two pr refs',
      record: {
        ...baseRecord(),
        refs: [
          { kind: 'pr', repository: 'example-org/example-repo', number: 251 },
          { kind: 'pr', repository: 'example-org/example-repo', number: 252 },
        ],
      },
      message: 'OwnerItem merge requires exactly one pr ref',
    },
    {
      name: 'a decision with only a lane ref',
      record: {
        ...baseRecord(),
        kind: 'decision',
        refs: [{ kind: 'lane', planId: '2026-10-27_example', laneId: 'A1' }],
      },
      message: 'OwnerItem decision requires one question or plan-decision ref and at most one of each',
    },
    {
      name: 'two equal refs',
      record: { ...baseRecord(), refs: [{ kind: 'question', id: 'q-a' }, { kind: 'question', id: 'q-a' }] },
      message: 'OwnerItem refs must be at most 16 distinct typed references',
    },
    {
      name: 'closed with a null resolution',
      record: { ...baseRecord(), state: 'closed', resolution: null },
      message: 'OwnerItem closed requires a resolution its kind allows',
    },
    {
      name: 'a closed merge with a done resolution',
      record: {
        ...baseRecord(),
        state: 'closed',
        resolution: { kind: 'done', via: 'cli', by: 'orch-example-1', atIso: NOW },
        history: [
          { event: 'opened', atIso: NOW, reason: null },
          { event: 'closed', atIso: NOW, reason: 'done' },
        ],
      },
      message: 'OwnerItem closed requires a resolution its kind allows',
    },
    {
      name: 'a withdrawn decision',
      record: {
        ...baseRecord(),
        kind: 'decision',
        refs: [{ kind: 'question', id: 'q-example-1' }],
        state: 'withdrawn',
        resolution: null,
        withdrawal: { reason: 'no-longer-needed', by: 'orch-example-1', atIso: NOW },
        history: [
          { event: 'opened', atIso: NOW, reason: null },
          { event: 'withdrawn', atIso: NOW, reason: 'no-longer-needed' },
        ],
      },
      message: 'OwnerItem withdrawn requires a withdrawal and a kind the owner may close',
    },
    {
      name: 'an answered resolution naming another question',
      record: {
        ...baseRecord(),
        kind: 'decision',
        refs: [{ kind: 'question', id: 'q-example-1' }],
        state: 'closed',
        resolution: { kind: 'answered', questionId: 'q-other', answeredAtIso: NOW },
        history: [
          { event: 'opened', atIso: NOW, reason: null },
          { event: 'closed', atIso: NOW, reason: 'answered' },
        ],
      },
      message: 'OwnerItem answered must name the item\'s question',
    },
    {
      name: 'a history starting closed',
      record: { ...baseRecord(), history: [{ event: 'closed', atIso: NOW, reason: 'merged' }] },
      message: 'OwnerItem history is not a valid sequence for its state',
    },
    {
      name: 'a closed item whose history ends opened',
      record: {
        ...baseRecord(),
        state: 'closed',
        resolution: { kind: 'merged', observedAtIso: NOW },
        history: [
          { event: 'opened', atIso: NOW, reason: null },
          { event: 'opened', atIso: NOW, reason: null },
        ],
      },
      message: 'OwnerItem history is not a valid sequence for its state',
    },
    {
      name: 'a reopen after a merged close',
      record: {
        ...baseRecord(),
        state: 'open',
        resolution: null,
        history: [
          { event: 'opened', atIso: NOW, reason: null },
          { event: 'closed', atIso: NOW, reason: 'merged' },
          { event: 'reopened', atIso: NOW, reason: null },
        ],
      },
      message: 'OwnerItem history is not a valid sequence for its state',
    },
  ];

  it.each(refusalCases)('refuses $name', ({ record, message }) => {
    const result = OwnerItem.create(record);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('invalid');
      expect(result.error.message).toBe(message);
    }
  });

  it('never echoes an input value', () => {
    expect(OwnerItem.create({ ...baseRecord(), kind: 'XYZZY' }).success).toBe(false);
    const kindResult = OwnerItem.create({ ...baseRecord(), kind: 'XYZZY' });
    if (!kindResult.success) {
      expect(kindResult.error.message).not.toContain('XYZZY');
    }
    const blockResult = OwnerItem.create({ ...baseRecord(), blocks: [{ kind: 'lane', ref: 'XYZZY' }] });
    expect(blockResult.success).toBe(false);
    if (!blockResult.success) {
      expect(blockResult.error.message).not.toContain('XYZZY');
    }
    const extraKeyResult = OwnerItem.create({ ...baseRecord(), XYZZY: 1 });
    expect(extraKeyResult.success).toBe(false);
    if (!extraKeyResult.success) {
      expect(extraKeyResult.error.message).not.toContain('XYZZY');
    }
    const stateResult = OwnerItem.create({ ...baseRecord(), state: 'XYZZY' });
    expect(stateResult.success).toBe(false);
    if (!stateResult.success) {
      expect(stateResult.error.message).not.toContain('XYZZY');
    }
  });

  it('refuses secret-shaped values without echoing them', () => {
    const secret = fakeSecretShape();
    const subjectResult = OwnerItem.create({ ...baseRecord(), kind: 'secret', subject: secret });
    expect(subjectResult.success).toBe(false);
    if (!subjectResult.success) {
      expect(subjectResult.error.message).toContain('secret-shaped');
      expect(subjectResult.error.message).not.toContain(secret);
    }
    const createdByResult = OwnerItem.create({ ...baseRecord(), createdBy: secret });
    expect(createdByResult.success).toBe(false);
    if (!createdByResult.success) {
      expect(createdByResult.error.message).toContain('secret-shaped');
      expect(createdByResult.error.message).not.toContain(secret);
    }
    const blockResult = OwnerItem.create({ ...baseRecord(), blocks: [{ kind: 'lane', ref: secret }] });
    expect(blockResult.success).toBe(false);
    if (!blockResult.success) {
      expect(blockResult.error.message).toContain('secret-shaped');
      expect(blockResult.error.message).not.toContain(secret);
    }
    const refResult = OwnerItem.create({
      ...baseRecord(),
      kind: 'secret',
      refs: [{ kind: 'work-order', id: secret }],
    });
    expect(refResult.success).toBe(false);
    if (!refResult.success) {
      expect(refResult.error.message).toContain('secret-shaped');
      expect(refResult.error.message).not.toContain(secret);
    }
  });

  it('refuses a subject matching only the lane diff registry', () => {
    const registryOnlySecret = `github_pat_${'a'.repeat(20)}`;
    expect(containsSecretShape(registryOnlySecret)).toBe(false);
    const result = OwnerItem.create({ ...baseRecord(), kind: 'secret', subject: registryOnlySecret });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('secret-shaped');
      expect(result.error.message).not.toContain(registryOnlySecret);
    }
  });

  it('never throws on hostile input', () => {
    const hostileInputs: unknown[] = [undefined, 42, 'x', Object.create(null)];
    const throwingProxy = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    hostileInputs.push(throwingProxy);
    for (const input of hostileInputs) {
      expect(OwnerItem.create(input).success).toBe(false);
      expect(OwnerItem.open(input, NOW).success).toBe(false);
    }
    expect(OwnerItem.create({ ...baseRecord(), refs: 'refs' }).success).toBe(false);
  });
});

describe('OwnerItem merge transitions', () => {
  it('closes on a merge record and is final', () => {
    const item = opened();
    const merged = item.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'merged',
      source: 'merge-record',
      observedAtIso: '2026-10-27T10:05:00.000Z',
    });
    expect(merged.success).toBe(true);
    if (!merged.success) {
      return;
    }
    expect(merged.value.getState()).toBe('closed');
    expect(merged.value.toRecord().resolution).toEqual({ kind: 'merged', observedAtIso: '2026-10-27T10:05:00.000Z' });
    const again = merged.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'merged',
      source: 'merge-record',
      observedAtIso: '2026-10-27T10:06:00.000Z',
    });
    expect(again.success).toBe(true);
    if (again.success) {
      expect(again.value).toBe(merged.value);
    }
    const forge = merged.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'merged',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T10:07:00.000Z',
    });
    expect(forge.success).toBe(false);
    if (!forge.success) {
      expect(forge.code).toBe('source');
    }
    const closed = merged.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'closed',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T10:08:00.000Z',
    });
    expect(closed.success).toBe(false);
    if (!closed.success) {
      expect(closed.code).toBe('state');
    }
    const reopened = merged.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'open',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T10:09:00.000Z',
    });
    expect(reopened.success).toBe(false);
    if (!reopened.success) {
      expect(reopened.code).toBe('state');
    }
  });

  it('closes by forge observation, reopens, and keeps every history entry', () => {
    const item = opened();
    const closed = item.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'closed',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T10:05:00.000Z',
    });
    expect(closed.success).toBe(true);
    if (!closed.success) {
      return;
    }
    expect(closed.value.toRecord().resolution).toEqual({ kind: 'pr-closed', observedAtIso: '2026-10-27T10:05:00.000Z' });
    const closedAgain = closed.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'closed',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T10:06:00.000Z',
    });
    expect(closedAgain.success).toBe(true);
    if (closedAgain.success) {
      expect(closedAgain.value).toBe(closed.value);
    }
    const reopened = closed.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'open',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T10:07:00.000Z',
    });
    expect(reopened.success).toBe(true);
    if (!reopened.success) {
      return;
    }
    const record = reopened.value.toRecord();
    expect(record.state).toBe('open');
    expect(record.resolution).toBeNull();
    expect(record.history.map((entry) => entry.event)).toEqual(['opened', 'closed', 'reopened']);
    expect(record.history[1].reason).toBe('pr-closed');
    const fromMergeRecord = reopened.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'open',
      source: 'merge-record',
      observedAtIso: '2026-10-27T10:08:00.000Z',
    });
    expect(fromMergeRecord.success).toBe(false);
    if (!fromMergeRecord.success) {
      expect(fromMergeRecord.code).toBe('source');
    }
    const closedAgain2 = reopened.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'closed',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T10:09:00.000Z',
    });
    expect(closedAgain2.success).toBe(true);
    if (!closedAgain2.success) {
      return;
    }
    const merged = closedAgain2.value.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'merged',
      source: 'merge-record',
      observedAtIso: '2026-10-27T10:10:00.000Z',
    });
    expect(merged.success).toBe(true);
    if (merged.success) {
      expect(merged.value.toRecord().history.map((entry) => entry.event)).toEqual([
        'opened',
        'closed',
        'reopened',
        'closed',
        'closed',
      ]);
      expect(merged.value.toRecord().history[3].reason).toBe('pr-closed');
      expect(merged.value.toRecord().history[4].reason).toBe('merged');
    }
  });

  it('refuses observing another PR', () => {
    const item = opened();
    const result = item.observePullRequest({
      repository: 'example-org/example-repo',
      number: 252,
      state: 'merged',
      source: 'merge-record',
      observedAtIso: '2026-10-27T10:05:00.000Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('invalid');
      expect(result.error.message).toBe('OwnerItem observation names another PR');
    }
  });

  it('refuses a transition earlier than the item opened', () => {
    const item = opened();
    const result = item.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'closed',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T09:59:59.999Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe('clock');
      expect(result.error.message).toBe('OwnerItem time must not move backwards');
    }
  });

  it('keeps at most 64 history entries through close/reopen cycles', () => {
    let item = opened();
    const baseTime = Date.parse(NOW);
    for (let cycle = 0; cycle < 40; cycle += 1) {
      const closedAt = new Date(baseTime + (cycle * 2 + 1) * 60000).toISOString();
      const closed = item.observePullRequest({
        repository: 'example-org/example-repo',
        number: 251,
        state: 'closed',
        source: 'forge-observation',
        observedAtIso: closedAt,
      });
      expect(closed.success).toBe(true);
      if (!closed.success) {
        return;
      }
      const reopenedAt = new Date(baseTime + (cycle * 2 + 2) * 60000).toISOString();
      const reopened = closed.value.observePullRequest({
        repository: 'example-org/example-repo',
        number: 251,
        state: 'open',
        source: 'forge-observation',
        observedAtIso: reopenedAt,
      });
      expect(reopened.success).toBe(true);
      if (!reopened.success) {
        return;
      }
      item = reopened.value;
    }
    const record = item.toRecord();
    expect(record.history).toHaveLength(64);
    expect(record.history[0].event).toBe('opened');
    expect(record.history[63].event).toBe('reopened');
  });
});

describe('OwnerItem decision transitions', () => {
  it('closes only on a recorded choice', () => {
    const item = opened({ kind: 'decision', refs: [{ kind: 'question', id: 'q-example-1' }] });
    const reject = item.recordAnswer({
      questionId: 'q-example-1',
      shape: 'reject',
      hasOption: false,
      hasText: false,
      answeredAtIso: '2026-10-27T10:05:00.000Z',
    });
    expect(reject.success).toBe(false);
    if (!reject.success) {
      expect(reject.code).toBe('no-choice');
    }
    const empty = item.recordAnswer({
      questionId: 'q-example-1',
      shape: 'answer',
      hasOption: false,
      hasText: false,
      answeredAtIso: '2026-10-27T10:05:00.000Z',
    });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.code).toBe('no-choice');
    }
    const accept = item.recordAnswer({
      questionId: 'q-example-1',
      shape: 'accept',
      hasOption: false,
      hasText: false,
      answeredAtIso: '2026-10-27T10:05:00.000Z',
    });
    expect(accept.success).toBe(true);
    if (!accept.success) {
      return;
    }
    expect(accept.value.toRecord().resolution).toEqual({ kind: 'answered', questionId: 'q-example-1', answeredAtIso: '2026-10-27T10:05:00.000Z' });
    const text = item.recordAnswer({
      questionId: 'q-example-1',
      shape: 'answer',
      hasOption: false,
      hasText: true,
      answeredAtIso: '2026-10-27T10:06:00.000Z',
    });
    expect(text.success).toBe(true);
    const wrong = item.recordAnswer({
      questionId: 'q-other',
      shape: 'accept',
      hasOption: false,
      hasText: false,
      answeredAtIso: '2026-10-27T10:07:00.000Z',
    });
    expect(wrong.success).toBe(false);
    if (!wrong.success) {
      expect(wrong.code).toBe('invalid');
    }
    const onMerge = opened().recordAnswer({
      questionId: 'q-example-1',
      shape: 'accept',
      hasOption: false,
      hasText: false,
      answeredAtIso: '2026-10-27T10:05:00.000Z',
    });
    expect(onMerge.success).toBe(false);
    if (!onMerge.success) {
      expect(onMerge.code).toBe('kind');
    }
  });

  it('closes from its plan and does not reopen across outcomes', () => {
    const item = opened({
      kind: 'decision',
      refs: [{ kind: 'plan-decision', planId: '2026-10-27_example', decisionId: 'd-example-1' }],
    });
    const decided = item.recordPlanDecision({
      planId: '2026-10-27_example',
      decisionId: 'd-example-1',
      outcome: 'decided',
      planRevision: 2,
      atIso: '2026-10-27T10:05:00.000Z',
    });
    expect(decided.success).toBe(true);
    if (!decided.success) {
      return;
    }
    expect(decided.value.toRecord().resolution).toEqual({ kind: 'plan-decided', planRevision: 2, atIso: '2026-10-27T10:05:00.000Z' });
    const again = decided.value.recordPlanDecision({
      planId: '2026-10-27_example',
      decisionId: 'd-example-1',
      outcome: 'decided',
      planRevision: 3,
      atIso: '2026-10-27T10:06:00.000Z',
    });
    expect(again.success).toBe(true);
    if (again.success) {
      expect(again.value).toBe(decided.value);
    }
    const removed = decided.value.recordPlanDecision({
      planId: '2026-10-27_example',
      decisionId: 'd-example-1',
      outcome: 'removed',
      planRevision: 4,
      atIso: '2026-10-27T10:07:00.000Z',
    });
    expect(removed.success).toBe(false);
    if (!removed.success) {
      expect(removed.code).toBe('state');
    }
    const removedItem = opened({
      kind: 'decision',
      refs: [{ kind: 'plan-decision', planId: '2026-10-27_example', decisionId: 'd-example-1' }],
    });
    const removedResult = removedItem.recordPlanDecision({
      planId: '2026-10-27_example',
      decisionId: 'd-example-1',
      outcome: 'removed',
      planRevision: 2,
      atIso: '2026-10-27T10:05:00.000Z',
    });
    expect(removedResult.success).toBe(true);
    if (removedResult.success) {
      const resolution = removedResult.value.toRecord().resolution;
      expect(resolution !== null && resolution.kind).toBe('decision-removed');
    }
  });
});

describe('OwnerItem D11 owner-closable rules', () => {
  it('merge and decision items cannot be withdrawn or marked done', () => {
    const mergeItem = opened();
    const withdrawMerge = mergeItem.withdraw({ reason: 'no-longer-needed', by: 'orch-example-1', atIso: '2026-10-27T10:05:00.000Z' });
    expect(withdrawMerge.success).toBe(false);
    if (!withdrawMerge.success) {
      expect(withdrawMerge.code).toBe('kind');
    }
    const doneMerge = mergeItem.markDone({ via: 'cli', by: 'orch-example-1', atIso: '2026-10-27T10:05:00.000Z' });
    expect(doneMerge.success).toBe(false);
    if (!doneMerge.success) {
      expect(doneMerge.code).toBe('kind');
    }
    const decisionItem = opened({ kind: 'decision', refs: [{ kind: 'question', id: 'q-example-1' }] });
    const withdrawDecision = decisionItem.withdraw({ reason: 'duplicate', by: 'orch-example-1', atIso: '2026-10-27T10:05:00.000Z' });
    expect(withdrawDecision.success).toBe(false);
    if (!withdrawDecision.success) {
      expect(withdrawDecision.code).toBe('kind');
    }
    const doneDecision = decisionItem.markDone({ via: 'web', by: 'orch-example-1', atIso: '2026-10-27T10:05:00.000Z' });
    expect(doneDecision.success).toBe(false);
    if (!doneDecision.success) {
      expect(doneDecision.code).toBe('kind');
    }
  });

  it('secret, backup and other items withdraw or close, then are final', () => {
    for (const kind of ['secret', 'backup', 'other'] as const) {
      const item = opened(kind === 'other' ? { kind, subject: 'document the example gate' } : { kind, subject: 'rotate the example key' });
      for (const reason of ['no-longer-needed', 'duplicate', 'superseded'] as const) {
        const withdrawn = item.withdraw({ reason, by: 'orch-example-1', atIso: '2026-10-27T10:05:00.000Z' });
        expect(withdrawn.success).toBe(true);
        if (withdrawn.success) {
          expect(withdrawn.value.toRecord().state).toBe('withdrawn');
          expect(withdrawn.value.toRecord().withdrawal).toEqual({ reason, by: 'orch-example-1', atIso: '2026-10-27T10:05:00.000Z' });
          const second = withdrawn.value.withdraw({ reason: 'duplicate', by: 'orch-example-1', atIso: '2026-10-27T10:06:00.000Z' });
          expect(second.success).toBe(false);
          if (!second.success) {
            expect(second.code).toBe('state');
          }
        }
      }
      const done = item.markDone({ via: 'cli', by: 'orch-example-1', atIso: '2026-10-27T10:05:00.000Z' });
      expect(done.success).toBe(true);
      if (done.success) {
        expect(done.value.toRecord().state).toBe('closed');
        expect(done.value.toRecord().resolution).toEqual({ kind: 'done', via: 'cli', by: 'orch-example-1', atIso: '2026-10-27T10:05:00.000Z' });
        const second = done.value.markDone({ via: 'web', by: 'orch-example-1', atIso: '2026-10-27T10:06:00.000Z' });
        expect(second.success).toBe(false);
        if (!second.success) {
          expect(second.code).toBe('state');
        }
      }
    }
  });
});

describe('OwnerItem gating and keys', () => {
  it('computes gating from state, kind and blocks', () => {
    const mergeOpen = opened();
    expect(isOwnerItemGating(mergeOpen.toRecord())).toBe(true);
    expect(ownerItemGatedBlocks(mergeOpen.toRecord())).toEqual([{ kind: 'lane', ref: '2026-10-27_example/A1' }]);

    const decisionOpen = opened({ kind: 'decision', refs: [{ kind: 'question', id: 'q-example-1' }] });
    expect(isOwnerItemGating(decisionOpen.toRecord())).toBe(true);

    const secretOpen = opened({ kind: 'secret', subject: 'rotate the example key' });
    expect(isOwnerItemGating(secretOpen.toRecord())).toBe(true);

    const backupOpen = opened({ kind: 'backup', subject: 'back up the example archive' });
    expect(isOwnerItemGating(backupOpen.toRecord())).toBe(false);

    const otherOpen = opened({ kind: 'other', subject: 'document the example gate' });
    expect(isOwnerItemGating(otherOpen.toRecord())).toBe(false);

    const gatingRefsOnly = opened({
      refs: [
        { kind: 'pr', repository: 'example-org/example-repo', number: 251 },
        { kind: 'lane', planId: '2026-10-27_example', laneId: 'A1' },
      ],
      blocks: [{ kind: 'pr', ref: 'example-org/example-repo#251' }],
    });
    expect(isOwnerItemGating(gatingRefsOnly.toRecord())).toBe(false);

    const gatingPrAndPlanBlocks = opened({
      blocks: [{ kind: 'pr', ref: 'example-org/example-repo#251' }, { kind: 'plan', ref: '2026-10-27_example' }],
    });
    expect(isOwnerItemGating(gatingPrAndPlanBlocks.toRecord())).toBe(false);

    const gatingWorkOrder = opened({ blocks: [{ kind: 'work-order', ref: 'wo-example-1' }] });
    expect(isOwnerItemGating(gatingWorkOrder.toRecord())).toBe(true);
    expect(ownerItemGatedBlocks(gatingWorkOrder.toRecord())).toEqual([{ kind: 'work-order', ref: 'wo-example-1' }]);

    const closed = mergeOpen.observePullRequest({
      repository: 'example-org/example-repo',
      number: 251,
      state: 'closed',
      source: 'forge-observation',
      observedAtIso: '2026-10-27T10:05:00.000Z',
    });
    if (closed.success) {
      expect(isOwnerItemGating(closed.value.toRecord())).toBe(false);
      expect(ownerItemGatedBlocks(closed.value.toRecord())).toEqual([]);
    }
  });

  it('computes natural keys', () => {
    const mergeRecord = opened().toRecord();
    expect(ownerItemKeys(mergeRecord)).toEqual([ownerItemMergeKey('example-project', 'example-org/example-repo', 251)]);

    const decisionRecord = opened({
      kind: 'decision',
      refs: [
        { kind: 'question', id: 'q-example-1' },
        { kind: 'plan-decision', planId: '2026-10-27_example', decisionId: 'd-example-1' },
      ],
    }).toRecord();
    const keys = ownerItemKeys(decisionRecord);
    expect(keys).toEqual([
      ownerItemPlanDecisionKey('example-project', '2026-10-27_example', 'd-example-1'),
      ownerItemQuestionKey('q-example-1'),
    ]);
    expect(keys[0]).toBe(ownerItemPlanDecisionKey('example-project', '2026-10-27_example', 'd-example-1'));

    const secretWithPr = opened({ kind: 'secret', subject: 'rotate the example key' }).toRecord();
    expect(ownerItemKeys(secretWithPr)).toEqual([]);

    expect(JSON.parse(ownerItemMergeKey('example-project', 'example-org/example-repo', 251))).toEqual([
      'merge',
      'example-project',
      'example-org/example-repo',
      251,
    ]);
  });

  it('owner item kinds are not coordination kinds', () => {
    for (const kind of OWNER_ITEM_KINDS) {
      expect(COORDINATION_KINDS).not.toContain(kind);
    }
    expect(COORDINATION_KINDS).not.toContain('owner-item');
  });
});
