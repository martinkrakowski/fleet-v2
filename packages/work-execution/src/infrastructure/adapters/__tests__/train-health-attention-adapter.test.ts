// TrainHealthAttentionAdapter tests (lane CO-WD4): the adapter delegates
// in-process to operator coordination's record, clear and list attention
// ports. Summaries are fixed text from ids and codes. The pass deadline is
// accepted on the command and never forwarded. A raise result carries
// `previousRaisedAtIso` exactly as the delegate answer stored it before the
// overwrite: the answer must carry it as an own data property on every success
// outcome — exactly null for `raised`, and for `refreshed` and `reopened` the
// stored record's last raise time, null or a zoned ISO string (anything else,
// including a missing or accessor-backed field, is a failed raise).

import { describe, expect, it } from 'vitest';

import {
  AttentionItemRepositoryAdapter,
  RecordAttentionItemUseCase,
} from '@fleet/operator-coordination';

import type { TrainHealthAttentionCommand } from '../../../application/ports/out/TrainHealthAttentionPort.out-port.js';
import {
  TRAIN_HEALTH_ATTENTION_ACTOR,
  TrainHealthAttentionAdapter,
} from '../TrainHealthAttentionAdapter.adapter.js';

const PROJECT = 'proj-1';
const OWNER = 'fleet';
const REPO = 'fleet-v2';
const DEADLINE = '2026-11-17T15:04:05.006Z';
const RAISED_AT = '2026-11-16T01:02:03.000Z';

function command(overrides: Partial<TrainHealthAttentionCommand> = {}): TrainHealthAttentionCommand {
  return {
    projectId: PROJECT,
    repository: { owner: OWNER, repo: REPO },
    rule: 'tick-stale',
    pullRequest: null,
    deadlineIso: DEADLINE,
    ...overrides,
  };
}

function listQuery() {
  return {
    projectId: PROJECT,
    repository: { owner: OWNER, repo: REPO },
    deadlineIso: DEADLINE,
  };
}

function projectBody(rule: string) {
  return {
    projectId: PROJECT,
    kind: `train-${rule}`,
    subject: { kind: 'project' as const, ref: PROJECT },
    workOrderId: null,
    summary: `train-health:${rule} repo=${OWNER}/${REPO}`,
  };
}

function prBody(rule: string, pullRequest: number) {
  return {
    projectId: PROJECT,
    kind: `train-${rule}`,
    subject: { kind: 'pr' as const, ref: `${OWNER}/${REPO}#${pullRequest}` },
    workOrderId: null,
    summary: `train-health:${rule} repo=${OWNER}/${REPO} pr=${pullRequest}`,
  };
}

function resolveRequest(kind: string, subject: { readonly kind: string; readonly ref: string }) {
  return {
    action: 'resolve' as const,
    projectId: PROJECT,
    kind,
    subject,
    reason: 'resolved' as const,
  };
}

function expectNoDeadline(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(DEADLINE);
}

describe('TrainHealthAttentionAdapter', () => {
  it('raises findings-truncated and queue-too-large with project subjects', async () => {
    const calls: { body: unknown; actor: string }[] = [];
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        calls.push({ body, actor });
        return { outcome: 'raised', previousRaisedAtIso: null };
      },
    });
    const truncated = command({ rule: 'findings-truncated', pullRequest: null });
    const tooLarge = command({ rule: 'queue-too-large', pullRequest: null });
    expect(truncated).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'findings-truncated',
      pullRequest: null,
      deadlineIso: DEADLINE,
    });
    expect(tooLarge).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'queue-too-large',
      pullRequest: null,
      deadlineIso: DEADLINE,
    });

    expect(await adapter.raiseTrainHealthAttention(truncated)).toEqual({
      outcome: 'raised',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(await adapter.raiseTrainHealthAttention(tooLarge)).toEqual({
      outcome: 'raised',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(calls).toEqual([
      { actor: 'train-watchdog', body: projectBody('findings-truncated') },
      { actor: 'train-watchdog', body: projectBody('queue-too-large') },
    ]);
    expect(calls[0]?.body).toEqual({
      projectId: PROJECT,
      kind: 'train-findings-truncated',
      subject: { kind: 'project', ref: PROJECT },
      workOrderId: null,
      summary: 'train-health:findings-truncated repo=fleet/fleet-v2',
    });
    expect(calls[1]?.body).toEqual({
      projectId: PROJECT,
      kind: 'train-queue-too-large',
      subject: { kind: 'project', ref: PROJECT },
      workOrderId: null,
      summary: 'train-health:queue-too-large repo=fleet/fleet-v2',
    });
    expectNoDeadline(calls);

    expect(await adapter.raiseTrainHealthAttention(command({ rule: 'findings-truncated', pullRequest: 5 }))).toEqual({
      outcome: 'refused',
      reasonCode: 'invalid-request',
    });
    expect(await adapter.raiseTrainHealthAttention(command({ rule: 'queue-too-large', pullRequest: 5 }))).toEqual({
      outcome: 'refused',
      reasonCode: 'invalid-request',
    });
    expect(calls).toHaveLength(2);
  });

  it('clears findings-truncated and queue-too-large', async () => {
    const calls: { request: unknown; via: string; actor: string }[] = [];
    const adapter = new TrainHealthAttentionAdapter({
      clearAttentionItem: async (request, via, actor) => {
        calls.push({ request, via, actor });
        return { outcome: 'cleared' };
      },
    });
    const truncated = command({ rule: 'findings-truncated', pullRequest: null });
    const tooLarge = command({ rule: 'queue-too-large', pullRequest: null });
    expect(truncated.deadlineIso).toBe(DEADLINE);
    expect(tooLarge.deadlineIso).toBe(DEADLINE);

    expect(await adapter.clearTrainHealthAttention(truncated)).toEqual({
      outcome: 'cleared',
      reasonCode: null,
    });
    expect(await adapter.clearTrainHealthAttention(tooLarge)).toEqual({
      outcome: 'cleared',
      reasonCode: null,
    });
    expect(calls).toEqual([
      {
        via: 'machine',
        actor: 'train-watchdog',
        request: resolveRequest('train-findings-truncated', { kind: 'project', ref: PROJECT }),
      },
      {
        via: 'machine',
        actor: 'train-watchdog',
        request: resolveRequest('train-queue-too-large', { kind: 'project', ref: PROJECT }),
      },
    ]);
    expect(calls[0]?.request).toEqual({
      action: 'resolve',
      projectId: PROJECT,
      kind: 'train-findings-truncated',
      subject: { kind: 'project', ref: PROJECT },
      reason: 'resolved',
    });
    expect(calls[1]?.request).toEqual({
      action: 'resolve',
      projectId: PROJECT,
      kind: 'train-queue-too-large',
      subject: { kind: 'project', ref: PROJECT },
      reason: 'resolved',
    });
    expectNoDeadline(calls);
  });

  it('raises tick-stale with project subject and fixed summary', async () => {
    expect(TRAIN_HEALTH_ATTENTION_ACTOR).toBe('train-watchdog');
    const calls: { body: unknown; actor: string }[] = [];
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        calls.push({ body, actor });
        return { outcome: 'raised', previousRaisedAtIso: null };
      },
    });
    const raw = command({ rule: 'tick-stale', pullRequest: null });
    expect(raw).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'tick-stale',
      pullRequest: null,
      deadlineIso: DEADLINE,
    });

    expect(await adapter.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'raised',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(calls).toEqual([
      {
        actor: 'train-watchdog',
        body: {
          projectId: PROJECT,
          kind: 'train-tick-stale',
          subject: { kind: 'project', ref: PROJECT },
          workOrderId: null,
          summary: 'train-health:tick-stale repo=fleet/fleet-v2',
        },
      },
    ]);
    expectNoDeadline(calls);

    for (const rule of ['stalled-head', 'watchdog-blind'] as const) {
      const seen: { body: unknown; actor: string }[] = [];
      const extra = new TrainHealthAttentionAdapter({
        recordAttentionItem: async (body, actor) => {
          seen.push({ body, actor });
          return { outcome: 'raised', previousRaisedAtIso: null };
        },
      });
      const projectRule = command({ rule, pullRequest: null });
      expect(projectRule.deadlineIso).toBe(DEADLINE);
      expect(await extra.raiseTrainHealthAttention(projectRule)).toEqual({
        outcome: 'raised',
        reasonCode: null,
        previousRaisedAtIso: null,
      });
      expect(seen).toEqual([{ actor: 'train-watchdog', body: projectBody(rule) }]);
      expectNoDeadline(seen);
    }
  });

  it('raises stale-queue-entry with pr subject and pr summary', async () => {
    const calls: { body: unknown; actor: string }[] = [];
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        calls.push({ body, actor });
        return { outcome: 'raised', previousRaisedAtIso: null };
      },
    });
    const raw = command({ rule: 'stale-queue-entry', pullRequest: 12 });
    expect(raw).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'stale-queue-entry',
      pullRequest: 12,
      deadlineIso: DEADLINE,
    });

    expect(await adapter.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'raised',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(calls).toEqual([
      {
        actor: 'train-watchdog',
        body: {
          projectId: PROJECT,
          kind: 'train-stale-queue-entry',
          subject: { kind: 'pr', ref: 'fleet/fleet-v2#12' },
          workOrderId: null,
          summary: 'train-health:stale-queue-entry repo=fleet/fleet-v2 pr=12',
        },
      },
    ]);
    expectNoDeadline(calls);

    const repeated: { body: unknown; actor: string }[] = [];
    const park = new TrainHealthAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        repeated.push({ body, actor });
        return { outcome: 'raised', previousRaisedAtIso: null };
      },
    });
    const parkCommand = command({ rule: 'repeated-park', pullRequest: 4 });
    expect(parkCommand.deadlineIso).toBe(DEADLINE);
    expect(await park.raiseTrainHealthAttention(parkCommand)).toEqual({
      outcome: 'raised',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(repeated).toEqual([
      { actor: 'train-watchdog', body: prBody('repeated-park', 4) },
    ]);
    expect(repeated[0]?.body).toEqual({
      projectId: PROJECT,
      kind: 'train-repeated-park',
      subject: { kind: 'pr', ref: 'fleet/fleet-v2#4' },
      workOrderId: null,
      summary: 'train-health:repeated-park repo=fleet/fleet-v2 pr=4',
    });
    expectNoDeadline(repeated);
  });

  it('passes through refreshed and reopened raise outcomes', async () => {
    const outcomes = ['refreshed', 'reopened'] as const;
    const calls: { body: unknown; actor: string }[] = [];
    let index = 0;
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        calls.push({ body, actor });
        const outcome = outcomes[index];
        index += 1;
        return { outcome, previousRaisedAtIso: null };
      },
    });
    const raw = command();
    expect(raw.deadlineIso).toBe(DEADLINE);

    expect(await adapter.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'refreshed',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(await adapter.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'reopened',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(calls).toEqual([
      { actor: 'train-watchdog', body: projectBody('tick-stale') },
      { actor: 'train-watchdog', body: projectBody('tick-stale') },
    ]);
    expectNoDeadline(calls);
  });

  it('returns previousRaisedAtIso null on the first raise of an item', async () => {
    const calls: { body: unknown; actor: string }[] = [];
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        calls.push({ body, actor });
        return { outcome: 'raised', previousRaisedAtIso: null };
      },
    });
    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'raised',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(calls).toEqual([{ actor: 'train-watchdog', body: projectBody('tick-stale') }]);
  });

  it('a delegate raised result with no previousRaisedAtIso is a failed raise', async () => {
    const calls: { body: unknown; actor: string }[] = [];
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        calls.push({ body, actor });
        return { outcome: 'raised' };
      },
    });
    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });
    expect(calls).toEqual([{ actor: 'train-watchdog', body: projectBody('tick-stale') }]);
  });

  it('a delegate raised result with an accessor-backed previousRaisedAtIso is a failed raise, and the getter is never called', async () => {
    let getterCalls = 0;
    const answer: { outcome: 'raised'; previousRaisedAtIso?: string | null } = { outcome: 'raised' };
    Object.defineProperty(answer, 'previousRaisedAtIso', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return null;
      },
    });
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => answer,
    });
    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });
    expect(getterCalls).toBe(0);
  });

  it('a delegate raised result whose previousRaisedAtIso is a string is a failed raise', async () => {
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => ({ outcome: 'raised', previousRaisedAtIso: RAISED_AT }),
    });
    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });
  });

  it('returns previousRaisedAtIso of the first raise on a second raise, stored as given', async () => {
    const SECOND = '2026-11-16T09:02:03.000Z';
    let storedIso: string | null = null;
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => {
        const previous = storedIso;
        storedIso = previous === null ? RAISED_AT : SECOND;
        if (previous === null) {
          return { outcome: 'raised', previousRaisedAtIso: null };
        }
        return { outcome: 'refreshed', previousRaisedAtIso: previous };
      },
    });
    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'raised',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'refreshed',
      reasonCode: null,
      previousRaisedAtIso: RAISED_AT,
    });
    expect(storedIso).toBe(SECOND);
  });

  it('returns the first raise time from the REAL RecordAttentionItemUseCase on a second raise', async () => {
    const FIRST_AT = '2026-11-16T01:02:03.000Z';
    const SECOND_AT = '2026-11-16T09:02:03.000Z';
    const at = [FIRST_AT, SECOND_AT];
    const delegate = new RecordAttentionItemUseCase({
      itemRepo: new AttentionItemRepositoryAdapter(),
      clock: { nowIso: () => at.shift() ?? SECOND_AT },
      ids: { newItemId: () => 'att-real-1' },
    });
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: (body, actor) => delegate.recordAttentionItem(body, actor),
    });

    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'raised',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'refreshed',
      reasonCode: null,
      previousRaisedAtIso: FIRST_AT,
    });
  });

  it('returns the closed record last raise time on reopen, and null when the store keeps none', async () => {
    const CLOSED_RAISED_AT = '2026-11-15T10:00:00.000Z';
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => ({
        outcome: 'reopened',
        previousRaisedAtIso: CLOSED_RAISED_AT,
      }),
    });
    expect(await adapter.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'reopened',
      reasonCode: null,
      previousRaisedAtIso: CLOSED_RAISED_AT,
    });

    const withoutStoredTime = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => ({ outcome: 'reopened', previousRaisedAtIso: null }),
    });
    expect(await withoutStoredTime.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'reopened',
      reasonCode: null,
      previousRaisedAtIso: null,
    });
  });

  it('refuses with delegate code on refused raise or clear answer', async () => {
    const raises: { body: unknown; actor: string }[] = [];
    const clears: { request: unknown; via: string; actor: string }[] = [];
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async (body, actor) => {
        raises.push({ body, actor });
        return { outcome: 'refused', code: 'x' };
      },
      clearAttentionItem: async (request, via, actor) => {
        clears.push({ request, via, actor });
        return { outcome: 'refused', code: 'x' };
      },
    });
    const raw = command();
    expect(raw).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'tick-stale',
      pullRequest: null,
      deadlineIso: DEADLINE,
    });

    expect(await adapter.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'x',
    });
    expect(await adapter.clearTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'x',
    });
    expect(raises).toEqual([{ actor: 'train-watchdog', body: projectBody('tick-stale') }]);
    expect(clears).toEqual([
      {
        via: 'machine',
        actor: 'train-watchdog',
        request: resolveRequest('train-tick-stale', { kind: 'project', ref: PROJECT }),
      },
    ]);
    expectNoDeadline(raises);
    expectNoDeadline(clears);
  });

  it('refuses with unreadable on non-string refusal code, unexpected answer, or throwing delegate', async () => {
    const answers: unknown[] = [{ outcome: 'refused', code: 42 }, null, 7, { outcome: 'weird' }];
    for (const answer of answers) {
      const adapter = new TrainHealthAttentionAdapter({
        recordAttentionItem: async () => answer,
        clearAttentionItem: async () => answer,
      });
      const raw = command();
      expect(raw.deadlineIso).toBe(DEADLINE);
      expect(await adapter.raiseTrainHealthAttention(raw)).toEqual({
        outcome: 'refused',
        reasonCode: 'unreadable',
      });
      expect(await adapter.clearTrainHealthAttention(raw)).toEqual({
        outcome: 'refused',
        reasonCode: 'unreadable',
      });
    }

    const throwing = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => {
        throw new Error('boom');
      },
      clearAttentionItem: async () => {
        throw new Error('boom');
      },
    });
    expect(await throwing.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });
    expect(await throwing.clearTrainHealthAttention(command())).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });

    let outcomeReads = 0;
    const hostileAnswer = {
      get outcome(): string {
        outcomeReads += 1;
        throw new Error('boom');
      },
    };
    const hostile = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => hostileAnswer,
      clearAttentionItem: async () => hostileAnswer,
    });
    expect(await hostile.raiseTrainHealthAttention(command())).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });
    expect(await hostile.clearTrainHealthAttention(command())).toEqual({
      outcome: 'refused',
      reasonCode: 'unreadable',
    });
    expect(outcomeReads).toBe(0);
  });

  it('returns not-configured for raise/clear and unavailable for list when delegate is absent', async () => {
    const query = listQuery();
    expect(query).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      deadlineIso: DEADLINE,
    });
    const raw = command();
    expect(raw.deadlineIso).toBe(DEADLINE);

    const bare = new TrainHealthAttentionAdapter();
    expect(await bare.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
    expect(await bare.clearTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
    expect(await bare.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'unavailable' });

    const empty = new TrainHealthAttentionAdapter({});
    expect(await empty.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
    expect(await empty.clearTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
    expect(await empty.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'unavailable' });

    const raiseOnly = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => ({ outcome: 'raised' }),
    });
    expect(await raiseOnly.clearTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
    expect(await raiseOnly.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'unavailable' });

    const clearOnly = new TrainHealthAttentionAdapter({
      clearAttentionItem: async () => ({ outcome: 'cleared' }),
    });
    expect(await clearOnly.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
    expect(await clearOnly.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'unavailable' });

    const listOnly = new TrainHealthAttentionAdapter({
      listAttentionItems: async () => ({ items: [] }),
    });
    expect(await listOnly.raiseTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
    expect(await listOnly.clearTrainHealthAttention(raw)).toEqual({
      outcome: 'refused',
      reasonCode: 'not-configured',
    });
  });

  it('refuses invalid commands with invalid-request and zero delegate calls', async () => {
    let calls = 0;
    const adapter = new TrainHealthAttentionAdapter({
      recordAttentionItem: async () => {
        calls += 1;
        return { outcome: 'raised' };
      },
      clearAttentionItem: async () => {
        calls += 1;
        return { outcome: 'cleared' };
      },
    });
    expect(command()).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'tick-stale',
      pullRequest: null,
      deadlineIso: DEADLINE,
    });

    const invalid: TrainHealthAttentionCommand[] = [
      command({ rule: 'tick-stale', pullRequest: 5 }),
      command({ rule: 'stalled-head', pullRequest: 5 }),
      command({ rule: 'watchdog-blind', pullRequest: 5 }),
      command({ rule: 'stale-queue-entry', pullRequest: null }),
      command({ rule: 'stale-queue-entry', pullRequest: 0 }),
      command({ rule: 'repeated-park', pullRequest: 1.5 }),
      command({ rule: 'not-a-rule' as TrainHealthAttentionCommand['rule'] }),
      command({ projectId: 'proj 1' }),
      // Joined at runtime so the source text is not itself a token shape.
      command({ projectId: ['ghp', 'abcdefghijklmnopqrst'].join('_') }),
      command({ repository: { owner: '..', repo: REPO } }),
      command({ repository: { owner: '.', repo: REPO } }),
      command({ repository: { owner: OWNER, repo: '..' } }),
      command({ repository: { owner: OWNER, repo: '.' } }),
    ];
    const missingDeadline = { ...command() };
    delete (missingDeadline as { deadlineIso?: string }).deadlineIso;
    const nonStringDeadline = { ...command(), deadlineIso: 7 as unknown as string };

    const expectInvalid = async (raw: TrainHealthAttentionCommand): Promise<void> => {
      expect(await adapter.raiseTrainHealthAttention(raw)).toEqual({
        outcome: 'refused',
        reasonCode: 'invalid-request',
      });
      expect(await adapter.clearTrainHealthAttention(raw)).toEqual({
        outcome: 'refused',
        reasonCode: 'invalid-request',
      });
      expect(calls).toBe(0);
    };

    for (const raw of invalid) {
      await expectInvalid(raw);
    }
    await expectInvalid(missingDeadline as TrainHealthAttentionCommand);
    await expectInvalid(nonStringDeadline);
    await expectInvalid(null as unknown as TrainHealthAttentionCommand);

    let ruleReads = 0;
    const hostile = {
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      pullRequest: null,
      deadlineIso: DEADLINE,
      get rule(): string {
        ruleReads += 1;
        throw new Error('boom');
      },
    };
    await expectInvalid(hostile as unknown as TrainHealthAttentionCommand);
    expect(ruleReads).toBe(0);
    expect(calls).toBe(0);
  });

  it('clears with resolve request via machine and maps cleared, unchanged, not-found', async () => {
    const outcomes = ['cleared', 'unchanged', 'not-found'] as const;
    const calls: { request: unknown; via: string; actor: string }[] = [];
    let index = 0;
    const adapter = new TrainHealthAttentionAdapter({
      clearAttentionItem: async (request, via, actor) => {
        calls.push({ request, via, actor });
        const outcome = outcomes[index];
        index += 1;
        return { outcome };
      },
    });
    const raw = command({ rule: 'stale-queue-entry', pullRequest: 12 });
    expect(raw).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'stale-queue-entry',
      pullRequest: 12,
      deadlineIso: DEADLINE,
    });
    const request = {
      action: 'resolve',
      projectId: PROJECT,
      kind: 'train-stale-queue-entry',
      subject: { kind: 'pr', ref: 'fleet/fleet-v2#12' },
      reason: 'resolved',
    };

    expect(await adapter.clearTrainHealthAttention(raw)).toEqual({
      outcome: 'cleared',
      reasonCode: null,
    });
    expect(await adapter.clearTrainHealthAttention(raw)).toEqual({
      outcome: 'unchanged',
      reasonCode: null,
    });
    expect(await adapter.clearTrainHealthAttention(raw)).toEqual({
      outcome: 'not-found',
      reasonCode: null,
    });
    expect(calls).toEqual([
      { request, via: 'machine', actor: 'train-watchdog' },
      { request, via: 'machine', actor: 'train-watchdog' },
      { request, via: 'machine', actor: 'train-watchdog' },
    ]);
    expectNoDeadline(calls);
  });

  it('lists open items for this repository and skips foreign or malformed entries', async () => {
    const query = listQuery();
    expect(query).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      deadlineIso: DEADLINE,
    });
    let itemReads = 0;
    const hostile = {
      get item(): unknown {
        itemReads += 1;
        throw new Error('boom');
      },
    };
    const entries = [
      projectEntry('tick-stale'),
      projectEntry('tick-stale', 'fleet/other'),
      prEntry('stale-queue-entry', 'fleet/fleet-v2#12'),
      {
        item: {
          projectId: PROJECT,
          kind: 'conductor-park',
          subject: { kind: 'project', ref: PROJECT },
          summary: 'train-health:tick-stale repo=fleet/fleet-v2',
          lastRaisedAtIso: RAISED_AT,
        },
      },
      projectEntry('findings-truncated'),
      prEntry('stale-queue-entry', 'other/repo#7'),
      projectEntry('queue-too-large'),
      {
        item: {
          projectId: 'other-proj',
          kind: 'train-tick-stale',
          subject: { kind: 'project', ref: PROJECT },
          summary: 'train-health:tick-stale repo=fleet/fleet-v2',
          lastRaisedAtIso: RAISED_AT,
        },
      },
      {
        item: {
          projectId: PROJECT,
          kind: 'train-stalled-head',
          subject: { kind: 'project', ref: PROJECT },
          summary: 'train-health:stalled-head repo=fleet/fleet-v2',
          lastRaisedAtIso: 'yesterday',
        },
      },
      null,
      hostile,
    ];
    const requests: unknown[] = [];
    const adapter = new TrainHealthAttentionAdapter({
      listAttentionItems: async (request) => {
        requests.push(request);
        return { items: entries };
      },
    });

    expect(await adapter.listOpenTrainHealthAttention(query)).toEqual({
      outcome: 'found',
      items: [
        { rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: RAISED_AT },
        { rule: 'stale-queue-entry', pullRequest: 12, lastRaisedAtIso: RAISED_AT },
        { rule: 'findings-truncated', pullRequest: null, lastRaisedAtIso: RAISED_AT },
        { rule: 'queue-too-large', pullRequest: null, lastRaisedAtIso: RAISED_AT },
      ],
    });
    expect(requests).toEqual([{ projectId: PROJECT, state: 'open' }]);
    expectNoDeadline(requests);
    expect(itemReads).toBe(0);
  });

  it('returns unavailable when list answer is null, items is not an array, delegate throws, or items exceeds 5000 entries', async () => {
    const query = listQuery();
    expect(query).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      deadlineIso: DEADLINE,
    });
    const answers: unknown[] = [null, 7, { items: null }, { items: {} }, { items: 'items' }, { outcome: 'found' }];
    for (const answer of answers) {
      const requests: unknown[] = [];
      const adapter = new TrainHealthAttentionAdapter({
        listAttentionItems: async (request) => {
          requests.push(request);
          return answer;
        },
      });
      expect(await adapter.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'unavailable' });
      expect(requests).toEqual([{ projectId: PROJECT, state: 'open' }]);
      expectNoDeadline(requests);
    }

    const throwing = new TrainHealthAttentionAdapter({
      listAttentionItems: async () => {
        throw new Error('boom');
      },
    });
    expect(await throwing.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'unavailable' });

    let itemListReads = 0;
    const hostileAnswer = {
      get items(): unknown[] {
        itemListReads += 1;
        throw new Error('boom');
      },
    };
    const hostileRequests: unknown[] = [];
    const hostile = new TrainHealthAttentionAdapter({
      listAttentionItems: async (request) => {
        hostileRequests.push(request);
        return hostileAnswer;
      },
    });
    expect(await hostile.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'unavailable' });
    expect(hostileRequests).toEqual([{ projectId: PROJECT, state: 'open' }]);
    expectNoDeadline(hostileRequests);
    expect(itemListReads).toBe(0);

    const overCapRequests: unknown[] = [];
    const overCap = new TrainHealthAttentionAdapter({
      listAttentionItems: async (request) => {
        overCapRequests.push(request);
        return { items: Array.from({ length: 5001 }, () => null) };
      },
    });
    expect(await overCap.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'unavailable' });
    expect(overCapRequests).toEqual([{ projectId: PROJECT, state: 'open' }]);
    expectNoDeadline(overCapRequests);

    const atCap = new TrainHealthAttentionAdapter({
      listAttentionItems: async () => ({ items: Array.from({ length: 5000 }, () => null) }),
    });
    expect(await atCap.listOpenTrainHealthAttention(query)).toEqual({ outcome: 'found', items: [] });

    const requests: unknown[] = [];
    const invalidQuery = new TrainHealthAttentionAdapter({
      listAttentionItems: async (request) => {
        requests.push(request);
        return { items: [] };
      },
    });
    expect(
      await invalidQuery.listOpenTrainHealthAttention({
        projectId: 'bad id',
        repository: { owner: '..', repo: REPO },
        deadlineIso: DEADLINE,
      }),
    ).toEqual({ outcome: 'unavailable' });
    expect(requests).toEqual([]);
  });
});

function projectEntry(rule: string, summaryRepo = `${OWNER}/${REPO}`, projectId = PROJECT) {
  return {
    item: {
      projectId,
      kind: `train-${rule}`,
      subject: { kind: 'project', ref: projectId },
      summary: `train-health:${rule} repo=${summaryRepo}`,
      lastRaisedAtIso: RAISED_AT,
    },
  };
}

function prEntry(rule: string, ref: string, projectId = PROJECT) {
  return {
    item: {
      projectId,
      kind: `train-${rule}`,
      subject: { kind: 'pr', ref },
      lastRaisedAtIso: RAISED_AT,
    },
  };
}
