// CO-WD2: the merge-train health watch use case.
import { describe, expect, it, vi } from 'vitest';

import { WatchTrainHealthUseCase } from '../WatchTrainHealthUseCase.use-case.js';
import type { WatchTrainHealthDependencies } from '../WatchTrainHealthUseCase.use-case.js';
import type { HostAudibleAlertResult } from '../../ports/out/HostAudibleAlertPort.out-port.js';
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
/** 12:02 and 12:03 share the 10-minute bucket that starts at 12:00. */
const SAME_BUCKET_NOW = '2026-11-16T12:03:00.000Z';
const ONE_MINUTE_EARLIER = '2026-11-16T12:02:00.000Z';
const PREVIOUS_BUCKET = '2026-11-16T11:59:00.000Z';
const SENTENCE_TICK_STALE = 'The merge train has stopped ticking.';
const SENTENCE_STALLED_HEAD = 'The head of the merge train is stalled.';
const SENTENCE_WATCHDOG_BLIND = 'The merge train watchdog cannot read the train state.';
const SENTENCE_TRUNCATED = 'The merge train has more problems than the watchdog can list.';
const SENTENCE_QUEUE = 'The merge train queue is too long to check completely.';
const SENTENCE_FALLBACK = 'The merge train watchdog cannot decide what to announce.';
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
  readonly nowBehavior?: (index: number) => string;
  readonly alertMode?: 'on' | 'missing-speak';
  readonly alertSpeak?: (callIndex: number, arg: { readonly sentence: string }) => unknown;
  readonly respeakMinutes?: number;
}

/** One attention port fake with one ordered log shared with the clock. */
function makeDeps(options: FakeOptions = {}): {
  deps: WatchTrainHealthDependencies;
  log: LogEntry[];
  raiseCalls: readonly TrainHealthAttentionCommand[];
  clearCalls: readonly TrainHealthAttentionCommand[];
  listCalls: readonly unknown[];
  speakCalls: readonly { sentence: string }[];
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
  const speakCalls: { sentence: string }[] = [];
  let speakIndex = 0;
  let alert: WatchTrainHealthDependencies['alert'];
  if (options.alertMode === 'missing-speak') {
    alert = {} as WatchTrainHealthDependencies['alert'];
  }
  if (options.alertMode === 'on') {
    alert = {
      speak: async (request) => {
        log.push({ kind: 'port', method: 'speak', arg: request });
        speakCalls.push(request);
        speakIndex += 1;
        if (options.alertSpeak) {
          const answer = options.alertSpeak(speakIndex, request);
          if (answer instanceof Error) {
            throw answer;
          }
          return answer as HostAudibleAlertResult;
        }
        return { outcome: 'spoken' };
      },
    };
  }
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
        const index = nowIndex;
        nowIndex += 1;
        if (options.nowBehavior) {
          return options.nowBehavior(index);
        }
        return index < nowSchedule.length ? nowSchedule[index] : nowSchedule[nowSchedule.length - 1];
      }),
    ...(alert === undefined ? {} : { alert }),
    ...(options.respeakMinutes === undefined ? {} : { respeakMinutes: options.respeakMinutes }),
  };
  return { deps, log, raiseCalls, clearCalls, listCalls, speakCalls };
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

function okState(snapshot: Record<string, unknown>): Record<string, unknown> {
  return { outcome: 'ok', snapshot };
}

function tickStaleSnapshot(): Record<string, unknown> {
  return healthySnapshot({ lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z' });
}

function stalledHeadSnapshot(): Record<string, unknown> {
  return healthySnapshot({
    queue: [entry({ pullRequest: 7, enqueuedAtIso: '2026-11-16T10:00:00.000Z' })],
  });
}

function tickAndStalledSnapshot(): Record<string, unknown> {
  return healthySnapshot({
    lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z',
    queue: [entry({ pullRequest: 7, enqueuedAtIso: '2026-11-16T10:00:00.000Z' })],
  });
}

function closedEntries(count: number): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (let pullRequest = 1; pullRequest <= count; pullRequest += 1) {
    entries.push(entry({ pullRequest, forgeState: 'closed' }));
  }
  return entries;
}

function staleSentence(pullRequest: number): string {
  return `Pull request ${String(pullRequest)} is closed or merged but still on the merge train.`;
}

function summarySentence(kept: number): string {
  return `${String(kept)} more merge train problems are not announced.`;
}

function portMethods(log: readonly LogEntry[]): string[] {
  return portCalls(log).map((call) => call.method);
}

function expectClockBeforeEveryPort(log: readonly LogEntry[]): void {
  for (let index = 0; index < log.length; index += 1) {
    if (log[index].kind === 'port') {
      expect(log[index - 1]).toEqual({ kind: 'now' });
    }
  }
}

/** Runs queued promise reactions without moving the fake clock. */
async function drainMicrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
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
      // One extra NOW accounts for readState's own budget re-check before the
      // port call (the fix for the unbounded state read): the clock jump to
      // `late` must still land on raiseAll's second target, not on readState.
      nowSchedule: [NOW, NOW, NOW, NOW, late],
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
    expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, budgetExhausted: true, healthy: false, exitCode: 1 });
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
      outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
      outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
      outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
      reasonCode: 'state-budget-exhausted',
      raised: 1,
      attentionFailures: 0,
    });
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(portCalls(log).filter((call) => call.method.startsWith('list') || call.method.startsWith('clear'))).toHaveLength(0);
  });

  it('returns ok unchanged when the state read answers inside its own timeout', async () => {
    const { deps, log } = makeDeps({
      stateRead: { outcome: 'ok', snapshot: healthySnapshot() } as never,
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, healthy: true, exitCode: 0 });
    expect(portCalls(log).filter((call) => call.method === 'readTrainHealthState')).toHaveLength(1);
  });

  it('bounds the state read with its own timeout when the port never resolves', async () => {
    vi.useFakeTimers();
    try {
      const { deps, log, raiseCalls } = makeDeps();
      const hanging = new Promise<TrainHealthStateReadResult>(() => {});
      const hangDeps = {
        ...deps,
        state: {
          ...deps.state,
          readTrainHealthState: async (request) => {
            log.push({ kind: 'port', method: 'readTrainHealthState', arg: request });
            return hanging;
          },
        },
      } as WatchTrainHealthDependencies;
      const pending = run(hangDeps, baseRequest());
      let settledEarly = false;
      void pending.then(() => {
        settledEarly = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settledEarly).toBe(false);
      await vi.advanceTimersByTimeAsync(400_000);
      const result = await pending;
      expect(result).toMatchObject({
        outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
        reasonCode: 'state-read-timed-out',
        raised: 1,
        attentionFailures: 0,
      });
      expect(blindRaise(raiseCalls[0])).toBe(true);
      expect(portCalls(log).filter((call) => call.method === 'readTrainHealthState')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns state-unavailable, never state-read-timed-out, when the port rejects with an error that merely looks like the timeout', async () => {
    const { deps, log, raiseCalls } = makeDeps();
    const lookalikeDeps = {
      ...deps,
      state: {
        ...deps.state,
        readTrainHealthState: async (request) => {
          log.push({ kind: 'port', method: 'readTrainHealthState', arg: request });
          throw new Error('state-read-timeout');
        },
      },
    } as WatchTrainHealthDependencies;
    const result = await run(lookalikeDeps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
      reasonCode: 'state-unavailable',
      raised: 1,
      attentionFailures: 0,
    });
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(portCalls(log).filter((call) => call.method === 'readTrainHealthState')).toHaveLength(1);
  });

  it('skips the state read entirely when its own budget is already exhausted', async () => {
    const { deps, log, raiseCalls } = makeDeps({ nowSchedule: [NOW, DEADLINE] });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
      reasonCode: 'state-budget-exhausted',
      raised: 0,
      attentionFailures: 0,
    });
    expect(portCalls(log).filter((call) => call.method === 'readTrainHealthState')).toHaveLength(0);
    expect(raiseCalls).toHaveLength(0);
  });

  it('returns blind evaluation-invalid-snapshot when snapshot has queue null', async () => {
    const { deps, log, raiseCalls } = makeDeps({
      stateRead: { outcome: 'ok', snapshot: { queue: null } as never },
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
      outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
      outcome: 'blind', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
    expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, truncated: true, healthy: false, exitCode: 1 });
    expect(result.outcome === 'evaluated' && result.findings.length === 200).toBe(true);
    expect(result.outcome === 'evaluated' && result.findings.some((f) => f.rule === 'stalled-head')).toBe(false);
    expect(raiseCalls[0]).toEqual({
      projectId: PROJECT,
      repository: { owner: OWNER, repo: REPO },
      rule: 'findings-truncated',
      pullRequest: null,
      deadlineIso: DEADLINE,
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
    expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, queueOverflow: true, healthy: false, exitCode: 1 });
    expect(raiseCalls).toEqual([
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'queue-too-large', pullRequest: null, deadlineIso: DEADLINE },
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'stalled-head', pullRequest: null, deadlineIso: DEADLINE },
    ]);
    expect(result.outcome === 'evaluated' && result.findings[0].evidence.headPullRequest).toBe(1);
    expect(result.outcome === 'evaluated' && result.findings.some((f) => f.rule === 'repeated-park')).toBe(false);
    expect(clearCalls).toEqual([
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'tick-stale', pullRequest: null, deadlineIso: DEADLINE },
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
      outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
      outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0,
      healthy: false,
      exitCode: 1,
      raised: 0,
      attentionFailures: 2,
    });
    expect(raiseCalls).toHaveLength(2);
  });

  it('treats a non-string attention outcome as a failed raise, never coercing or invoking its toString', async () => {
    let toStringCalls = 0;
    const throwingOutcome = {
      toString() {
        toStringCalls += 1;
        throw new Error('should never be read');
      },
    };
    const coercesToRaisedOutcome = { toString: () => 'raised' };
    const { deps, raiseCalls } = makeDeps({
      stateRead: {
        outcome: 'ok',
        snapshot: healthySnapshot({
          lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z',
          queue: [entry({ pullRequest: 1, enqueuedAtIso: '2026-11-16T10:00:00.000Z' })],
        }) as never,
      },
      raiseBehavior: (callIndex) =>
        callIndex === 1
          ? { outcome: coercesToRaisedOutcome, reasonCode: null }
          : { outcome: throwingOutcome, reasonCode: null },
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0,
      healthy: false,
      exitCode: 1,
      raised: 0,
      attentionFailures: 2,
    });
    expect(raiseCalls).toHaveLength(2);
    expect(toStringCalls).toBe(0);
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
      outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
    expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, healthy: false, attentionFailures: 5 });
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
      outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
    expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, healthy: false, exitCode: 1 });
    expect(result.outcome === 'evaluated' && result.unknownForgeStates).toBe(1);
    expect(clearCalls.map((call) => call.rule)).toEqual(['tick-stale', 'watchdog-blind']);
  });

  it('healthy snapshot returns evaluated healthy true exit 0 with zero raises and one list', async () => {
    const { deps, log, raiseCalls, clearCalls, listCalls } = makeDeps();
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0,
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
    expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, healthy: false, exitCode: 1 });
    expect(raiseCalls).toEqual([
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'tick-stale', pullRequest: null, deadlineIso: DEADLINE },
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
    expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, cleared: 1, healthy: false, exitCode: 1 });
    expect(clearCalls).toEqual([
      { projectId: PROJECT, repository: { owner: OWNER, repo: REPO }, rule: 'stale-queue-entry', pullRequest: 7, deadlineIso: DEADLINE },
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
      outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0,
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

  it('bounds each attention await with the remaining call budget', async () => {
    vi.useFakeTimers();
    try {
      const { deps, log, clearCalls } = makeDeps({
        stateRead: {
          outcome: 'ok',
          snapshot: healthySnapshot({ lastTickFinishedAtIso: '2026-11-16T11:00:00.000Z' }) as never,
        },
        openItems: [],
      });
      const hanging = new Promise<RaiseTrainHealthAttentionResult>(() => {});
      const hangDeps = {
        ...deps,
        attention: {
          ...deps.attention,
          raiseTrainHealthAttention: async (command: TrainHealthAttentionCommand) => {
          log.push({ kind: 'port', method: 'raiseTrainHealthAttention', arg: command });
          return hanging;
        },
        },
      } as WatchTrainHealthDependencies;
      const pending = run(hangDeps, baseRequest());
      let settledEarly = false;
      void pending.then(() => {
        settledEarly = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settledEarly).toBe(false);
      await vi.advanceTimersByTimeAsync(400_000);
      const result = await pending;
      expect(result).toMatchObject({ outcome: 'evaluated', announced: 0, announceFailures: 0, announceSuppressed: 0, healthy: false, exitCode: 1, attentionFailures: 1 });
      const raiseEntries = log.filter(
        (entry) => entry.kind === 'port' && entry.method === 'raiseTrainHealthAttention',
      );
      expect(raiseEntries).toHaveLength(1);
      expect(raiseEntries[0].kind === 'port' && raiseEntries[0].arg).toEqual({
        projectId: PROJECT,
        repository: { owner: OWNER, repo: REPO },
        rule: 'tick-stale',
        pullRequest: null,
        deadlineIso: DEADLINE,
      });
      expect(clearCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no alert dependency -> zero speaks, counters 0, and blind path makes no list call', async () => {
    const evaluated = makeDeps({ stateRead: okState(tickStaleSnapshot()) as never });
    const evaluatedResult = await run(evaluated.deps, baseRequest());
    expect(evaluatedResult).toMatchObject({
      outcome: 'evaluated',
      announced: 0,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(evaluated.speakCalls).toHaveLength(0);
    expect(portMethods(evaluated.log)).not.toContain('speak');

    const blind = makeDeps({ stateRead: blindStateRead() as never });
    const blindResult = await run(blind.deps, baseRequest());
    expect(blindResult).toMatchObject({
      outcome: 'blind',
      announced: 0,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(portMethods(blind.log).filter((method) => method.startsWith('list'))).toHaveLength(0);

    const missing = makeDeps({ alertMode: 'missing-speak', stateRead: blindStateRead() as never });
    const missingResult = await run(missing.deps, baseRequest());
    expect(missingResult).toMatchObject({
      outcome: 'blind',
      announced: 0,
      announceFailures: 0,
      announceSuppressed: 0,
    });
    expect(portMethods(missing.log).filter((method) => method.startsWith('list'))).toHaveLength(0);
    expect(missing.speakCalls).toHaveLength(0);
  });

  it('new finding (no open item) -> speak called once with { sentence } for that finding, in order list, raise, speak', async () => {
    const { deps, log, speakCalls, raiseCalls, clearCalls } = makeDeps({
      alertMode: 'on',
      stateRead: okState(stalledHeadSnapshot()) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 1,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 1,
      healthy: false,
      exitCode: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_STALLED_HEAD }]);
    expect(portMethods(log)).toEqual([
      'readTrainHealthState',
      'listOpenTrainHealthAttention',
      'raiseTrainHealthAttention',
      'speak',
    ]);
    expect(raiseCalls.map((call) => call.rule)).toEqual(['stalled-head']);
    expect(clearCalls).toHaveLength(0);
    expectClockBeforeEveryPort(log);
  });

  it('open item for same finding raised 1 minute ago in same 10-minute bucket -> not spoken, still raised', async () => {
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      nowSchedule: [SAME_BUCKET_NOW],
      stateRead: okState(tickStaleSnapshot()) as never,
      openItems: [{ rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: ONE_MINUTE_EARLIER }],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 0,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(speakCalls).toHaveLength(0);
    expect(raiseCalls.map((call) => call.rule)).toEqual(['tick-stale']);
  });

  it('open item for same finding with clock in next bucket -> spoken', async () => {
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      stateRead: okState(tickStaleSnapshot()) as never,
      openItems: [{ rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: PREVIOUS_BUCKET }],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 1,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(raiseCalls.map((call) => call.rule)).toEqual(['tick-stale']);
  });

  it('five due targets -> two sentences plus the summary sentence, announceSuppressed 3', async () => {
    const five = makeDeps({
      alertMode: 'on',
      stateRead: okState(healthySnapshot({ lastTickFinishedAtIso: NOW, queue: closedEntries(5) })) as never,
      openItems: [],
    });
    const fiveResult = await run(five.deps, baseRequest());
    expect(fiveResult).toMatchObject({
      outcome: 'evaluated',
      announced: 3,
      announceFailures: 0,
      announceSuppressed: 3,
      raised: 5,
    });
    expect(five.speakCalls).toEqual([
      { sentence: staleSentence(1) },
      { sentence: staleSentence(2) },
      { sentence: summarySentence(3) },
    ]);

    const unknown = makeDeps({
      alertMode: 'on',
      stateRead: okState(healthySnapshot({ lastTickFinishedAtIso: NOW, queue: closedEntries(5) })) as never,
      listBehavior: () => ({ outcome: 'unavailable' }),
    });
    const unknownResult = await run(unknown.deps, baseRequest());
    expect(unknownResult).toMatchObject({
      outcome: 'evaluated',
      announced: 3,
      announceFailures: 0,
      announceSuppressed: 3,
      attentionFailures: 1,
      raised: 5,
    });
    expect(unknown.speakCalls).toEqual(five.speakCalls);
    expect(unknown.clearCalls).toHaveLength(0);
  });

  it('speak that throws, speak returning failed nonzero-exit, and speak returning null each count one announceFailures and raise still happens', async () => {
    const behaviors: Array<(callIndex: number, arg: { readonly sentence: string }) => unknown> = [
      () => new Error('boom'),
      () => ({ outcome: 'failed', reasonCode: 'nonzero-exit' }),
      () => null,
    ];
    for (const alertSpeak of behaviors) {
      const { deps, speakCalls, raiseCalls } = makeDeps({
        alertMode: 'on',
        alertSpeak,
        stateRead: okState(tickStaleSnapshot()) as never,
        openItems: [],
      });
      const result = await run(deps, baseRequest());
      expect(result).toMatchObject({
        outcome: 'evaluated',
        announced: 0,
        announceFailures: 1,
        announceSuppressed: 0,
        raised: 1,
        exitCode: 1,
      });
      expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
      expect(raiseCalls.map((call) => call.rule)).toEqual(['tick-stale']);
    }
  });

  it('speak returning unavailable binary-missing counts one announceFailures', async () => {
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      alertSpeak: () => ({ outcome: 'unavailable', reasonCode: 'binary-missing' }),
      stateRead: okState(tickStaleSnapshot()) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 0,
      announceFailures: 1,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(raiseCalls).toHaveLength(1);
  });

  it('clock jumping past deadline before second speak -> one speak, budgetExhausted true, every port call preceded by clock read', async () => {
    const late = '2026-11-16T12:10:00.000Z';
    // Reorder: raises finish before speech. Reads are watch, readState, list,
    // decision, raise tick-stale, raise stalled-head, first speak, second speak.
    // The jump lands on the second speak. The sentence not started is unspoken.
    const { deps, log, speakCalls, raiseCalls, clearCalls } = makeDeps({
      alertMode: 'on',
      nowSchedule: [NOW, NOW, NOW, NOW, NOW, NOW, NOW, late],
      stateRead: okState(tickAndStalledSnapshot()) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 1,
      announceFailures: 0,
      announceSuppressed: 1,
      budgetExhausted: true,
      raised: 2,
      healthy: false,
      exitCode: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(raiseCalls).toHaveLength(2);
    expect(clearCalls).toHaveLength(0);
    expectClockBeforeEveryPort(log);
  });

  it("blind path with alert -> list, raise, speak { sentence: 'The merge train watchdog cannot read the train state.' }, and no clear", async () => {
    const { deps, log, speakCalls, raiseCalls, clearCalls, listCalls } = makeDeps({
      alertMode: 'on',
      stateRead: blindStateRead() as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind',
      reasonCode: 'state-unavailable',
      announced: 1,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 1,
      attentionFailures: 0,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_WATCHDOG_BLIND }]);
    expect(listCalls).toHaveLength(1);
    expect(clearCalls).toHaveLength(0);
    expect(blindRaise(raiseCalls[0])).toBe(true);
    expect(portMethods(log)).toEqual([
      'readTrainHealthState',
      'listOpenTrainHealthAttention',
      'raiseTrainHealthAttention',
      'speak',
    ]);
    expectClockBeforeEveryPort(log);
  });

  it('blind path with open watchdog-blind item raised in same bucket -> not spoken, raised', async () => {
    const { deps, speakCalls, raiseCalls, clearCalls, listCalls } = makeDeps({
      alertMode: 'on',
      nowSchedule: [SAME_BUCKET_NOW],
      stateRead: blindStateRead() as never,
      openItems: [{ rule: 'watchdog-blind', pullRequest: null, lastRaisedAtIso: ONE_MINUTE_EARLIER }],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind',
      announced: 0,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(speakCalls).toHaveLength(0);
    expect(listCalls).toHaveLength(1);
    expect(clearCalls).toHaveLength(0);
    expect(blindRaise(raiseCalls[0])).toBe(true);
  });

  it('blind path with an unavailable open list -> one attentionFailures, watchdog sentence still spoken, no clear', async () => {
    const { deps, speakCalls, raiseCalls, clearCalls } = makeDeps({
      alertMode: 'on',
      stateRead: blindStateRead() as never,
      listBehavior: () => ({ outcome: 'unavailable' }),
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'blind',
      announced: 1,
      announceFailures: 0,
      announceSuppressed: 0,
      attentionFailures: 1,
      raised: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_WATCHDOG_BLIND }]);
    expect(clearCalls).toHaveLength(0);
    expect(blindRaise(raiseCalls[0])).toBe(true);
  });

  it('respeakMinutes 1 changes the bucket', async () => {
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      respeakMinutes: 1,
      nowSchedule: [SAME_BUCKET_NOW],
      stateRead: okState(tickStaleSnapshot()) as never,
      openItems: [{ rule: 'tick-stale', pullRequest: null, lastRaisedAtIso: ONE_MINUTE_EARLIER }],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 1,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(raiseCalls.map((call) => call.rule)).toEqual(['tick-stale']);
  });

  it('invalid respeakMinutes (0) makes decision refuse and the fallback sentence is spoken', async () => {
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      respeakMinutes: 0,
      stateRead: okState(healthySnapshot({ lastTickFinishedAtIso: NOW, queue: closedEntries(5) })) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 1,
      announceFailures: 0,
      announceSuppressed: 0,
      raised: 5,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_FALLBACK }]);
    expect(raiseCalls).toHaveLength(5);
  });

  it('queue overflow and truncation targets are announced', async () => {
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      stateRead: okState(healthySnapshot({
        lastTickFinishedAtIso: NOW,
        queue: closedEntries(501),
      })) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      queueOverflow: true,
      truncated: true,
      announced: 3,
      announceFailures: 0,
      announceSuppressed: 200,
    });
    expect(speakCalls).toEqual([
      { sentence: SENTENCE_TRUNCATED },
      { sentence: SENTENCE_QUEUE },
      { sentence: summarySentence(200) },
    ]);
    expect(raiseCalls[0].rule).toBe('queue-too-large');
    expect(raiseCalls[1].rule).toBe('findings-truncated');
  });

  it('a never-answering speak is cut by the budget timeout and counts one announceFailures', async () => {
    vi.useFakeTimers();
    try {
      const { deps, speakCalls, raiseCalls } = makeDeps({
        alertMode: 'on',
        alertSpeak: () => new Promise<never>(() => {}),
        stateRead: okState(tickStaleSnapshot()) as never,
        openItems: [],
      });
      const pending = run(deps, baseRequest());
      let settledEarly = false;
      void pending.then(() => {
        settledEarly = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settledEarly).toBe(false);
      await vi.advanceTimersByTimeAsync(400_000);
      const result = await pending;
      expect(result).toMatchObject({
        outcome: 'evaluated',
        announced: 0,
        announceFailures: 1,
        announceSuppressed: 0,
        raised: 1,
      });
      expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
      expect(raiseCalls.map((call) => call.rule)).toEqual(['tick-stale']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clock invalid mid speak loop -> refused invalid-clock', async () => {
    const base = {
      alertMode: 'on' as const,
      stateRead: okState(tickAndStalledSnapshot()) as never,
      openItems: [],
    };
    const thrown = makeDeps({
      ...base,
      // Reorder: watch, readState, list, decision, two raises, first speak, then the second speak.
      nowBehavior: (index) => {
        if (index >= 7) {
          throw new Error('clock');
        }
        return NOW;
      },
    });
    const thrownResult = await run(thrown.deps, baseRequest());
    expect(thrownResult).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-clock' });
    expect(thrown.speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(thrown.raiseCalls).toHaveLength(2);

    const malformed = makeDeps({
      ...base,
      nowBehavior: (index) => (index >= 7 ? 'not-a-clock' : NOW),
    });
    const malformedResult = await run(malformed.deps, baseRequest());
    expect(malformedResult).toEqual({ outcome: 'refused', exitCode: 1, reasonCode: 'invalid-clock' });
    expect(malformed.speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(malformed.raiseCalls).toHaveLength(2);
  });

  it('hung speak on an advancing clock with a 60s deadline still raises every due target', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      // Reorder: the three raises finish while the clock is still at the start,
      // so the reserve no longer stops the third speak. Each hung speak is
      // capped at 10s and all three fit in the 60s deadline. Nothing is left unspoken.
      const deadlineIso = new Date(Date.parse(NOW) + 60_000).toISOString();
      const { deps, speakCalls, raiseCalls } = makeDeps({
        alertMode: 'on',
        now: () => new Date(Date.now()).toISOString(),
        alertSpeak: () => new Promise<never>(() => {}),
        stateRead: okState(healthySnapshot({ lastTickFinishedAtIso: NOW, queue: closedEntries(3) })) as never,
        openItems: [],
      });
      const pending = run(deps, baseRequest({ deadlineIso }));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await drainMicrotasks(60);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks(30);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks(30);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      await drainMicrotasks(30);
      const result = await pending;
      expect(result).toMatchObject({
        outcome: 'evaluated',
        announced: 0,
        announceFailures: 3,
        announceSuppressed: 0,
        raised: 3,
        budgetExhausted: false,
      });
      expect(raiseCalls).toHaveLength(3);
      expect(speakCalls).toEqual([
        { sentence: staleSentence(1) },
        { sentence: staleSentence(2) },
        { sentence: staleSentence(3) },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('budget exhausted before any speak reports nothing spoken and every planned sentence unspoken', async () => {
    const late = '2026-11-16T12:10:00.000Z';
    // Reads: watch, readState, list, then the announce budget, which is already past the deadline.
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      nowSchedule: [NOW, NOW, NOW, late],
      stateRead: okState(tickStaleSnapshot()) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 0,
      announceFailures: 0,
      announceSuppressed: 1,
      budgetExhausted: true,
      raised: 0,
      healthy: false,
      exitCode: 1,
    });
    expect(speakCalls).toHaveLength(0);
    expect(raiseCalls).toHaveLength(0);
  });

  it('speak returning refused counts one announceFailures and raise still happens', async () => {
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      alertSpeak: () => ({ outcome: 'refused', reasonCode: 'invalid-request' }),
      stateRead: okState(tickStaleSnapshot()) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 0,
      announceFailures: 1,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(raiseCalls.map((call) => call.rule)).toEqual(['tick-stale']);
  });

  it('speak returning invalid-request counts one announceFailures and raise still happens', async () => {
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      alertSpeak: () => ({ outcome: 'refused', reasonCode: 'invalid-request' }),
      stateRead: okState(tickStaleSnapshot()) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 0,
      announceFailures: 1,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(raiseCalls.map((call) => call.rule)).toEqual(['tick-stale']);
  });

  it('a speak result whose outcome is a getter never runs and counts one announceFailures', async () => {
    let outcomeReads = 0;
    const { deps, speakCalls, raiseCalls } = makeDeps({
      alertMode: 'on',
      alertSpeak: () => {
        const answer: { outcome?: string } = {};
        Object.defineProperty(answer, 'outcome', {
          enumerable: true,
          configurable: true,
          get() {
            outcomeReads += 1;
            return 'spoken';
          },
        });
        return answer;
      },
      stateRead: okState(tickStaleSnapshot()) as never,
      openItems: [],
    });
    const result = await run(deps, baseRequest());
    expect(outcomeReads).toBe(0);
    expect(result).toMatchObject({
      outcome: 'evaluated',
      announced: 0,
      announceFailures: 1,
      announceSuppressed: 0,
      raised: 1,
    });
    expect(speakCalls).toEqual([{ sentence: SENTENCE_TICK_STALE }]);
    expect(raiseCalls.map((call) => call.rule)).toEqual(['tick-stale']);
  });

  it('60s deadline, three due targets, two speaks that never answer, and a first raise that hangs for its 30s timeout still starts every raise the no-alert path would start', async () => {
    const deadlineIso = new Date(Date.parse(NOW) + 60_000).toISOString();
    const stateRead = okState(
      healthySnapshot({ lastTickFinishedAtIso: NOW, queue: closedEntries(3) }),
    ) as never;
    const runPass = async (withAlert: boolean) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(NOW));
      const made = makeDeps({
        ...(withAlert ? { alertMode: 'on' as const } : {}),
        now: () => new Date(Date.now()).toISOString(),
        raiseBehavior: (callIndex) =>
          callIndex === 1 ? new Promise<never>(() => {}) : { outcome: 'raised', reasonCode: null },
        ...(withAlert
          ? {
              alertSpeak: (callIndex: number) =>
                callIndex <= 2 ? new Promise<never>(() => {}) : { outcome: 'spoken' },
            }
          : {}),
        stateRead,
        openItems: [],
      });
      const pending = run(made.deps, baseRequest({ deadlineIso }));
      await drainMicrotasks(60);
      await vi.advanceTimersByTimeAsync(30_000);
      await drainMicrotasks(30);
      if (withAlert) {
        await vi.advanceTimersByTimeAsync(10_000);
        await drainMicrotasks(30);
        await vi.advanceTimersByTimeAsync(10_000);
        await drainMicrotasks(30);
      }
      const result = await pending;
      vi.useRealTimers();
      return { made, result };
    };
    try {
      const absent = await runPass(false);
      const present = await runPass(true);
      expect(present.made.raiseCalls).toEqual(absent.made.raiseCalls);
      expect(present.made.raiseCalls).toHaveLength(3);
      expect(absent.made.raiseCalls).toHaveLength(3);
      expect(present.made.raiseCalls.map((call) => call.pullRequest)).toEqual([1, 2, 3]);
      expect(present.made.speakCalls).toHaveLength(3);
      expect(present.result).toMatchObject({
        outcome: 'evaluated',
        announced: 1,
        announceFailures: 2,
        raised: 2,
      });
      expect(absent.result).toMatchObject({ outcome: 'evaluated', raised: 2 });
      const methods = portMethods(present.made.log);
      const lastRaise = methods.lastIndexOf('raiseTrainHealthAttention');
      const firstSpeak = methods.indexOf('speak');
      expect(firstSpeak).toBeGreaterThan(lastRaise);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with an alert port present vs absent, the same raise calls happen in the same order', async () => {
    const three = okState(
      healthySnapshot({ lastTickFinishedAtIso: NOW, queue: closedEntries(3) }),
    ) as never;
    const absent = makeDeps({ stateRead: three, openItems: [] });
    const present = makeDeps({ alertMode: 'on', stateRead: three, openItems: [] });
    await run(absent.deps, baseRequest());
    await run(present.deps, baseRequest());
    expect(present.raiseCalls).toEqual(absent.raiseCalls);
    expect(present.raiseCalls.map((call) => call.pullRequest)).toEqual([1, 2, 3]);

    const blindAbsent = makeDeps({ stateRead: blindStateRead() as never });
    const blindPresent = makeDeps({ alertMode: 'on', stateRead: blindStateRead() as never, openItems: [] });
    await run(blindAbsent.deps, baseRequest());
    await run(blindPresent.deps, baseRequest());
    expect(blindPresent.raiseCalls).toEqual(blindAbsent.raiseCalls);
    expect(blindRaise(blindPresent.raiseCalls[0])).toBe(true);
  });

  it('speaking happens after raising', async () => {
    const evaluated = makeDeps({
      alertMode: 'on',
      stateRead: okState(tickAndStalledSnapshot()) as never,
      openItems: [],
    });
    await run(evaluated.deps, baseRequest());
    const methods = portMethods(evaluated.log);
    const lastRaise = methods.lastIndexOf('raiseTrainHealthAttention');
    const firstSpeak = methods.indexOf('speak');
    expect(lastRaise).toBeGreaterThanOrEqual(0);
    expect(firstSpeak).toBeGreaterThan(lastRaise);
    expect(methods.filter((method) => method === 'raiseTrainHealthAttention')).toHaveLength(2);
    expect(methods.filter((method) => method === 'speak')).toHaveLength(2);
    expect(evaluated.speakCalls.map((call) => call.sentence)).toEqual([
      SENTENCE_TICK_STALE,
      SENTENCE_STALLED_HEAD,
    ]);

    const blind = makeDeps({
      alertMode: 'on',
      stateRead: blindStateRead() as never,
      openItems: [],
    });
    await run(blind.deps, baseRequest());
    expect(portMethods(blind.log)).toEqual([
      'readTrainHealthState',
      'listOpenTrainHealthAttention',
      'raiseTrainHealthAttention',
      'speak',
    ]);
  });
});
