// CO-WD2: the merge-train health watch use case.
import { describe, expect, it } from 'vitest';

import { WatchTrainHealthUseCase } from '../WatchTrainHealthUseCase.use-case.js';
import type { WatchTrainHealthDependencies } from '../WatchTrainHealthUseCase.use-case.js';
import type { TrainHealthStateReadResult } from '../../ports/out/TrainHealthStateReadPort.out-port.js';
import type {
  ClearTrainHealthAttentionResult,
  ListOpenTrainHealthAttentionResult,
  OpenTrainHealthAttentionItem,
  RaiseTrainHealthAttentionResult,
  TrainHealthAttentionCommand,
  TrainHealthAttentionRule,
} from '../../ports/out/TrainHealthAttentionPort.out-port.js';
import { TRAIN_HEALTH_ATTENTION_RULES } from '../../ports/out/TrainHealthAttentionPort.out-port.js';
import { TRAIN_HEALTH_RULES } from '../../../domain/train-health-rules.js';

const NOW = '2026-11-16T12:00:00.000Z';
const DEADLINE = '2026-11-16T12:05:00.000Z';
const DIGEST = '0123456789ab';
const OWNER = 'acme';
const REPO = 'train';
const PROJECT = 'p1';

type LogEntry = { kind: 'now' } | { kind: 'port'; method: string; arg: unknown };

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequest: 1,
    state: 'queued',
    forgeState: 'open',
    enqueuedAtIso: '2026-11-16T11:59:30.000Z',
    attempt: 0,
    ...overrides,
  };
}

function healthySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { queue: [], lastTickFinishedAtIso: '2026-11-16T11:59:00.000Z', ...overrides };
}

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: PROJECT,
    repository: { owner: OWNER, repo: REPO },
    repoDigest: DIGEST,
    deadlineIso: DEADLINE,
    ...overrides,
  };
}

interface FakeOptions {
  readonly stateRead?: unknown;
  readonly raiseBehavior?: (callIndex: number, arg: unknown) => unknown;
  readonly clearBehavior?: (callIndex: number, arg: unknown) => unknown;
  readonly openItems?: readonly unknown[];
  readonly listBehavior?: (callIndex: number) => unknown;
  readonly nowSchedule?: readonly string[];
  readonly now?: () => string;
}

/** One attention port fake with one ordered log shared with the clock. */
function makeDeps(options: FakeOptions = {}): {
  deps: WatchTrainHealthDependencies;
  log: LogEntry[];
  raiseCalls: readonly TrainHealthAttentionCommand[];
  clearCalls: readonly TrainHealthAttentionCommand[];
  listCalls: readonly unknown[];
} {
  const log: LogEntry[] = [];
  const nowSchedule = options.nowSchedule ?? [NOW];
  let nowIndex = 0;
  let raiseIndex = 0;
  let clearIndex = 0;
  let listIndex = 0;
  const raiseCalls: TrainHealthAttentionCommand[] = [];
  const clearCalls: TrainHealthAttentionCommand[] = [];
  const listCalls: unknown[] = [];
  const deps: WatchTrainHealthDependencies = {
    state: {
      readTrainHealthState: async (request) => {
        log.push({ kind: 'port', method: 'readTrainHealthState', arg: request });
        if (options.stateRead instanceof Error) {
          throw options.stateRead;
        }
        return (options.stateRead ?? {
          outcome: 'ok',
          snapshot: healthySnapshot(),
        }) as TrainHealthStateReadResult;
      },
    },
    attention: {
      raiseTrainHealthAttention: async (command) => {
        log.push({ kind: 'port', method: 'raiseTrainHealthAttention', arg: command });
        raiseCalls.push(command);
        raiseIndex += 1;
        if (options.raiseBehavior) {
          const answer = options.raiseBehavior(raiseIndex, command);
          if (answer instanceof Error) {
            throw answer;
          }
          return answer as RaiseTrainHealthAttentionResult;
        }
        return { outcome: 'raised', reasonCode: null };
      },
      clearTrainHealthAttention: async (command) => {
        log.push({ kind: 'port', method: 'clearTrainHealthAttention', arg: command });
        clearCalls.push(command);
        clearIndex += 1;
        if (options.clearBehavior) {
          const answer = options.clearBehavior(clearIndex, command);
          if (answer instanceof Error) {
            throw answer;
          }
          return answer as ClearTrainHealthAttentionResult;
        }
        return { outcome: 'cleared', reasonCode: null };
      },
      listOpenTrainHealthAttention: async (query) => {
        log.push({ kind: 'port', method: 'listOpenTrainHealthAttention', arg: query });
        listCalls.push(query);
        listIndex += 1;
        if (options.listBehavior) {
          const answer = options.listBehavior(listIndex);
          if (answer instanceof Error) {
            throw answer;
          }
          return answer as ListOpenTrainHealthAttentionResult;
        }
        return { outcome: 'found', items: (options.openItems ?? []) as readonly OpenTrainHealthAttentionItem[] };
      },
    },
    now:
      options.now ??
      (() => {
        log.push({ kind: 'now' });
        const value =
          nowIndex < nowSchedule.length ? nowSchedule[nowIndex] : nowSchedule[nowSchedule.length - 1];
        nowIndex += 1;
        return value;
      }),
  };
  return { deps, log, raiseCalls, clearCalls, listCalls };
}

function portCalls(log: readonly LogEntry[]): readonly { method: string; arg: unknown }[] {
  return log
    .filter((entry): entry is Extract<LogEntry, { kind: 'port' }> => entry.kind === 'port')
    .map((entry) => ({ method: entry.method, arg: entry.arg }));
}

function blindRaise(command: unknown): boolean {
  const value = command as Record<string, unknown> | undefined;
  return (
    value !== undefined &&
    value.projectId === PROJECT &&
    JSON.stringify(value.repository) === JSON.stringify({ owner: OWNER, repo: REPO }) &&
    value.rule === 'watchdog-blind' &&
    value.pullRequest === null
  );
}

async function run(deps: WatchTrainHealthDependencies, request: unknown) {
  return new WatchTrainHealthUseCase(deps).watchTrainHealth(request as never);
}

function blindStateRead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { outcome: 'unavailable', reasonCode: 'db-down', ...overrides };
}

describe('WatchTrainHealthUseCase', () => {
  it('refuses null request with zero port calls', async () => {
    const { deps, log } = makeDeps();
    const result = await run(deps, null);
    expect(result).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-request' });
    expect(portCalls(log)).toHaveLength(0);
  });

  it('refuses request with throwing projectId getter with zero port calls', async () => {
    const { deps, log } = makeDeps();
    const request: Record<string, unknown> = {
      repository: { owner: OWNER, repo: REPO },
      repoDigest: DIGEST,
      deadlineIso: DEADLINE,
    };
    Object.defineProperty(request, 'projectId', {
      get() {
        throw new Error('getter');
      },
    });
    const result = await run(deps, request);
    expect(result).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-request' });
    expect(portCalls(log)).toHaveLength(0);
  });

  it('refuses invalid repoDigest with zero port calls', async () => {
    const { deps, log } = makeDeps();
    const result = await run(deps, baseRequest({ repoDigest: 'XYZ' }));
    expect(result).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-request' });
    expect(portCalls(log)).toHaveLength(0);
  });

  it('refuses when now() throws', async () => {
    const { deps, log } = makeDeps({
      now: () => {
        throw new Error('clock');
      },
    });
    const result = await run(deps, baseRequest());
    expect(result).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-clock' });
    expect(portCalls(log)).toHaveLength(0);
  });

  it('refuses malformed deadline with invalid-deadline and zero port calls', async () => {
    const { deps, log } = makeDeps();
    const result = await run(deps, baseRequest({ deadlineIso: 'tomorrow' }));
    expect(result).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-deadline' });
    expect(portCalls(log)).toHaveLength(0);
  });

  it('returns budget-exhausted with zero port calls when deadline is 1 s away', async () => {
    const { deps, log } = makeDeps();
    const result = await run(deps, baseRequest({ deadlineIso: '2026-11-16T12:00:01.000Z' }));
    expect(result).toEqual({ outcome: 'budget-exhausted', exitCode: 1 });
    expect(portCalls(log)).toHaveLength(0);
  });

  it('stops raising and sets budgetExhausted when clock jumps past deadline after first raise', async () => {
    const late = '2026-11-16T12:10:00.000Z';
    const { deps, log, raiseCalls, clearCalls } = makeDeps({
      nowSchedule: [NOW, NOW, NOW, late],
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({
          lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z',
          queue: [entry({ pullRequest: 7, forgeState: 'closed' })],
        }) as never,
      },
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({ outcome: 'evaluated', budgetExhausted: true, healthy: false, exitCode: 1 });
    expect(raiseCalls).toHaveLength(1);
    expect(clearCalls).toHaveLength(0);
    const seen = log;
    for (let i = 0; i < seen.length; i += 1) {
      if (seen[i].kind === 'port') {
        expect(seen[i - 1]).toEqual({ kind: 'now' });
      }
    }
  });

  it('returns blind state-unavailable when state port returns unavailable', async () => {
    const { deps, log, raiseCalls } = makeDeps({ stateRead: blindStateRead() as never });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind',
      exitCode: 1,
      reasonCode: 'state-unavailable',
      raised: 1,
      attentionFailures: 0,
    });
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(raiseCalls).toHaveLength(1);
    expect(portCalls(log).filter((call) => call.method.startsWith('list') || call.method.startsWith('clear'))).toHaveLength(0);
  });

  it('returns blind state-unavailable when state port throws', async () => {
    const { deps, log, raiseCalls } = makeDeps({ stateRead: new Error('boom') });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind',
      reasonCode: 'state-unavailable',
      raised: 1,
      attentionFailures: 0,
    });
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(portCalls(log).filter((call) => call.method.startsWith('list') || call.method.startsWith('clear'))).toHaveLength(0);
  });

  it('returns blind state-budget-exhausted when state port answers budget-exhausted', async () => {
    const { deps, log, raiseCalls } = makeDeps({
      stateRead: { outcome: 'budget-exhausted' } as never,
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind',
      reasonCode: 'state-budget-exhausted',
      raised: 1,
      attentionFailures: 0,
    });
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(portCalls(log).filter((call) => call.method.startsWith('list') || call.method.startsWith('clear'))).toHaveLength(0);
  });

  it('returns blind evaluation-invalid-snapshot when snapshot has queue null', async () => {
    const { deps, log, raiseCalls } = makeDeps({
      stateRead: { outcome: 'ok', snapshot: { queue: null } as never },
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind',
      reasonCode: 'evaluation-invalid-snapshot',
      raised: 1,
      attentionFailures: 0,
    });
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(
      portCalls(log).filter((call) => call.method.startsWith('list') || call.method.startsWith('clear')),
    ).toHaveLength(0);
  });

  it('returns blind evaluation-invalid-clock when a snapshot time is ahead of the clock', async () => {
    const { deps, log, raiseCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({ lastTickFinishedAtIso: '2026-11-16T12:02:00.000Z' }) as never,
      },
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind',
      reasonCode: 'evaluation-invalid-clock',
      raised: 1,
      attentionFailures: 0,
    });
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(
      portCalls(log).filter((call) => call.method.startsWith('list') || call.method.startsWith('clear')),
    ).toHaveLength(0);
  });

  it('returns blind evaluation-invalid-thresholds when thresholds are out of range', async () => {
    const { deps, log, raiseCalls } = makeDeps({});
    const result = await run(deps, baseRequest({ thresholds: { tickStaleMinutes: 0 } }));
    expect(result).toMatchObject({
      outcome: 'blind',
      reasonCode: 'evaluation-invalid-thresholds',
      raised: 1,
      attentionFailures: 0,
    });
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(
      portCalls(log).filter((call) => call.method.startsWith('list') || call.method.startsWith('clear')),
    ).toHaveLength(0);
  });

  it('raises findings-truncated first and clears nothing when the finding list is cut', async () => {
    const entries = [];
    for (let pr = 1; pr <= 201; pr += 1) {
      entries.push(entry({ pullRequest: pr, forgeState: 'closed', enqueuedAtIso: '2026-11-16T10:00:00.000Z' }));
    }
    const { deps, raiseCalls, clearCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({ queue: entries }) as never,
      },
      openItems: [
        { rule: 'stalled-head', pullRequest: null, lastRaisedAtIso: NOW },
        { rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: NOW },
      ],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({ outcome: 'evaluated', truncated: true, healthy: false, exitCode: 1 });
    expect(result.outcome === 'evaluated' && result.findings.length === 200).toBe(true);
    expect(result.outcome === 'evaluated' && result.findings.some((f) => f.rule === 'stalled-head')).toBe(false);
    expect(raiseCalls[0]).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'findings-truncated',
      pullRequest: null,
    });
    expect(raiseCalls).toHaveLength(201);
    expect(clearCalls).toHaveLength(0);
  });

  it('assesses the first 500 entries and raises queue-too-large on a 501-entry queue', async () => {
    const entries = [];
    for (let pr = 1; pr <= 501; pr += 1) {
      const overrides = pr === 1 ? { enqueuedAtIso: '2026-11-16T10:00:00.000Z' } : {};
      if (pr === 501) {
        entries.push(entry({ ...overrides, pullRequest: pr, state: 'parked', attempt: 9 }));
      } else {
        entries.push(entry({ ...overrides, pullRequest: pr }));
      }
    }
    const { deps, raiseCalls, clearCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({ queue: entries }) as never,
      },
      openItems: [
        { rule: 'stale-queue-entry', pullRequest: 600, lastRaisedAtIso: NOW },
        { rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: NOW },
      ],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({ outcome: 'evaluated', queueOverflow: true, healthy: false, exitCode: 1 });
    expect(raiseCalls).toEqual([
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'queue-too-large', pullRequest: null },
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'stalled-head', pullRequest: null },
    ]);
    expect(result.outcome === 'evaluated' && result.findings[0].evidence.headPullRequest).toBe(1);
    expect(result.outcome === 'evaluated' && result.findings.some((f) => f.rule === 'repeated-park')).toBe(false);
    expect(clearCalls).toEqual([
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'tick-stale', pullRequest: null },
    ]);
  });

  it('does not raise queue-too-large at exactly 500 entries', async () => {
    const entries = [];
    for (let pr = 1; pr <= 500; pr += 1) {
      entries.push(entry({ pullRequest: pr }));
    }
    const { deps, raiseCalls } = makeDeps({
      stateRead: { outcome: 'ok', snapshot: healthySnapshot({ queue: entries }) as never },
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      queueOverflow: false,
      healthy: true,
      exitCode: 0,
      raised: 0,
      attentionFailures: 0,
    });
    expect(raiseCalls).toHaveLength(0);
  });

  it('counts throwing and refused raises in attentionFailures and continues raising remaining findings', async () => {
    const { deps, raiseCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({
          lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z',
          queue: [entry({ pullRequest: 1, enqueuedAtIso: '2026-11-16T10:00:00.000Z' })],
        }) as never,
      },
      raiseBehavior: (callIndex) => (callIndex === 1 ? { outcome: 'refused', reasonCode: 'x' } : new Error('boom')),
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      healthy: false,
      exitCode: 1,
      raised: 0,
      attentionFailures: 2,
    });
    expect(raiseCalls).toHaveLength(2);
  });

  it('clears nothing and sets attentionFailures 1 when list returns unavailable', async () => {
    const { deps, raiseCalls, clearCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({ lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z' }) as never,
      },
      listBehavior: () => ({ outcome: 'unavailable' }),
      openItems: [{ rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: NOW }],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      healthy: false,
      exitCode: 1,
      raised: 1,
      attentionFailures: 1,
    });
    expect(raiseCalls).toHaveLength(1);
    expect(clearCalls).toHaveLength(0);
  });

  it('never clears an open item it cannot identify and counts it as a failure', async () => {
    const { deps, clearCalls } = makeDeps({
      openItems: [
        null,
        { rule: 'bogus-rule', pullRequest: null, lastRaisedAtIso: NOW },
        { rule: 'tick-stale', pullRequest: 0, lastRaisedAtIso: NOW },
        { rule: 'tick-stale', pullRequest: '7', lastRaisedAtIso: NOW },
        { rule: 'tick-stale', lastRaisedAtIso: NOW },
      ],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({ outcome: 'evaluated', healthy: false, attentionFailures: 5 });
    expect(clearCalls).toHaveLength(0);
  });

  it('counts refused or throwing clear in attentionFailures and continues', async () => {
    const { deps, clearCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({ lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z' }) as never,
      },
      clearBehavior: (callIndex) =>
        callIndex === 1 ? { outcome: 'refused', reasonCode: 'x' } : callIndex === 2 ? new Error('boom') : { outcome: 'cleared', reasonCode: null },
      openItems: [
        { rule: 'watchdog-blind', pullRequest: null, lastRaisedAtIso: NOW },
        { rule: 'findings-truncated', pullRequest: null, lastRaisedAtIso: NOW },
        { rule: 'queue-too-large', pullRequest: null, lastRaisedAtIso: NOW },
      ],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      healthy: false,
      exitCode: 1,
      cleared: 1,
      attentionFailures: 2,
    });
    expect(clearCalls).toHaveLength(3);
  });

  it('keeps stale-queue-entry and repeated-park on unknownForgeStates 1 while clearing tick-stale and returning healthy false', async () => {
    const { deps, clearCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({ queue: [entry({ forgeState: 'unknown' })] }) as never,
      },
      openItems: [
        { rule: 'stale-queue-entry', pullRequest: 7, lastRaisedAtIso: NOW },
        { rule: 'repeated-park', pullRequest: 7, lastRaisedAtIso: NOW },
        { rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: NOW },
        { rule: 'watchdog-blind', pullRequest: null, lastRaisedAtIso: NOW },
      ],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({ outcome: 'evaluated', healthy: false, exitCode: 1 });
    expect(result.outcome === 'evaluated' && result.unknownForgeStates).toBe(1);
    expect(clearCalls.map((call) => call.rule)).toEqual(['tick-stale', 'watchdog-blind']);
  });

  it('healthy snapshot returns evaluated healthy true exit 0 with zero raises and one list', async () => {
    const { deps, log, raiseCalls, clearCalls, listCalls } = makeDeps();
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      healthy: true,
      exitCode: 0,
      raised: 0,
      cleared: 0,
      attentionFailures: 0,
      budgetExhausted: false,
    });
    expect(raiseCalls).toHaveLength(0);
    expect(clearCalls).toHaveLength(0);
    expect(listCalls).toHaveLength(1);
    expect(portCalls(log)).toHaveLength(2);
  });

  it('one finding raises exact command and returns exit 1', async () => {
    const { deps, raiseCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({ lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z' }) as never,
      },
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({ outcome: 'evaluated', healthy: false, exitCode: 1 });
    expect(raiseCalls).toEqual([
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'tick-stale', pullRequest: null },
    ]);
  });

  it('clears open item with no matching finding and keeps matching one', async () => {
    const { deps, clearCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({ lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z' }) as never,
      },
      openItems: [
        { rule: 'stale-queue-entry', pullRequest: 7, lastRaisedAtIso: NOW },
        { rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: NOW },
      ],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({ outcome: 'evaluated', cleared: 1, healthy: false, exitCode: 1 });
    expect(clearCalls).toEqual([
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'stale-queue-entry', pullRequest: 7 },
    ]);
  });

  it('evaluated pass clears open watchdog-blind and findings-truncated items', async () => {
    const { deps, clearCalls } = makeDeps({
      openItems: [
        { rule: 'watchdog-blind', pullRequest: null, lastRaisedAtIso: NOW },
        { rule: 'findings-truncated', pullRequest: null, lastRaisedAtIso: NOW },
        { rule: 'queue-too-large', pullRequest: null, lastRaisedAtIso: NOW },
      ],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      healthy: true,
      exitCode: 0,
      raised: 0,
      cleared: 3,
      attentionFailures: 0,
    });
    expect(clearCalls.map((call) => call.rule)).toEqual(['watchdog-blind', 'findings-truncated', 'queue-too-large']);
  });

  it('the first five attention rules are the CO-WD1 rules in order', () => {
    expect((TRAIN_HEALTH_ATTENTION_RULES as readonly TrainHealthAttentionRule[]).slice(0, 5)).toEqual([
      ...TRAIN_HEALTH_RULES,
    ]);
  });
});
