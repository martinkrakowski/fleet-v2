// AR2b — ApplyRelaunchUseCase tests: request validation, trusted clock and
// deadline, stored-plan digest verification, journal replay derivation, the
// dry-run summary, and the AR2b live apply — one wave of `save`, `abort` and
// `redispatch` (intent-only) under the owner grant, with preflight checks
// before `authorizeRelaunchApply` so a failed preflight never consumes it.
// Hostile-input cases are HV1–HV3.
//
// Every case feeds plain values — or a Proxy, getter, hole, array-like or
// polluting key where the inspection itself is the subject — and asserts the
// exact typed result. Getters and Proxy `get` traps are counting traps: a
// refusal must never invoke one (`reads === 0`). Cost bounds are stated per
// case. Each case would fail against a constant or an identity
// implementation: the refusals differ per reason, the dry-run summaries carry
// exact per-step statuses, and the trap counters would stay at zero only for
// the descriptor-based reader.

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { canonicalSaveInputJson } from '../../../domain/relaunch-apply.js';
import type { FindRelaunchPlanResult } from '../../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import {
  canonicalRelaunchPlanBodyJson,
  type RelaunchPlanRecord,
} from '../../ports/out/RelaunchPlanRepositoryPort.out-port.js';
import type {
  CutoverJournalAppendResult,
  CutoverJournalEntry,
  CutoverJournalListResult,
} from '../../ports/out/CutoverJournalPort.out-port.js';
import type { AuthorizeRelaunchApplyResult } from '../../ports/out/ActionAuthorizationPort.out-port.js';
import type {
  AbortWorktreeRunRequest,
  AbortWorktreeRunResult,
  WorktreeRunRef,
  WorktreeRunState,
} from '../../ports/out/ExecutionRunnerPort.out-port.js';
import type { LaneRunRecord } from '../../../domain/lane-run-records.js';
import type { LaneRunJournalEntryRecord } from '../../../domain/lane-run-journal.js';
import type {
  SaveLaneEditsRequest,
  SaveLaneEditsResult,
} from '../../ports/in/SaveLaneEditsPort.in-port.js';
import type { AdoptLanePort } from '../../ports/in/AdoptLanePort.in-port.js';
import type {
  TerminateWorktreeProcessesRequest,
  TerminateWorktreeProcessesResult,
} from '../../ports/out/ProcessTreeTerminationPort.out-port.js';
import { ApplyRelaunchUseCase } from '../ApplyRelaunchUseCase.use-case.js';
import { AdoptLaneUseCase } from '../AdoptLaneUseCase.use-case.js';
import { AttemptRepositoryAdapter } from '../../../infrastructure/adapters/AttemptRepositoryAdapter.adapter.js';
import { WorkOrderRepositoryAdapter } from '../../../infrastructure/adapters/WorkOrderRepositoryAdapter.adapter.js';
import { LaneRunRepositoryAdapter } from '../../../infrastructure/adapters/LaneRunRepositoryAdapter.adapter.js';
import { LaneRunJournalAdapter } from '../../../infrastructure/adapters/LaneRunJournalAdapter.adapter.js';
import { CutoverJournalAdapter } from '../../../infrastructure/adapters/CutoverJournalAdapter.adapter.js';
import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { AttemptRepositoryPort } from '../../ports/out/AttemptRepositoryPort.out-port.js';

const NOW = '2026-11-23T10:00:00Z';
const CLOCK_NOW = '2026-11-23T09:59:00Z';
const DEADLINE = '2026-11-23T10:30:00Z';
const BEFORE_DEADLINE = '2026-11-23T09:00:00Z';
const PAST_DEADLINE = '2026-11-23T11:00:00Z';

const computeDigest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const otherDigest = (): string => hex('a different digest entirely');

type PlannedStep = { step: string; idempotencyKey: string };

interface FixtureLane {
  laneId: string;
  hostName: string;
  projectId: string | null;
  population: 'conducted' | 'unrecorded';
  runnerState: 'idle' | 'running';
  runId: string | null;
  attemptId: string | null;
  workOrderId: string | null;
  baseBranch: string;
  chainHead: boolean;
  dependsOnLaneIds: string[];
  admissionWave: number;
  dispatchEndpointKey: string | null;
  staggerOffsetMs: number | null;
  steps: PlannedStep[];
}

const step = (digest: string, laneId: string, code: string): PlannedStep => ({
  step: code,
  idempotencyKey: `relaunch/${digest}/${laneId}/${code}`,
});

const ADOPT_SUB_STEPS = ['work-order', 'brief', 'attempt', 'run'] as const;

const conductedLane = (laneId = 'lane-1'): FixtureLane => ({
  laneId,
  hostName: 'host-a',
  projectId: null,
  population: 'conducted' as const,
  runnerState: 'running' as const,
  runId: null,
  attemptId: null,
  workOrderId: null,
  baseBranch: 'main',
  chainHead: true,
  dependsOnLaneIds: [],
  admissionWave: 0,
  dispatchEndpointKey: null,
  staggerOffsetMs: null,
  steps: [],
});

/** A conducted lane with a recorded run, for the live apply's liveness check. */
const conductedLaneWithRun = (laneId = 'lane-1', runId = 'run-1'): FixtureLane => ({
  ...conductedLane(laneId),
  runId,
});

const idleLane = (digest: string, laneId = 'lane-2', dependsOnLaneIds = ['lane-1']): FixtureLane => ({
  laneId,
  hostName: 'host-b',
  projectId: 'proj-1',
  population: 'unrecorded' as const,
  runnerState: 'idle' as const,
  runId: null,
  attemptId: null,
  workOrderId: 'wo-9',
  baseBranch: 'chain/relaunch-2',
  chainHead: false,
  dependsOnLaneIds,
  admissionWave: 1,
  dispatchEndpointKey: 'opencode:host-b:4321',
  staggerOffsetMs: 0,
  steps: [
    step(digest, laneId, 'save'),
    step(digest, laneId, 'adopt'),
    step(digest, laneId, 'redispatch'),
  ],
});

const runningLane = (digest: string, laneId = 'lane-2'): FixtureLane => ({
  ...idleLane(digest, laneId),
  runnerState: 'running' as const,
  steps: [
    step(digest, laneId, 'save'),
    step(digest, laneId, 'abort'),
    step(digest, laneId, 'adopt'),
    step(digest, laneId, 'redispatch'),
  ],
});

/**
 * A valid stored plan for the given lanes. The step keys are rebuilt with the
 * final plan digest: the canonical body excludes the keys, so the digest is
 * computed once from the body and the keys are then re-keyed to it — no
 * circularity, and a refusal below can only come from the behaviour under
 * test, never from a digest accident.
 */
const buildPlan = (lanes: FixtureLane[], maxActiveRuns = 3): RelaunchPlanRecord => {
  const placeholder = '0'.repeat(64);
  const keyed = lanes.map((lane) => ({
    ...lane,
    steps: lane.steps.map((s) => ({
      step: s.step,
      idempotencyKey: `relaunch/${placeholder}/${lane.laneId}/${s.step}`,
    })),
  }));
  const body = {
    schemaVersion: 1 as const,
    hostFilter: null,
    maxActiveRuns,
    dispatchStaggerMs: 250,
    conductor: { halted: true, driverLease: 'lapsed' as const, runCount: 2 },
    lanes: keyed,
  };
  const planDigest = computeDigest(
    canonicalRelaunchPlanBodyJson(body as unknown as Parameters<typeof canonicalRelaunchPlanBodyJson>[0]),
  );
  const record = {
    ...body,
    planDigest,
    requestDigest: 'a'.repeat(64),
    createdAtIso: BEFORE_DEADLINE,
    lanes: keyed.map((lane) => ({
      ...lane,
      steps: lane.steps.map((s) => ({
        step: s.step,
        idempotencyKey: `relaunch/${planDigest}/${lane.laneId}/${s.step}`,
      })),
    })),
  };
  return record as unknown as RelaunchPlanRecord;
};

/**
 * The default plan: one conducted lane and one idle lane behind it, digested
 * over its own canonical body.
 */
const defaultPlan = (): RelaunchPlanRecord =>
  buildPlan([conductedLane(), idleLane(hex('default relaunch plan'))]);

const intent = (key: string, digest: string | null = null) => ({
  key,
  kind: 'intent',
  entryId: 'entry-1',
  recordedAtIso: BEFORE_DEADLINE,
  outcome: undefined,
  digest,
});

const result = (key: string, outcome: string, digest: string | null = null) => ({
  key,
  kind: 'result',
  entryId: 'entry-2',
  recordedAtIso: CLOCK_NOW,
  outcome,
  digest,
});

const saveInput = (over: Record<string, unknown> = {}) => ({
  laneId: 'lane-2',
  attemptId: 'attempt-1',
  worktreePath: '/wt/lane-2',
  clonePath: '/clone/lane-2',
  recordedHost: null,
  baseCommit: 'b'.repeat(64),
  allowedPathPrefixes: ['src/'],
  ...over,
});

/** The digest a matching save intent would carry for `input`. */
const saveInputDigest = (planDigest: string, input: Record<string, unknown>): string => {
  const canonical = canonicalSaveInputJson(planDigest, input);
  if (canonical === null) throw new Error('fixture save input must canonicalize');
  return computeDigest(canonical);
};

/**
 * The digest `adoptInputIdentity` computes for a resent adopt input: the
 * journaled `adopt/work-order` completed result must carry exactly this, or
 * the preflight refuses the lane (AR3c1).
 */
const adoptIdentityDigest = (laneId: string, input: Record<string, unknown>): string => {
  const part = (holder: unknown, field: string): unknown =>
    holder !== null && typeof holder === 'object' ? (holder as Record<string, unknown>)[field] : undefined;
  return computeDigest(
    JSON.stringify([
      'adopt-lane-ids/1',
      input['projectId'],
      part(input['planRef'], 'planId'),
      laneId,
      part(input['workOrder'], 'workOrderId'),
      part(input['brief'], 'briefId'),
      part(input['attempt'], 'attemptId'),
      part(input['run'], 'runId'),
    ]),
  );
};

/** A valid adopt input for the held lane; every cross-check matches the fixtures. */
const adoptInput = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const base = {
    laneId: 'lane-2',
    projectId: 'proj-1',
    baseBranch: 'chain/relaunch-2',
    workOrder: {
      workOrderId: 'wo-9',
      taskId: 'task-1',
      repository: 'repo-1',
      baseCommit: 'b'.repeat(64),
      ownedPaths: ['src/a.ts'],
      policyRevision: 'policy-1',
    },
    brief: {
      briefId: 'brief-1',
      briefText: 'do the thing',
      // The real digest of `briefText`: the preflight verifies it before any side effect.
      expectedBriefDigest: hex('do the thing'),
      prosePath: 'brief/prose.md',
      manifestPath: 'brief/manifest.json',
      reviewerModel: 'reviewer-1',
      acceptanceSpec: { commitRequired: true, diffCheck: true, commands: [{ argv: ['yarn', 'test'] }] },
    },
    attempt: { attemptId: 'attempt-1', endedAtIso: CLOCK_NOW, sessionId: null },
    run: {
      runId: `run-7${'A'.repeat(25)}`,
      tier: 2,
      seatPlanRef: 'e'.repeat(64),
      runPolicyRevision: 'policy-1',
      branchName: `fleet/run-7${'A'.repeat(25)}`,
    },
    source: { kind: 'save-ref', saveRef: 'refs/fleet/saved/lane-2', commitOid: 'c'.repeat(64), treeDigest: 'd'.repeat(64) },
    ...over,
  };
  // The planRef mirrors the (possibly overridden) lane and project ids, as
  // the port's own grammar requires planRef.laneId and planRef.projectId to
  // match the request's.
  const laneId = typeof base['laneId'] === 'string' ? base['laneId'] : 'lane-2';
  const projectId = typeof base['projectId'] === 'string' ? base['projectId'] : 'proj-1';
  return { ...base, planRef: { projectId, planId: 'plan-1', laneId } };
};

/** An own accessor on `key` that counts its invocations and never fires. */
const getterOn = (target: object, key: string, calls: { count: number }): object => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      calls.count += 1;
      return descriptor ? descriptor.value : undefined;
    },
  });
  return target;
};

/** The full `adopted` result for the lane-4 adopt input, matching its ids (fix-round item 2 hardening). */
const lane4Adopted = (): Record<string, unknown> => ({
  outcome: 'adopted',
  reused: false,
  workOrderId: 'wo-9',
  briefDigest: hex('do the thing'),
  attemptId: 'attempt-4',
  runId: `run-7${'C'.repeat(25)}`,
  commitOid: 'c'.repeat(64),
  enteredState: 'collecting',
  provenance: 'adopted',
});

interface Deps {
  planRepo: { findByDigest: (planDigest: string) => Promise<FindRelaunchPlanResult> };
  cutoverJournal: {
    listByKeyPrefix: (prefix: string) => Promise<CutoverJournalListResult>;
    append?: (entry: CutoverJournalEntry) => Promise<CutoverJournalAppendResult>;
  };
  computeDigest: (text: string) => string;
  authorization?: { authorizeRelaunchApply: (request: unknown) => Promise<AuthorizeRelaunchApplyResult> };
  clock: () => string;
  runRepo?: { get: (runId: string) => Promise<LaneRunRecord | null>; list: () => Promise<readonly LaneRunRecord[]> };
  runJournal?: {
    listForRun: (runId: string) => Promise<readonly LaneRunJournalEntryRecord[]>;
    listForRuns?: (runIds: readonly string[]) => Promise<ReadonlyMap<string, readonly LaneRunJournalEntryRecord[]>>;
  };
  runner?: {
    inspectWorktreeRun: (ref: WorktreeRunRef) => Promise<WorktreeRunState>;
    abortWorktreeRun: (request: AbortWorktreeRunRequest) => Promise<AbortWorktreeRunResult>;
  };
  processTreeTermination?: {
    terminateWorktreeProcesses: (
      request: TerminateWorktreeProcessesRequest,
    ) => Promise<TerminateWorktreeProcessesResult>;
  };
  saveLaneEdits?: (request: SaveLaneEditsRequest) => Promise<SaveLaneEditsResult>;
  adoptLane?: Pick<AdoptLanePort, 'adoptLane'>['adoptLane'];
  mintEntryId?: () => string;
  /** The entries appended through the journal spy, in append order. */
  appended?: Record<string, unknown>[];
}

/** Overrides for the live apply's ports; each `no*` drops a port entirely. */
interface LiveOver {
  noRunRepo?: boolean;
  noRunJournal?: boolean;
  noRunner?: boolean;
  noTerminate?: boolean;
  noSave?: boolean;
  noMint?: boolean;
  noAppend?: boolean;
  noAdoptLane?: boolean;
  noAuthorization?: boolean;
  run?: unknown;
  runThrows?: boolean;
  /** The `runRepo.list()` answer; the default is an empty list. */
  runs?: unknown;
  runListThrows?: boolean;
  /** A per-run journal answer for `listForRun`/`listForRuns`; the default is empty. */
  runJournalFor?: (runId: string) => unknown;
  runJournalThrows?: boolean;
  /** Replaces the whole `listForRuns` answer (for hostile-map cases). */
  runJournalResult?: unknown;
  inspect?: unknown;
  /** Per-attempt inspect results, taking precedence over `inspect`. */
  inspectByAttempt?: Record<string, unknown>;
  inspectThrows?: boolean;
  abort?: unknown;
  abortThrows?: boolean;
  terminate?: unknown;
  terminateThrows?: boolean;
  save?: unknown;
  saveThrows?: boolean;
  /** The adoptLane result (AR2c); the default refuses, as any malformed port answer does. */
  adopt?: unknown;
  adoptThrows?: boolean;
  authorize?: unknown;
  authorizeThrows?: boolean;
  /** Per-append results, consumed in order; the default is `appended`. */
  appendResults?: unknown[];
  appendThrows?: boolean;
}

/** An `adoptLane` answer whose `outcome` is read through its own descriptor (never a getter). */
const plainOutcome = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'outcome');
    return descriptor !== undefined && descriptor.get === undefined ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The default environment: the valid default plan under its own digest, a
 * live (stateful) journal, a fixed trusted clock before the deadline, an
 * `authorizeRelaunchApply` spy that echoes the request's `grantId`, and a
 * full set of healthy live ports. The `live` overrides replace each port's
 * result or drop it entirely.
 */
const makeDeps = (over: {
  plan?: RelaunchPlanRecord;
  findResult?: unknown;
  findByDigestThrows?: boolean;
  entries?: unknown[];
  journalThrows?: boolean;
  journalResult?: unknown;
  clock?: () => string;
  computeDigest?: (text: string) => string;
  live?: LiveOver;
} = {}): Deps => {
  const plan = over.plan ?? defaultPlan();
  const live = over.live ?? {};
  // The journal is stateful: `append` adds to the store that `listByKeyPrefix`
  // reads, so a replay call sees what the previous call wrote.
  const store: Record<string, unknown>[] = [...((over.entries ?? []) as Record<string, unknown>[])];
  const appended: Record<string, unknown>[] = [];
  let entryCounter = 0;
  const append = vi.fn(async (entry: Record<string, unknown>) => {
    if (live.appendThrows) throw new Error('journal write down');
    const record = { ...entry, entryId: `entry-${(entryCounter += 1)}` };
    const result =
      live.appendResults !== undefined && live.appendResults.length > 0
        ? live.appendResults.shift()
        : { outcome: 'appended', entry: record };
    // A refused append writes nothing (the adapter's own guarantee).
    if ((result as { outcome?: string } | null)?.outcome === 'appended') {
      appended.push(record);
      store.push(record);
    }
    return result;
  });
  const deps: Record<string, unknown> = {
    planRepo: {
      findByDigest: vi.fn(async (_planDigest: string) => {
        if (over.findByDigestThrows) throw new Error('store down');
        return (
          over.findResult !== undefined ? over.findResult : { outcome: 'found', plan }
        ) as unknown as FindRelaunchPlanResult;
      }),
    },
    cutoverJournal: {
      listByKeyPrefix: vi.fn(async (_prefix: string) => {
        if (over.journalThrows) throw new Error('journal down');
        return (
          over.journalResult ?? { outcome: 'listed', entries: store }
        ) as unknown as CutoverJournalListResult;
      }),
      append: live.noAppend ? undefined : append,
    },
    computeDigest: over.computeDigest ?? computeDigest,
    authorization: live.noAuthorization
      ? undefined
      : {
          authorizeRelaunchApply: vi.fn(async (request: unknown) => {
            if (live.authorizeThrows) throw new Error('authorization down');
            if (live.authorize !== undefined) return live.authorize;
            const grantId = (request as { grantId?: string } | null)?.grantId;
            return { outcome: 'authorized', grantId } as AuthorizeRelaunchApplyResult;
          }),
        },
    clock: over.clock ?? (() => CLOCK_NOW),
    runRepo: live.noRunRepo
      ? undefined
      : {
          get: vi.fn(async (_runId: string) => {
            if (live.runThrows) throw new Error('run store down');
            return live.run !== undefined ? live.run : { runId: 'run-1', state: 'running' };
          }),
          list: vi.fn(async () => {
            if (live.runListThrows) throw new Error('run list down');
            return (live.runs === undefined ? [] : live.runs) as readonly LaneRunRecord[];
          }),
        },
    runJournal: live.noRunJournal
      ? undefined
      : {
          listForRun: vi.fn(async (runId: string) => {
            if (live.runJournalThrows) throw new Error('run journal down');
            return live.runJournalFor?.(runId) ?? [];
          }),
          listForRuns: vi.fn(async (ids: readonly string[]) => {
            if (live.runJournalThrows) throw new Error('run journal down');
            if (live.runJournalResult !== undefined) return live.runJournalResult as ReadonlyMap<string, readonly unknown[]>;
            return new Map(ids.map((id) => [id, live.runJournalFor?.(id) ?? []]));
          }),
        },
    runner: live.noRunner
      ? undefined
      : {
          inspectWorktreeRun: vi.fn(async (ref: unknown) => {
            if (live.inspectThrows) throw new Error('runner down');
            if (live.inspectByAttempt !== undefined) {
              const attemptId = (ref as { attemptId?: string } | null)?.attemptId;
              const per = live.inspectByAttempt[attemptId ?? ''];
              if (per !== undefined) return per;
            }
            return live.inspect !== undefined ? live.inspect : { state: 'idle' };
          }),
          abortWorktreeRun: vi.fn(async (_request: unknown) => {
            if (live.abortThrows) throw new Error('abort down');
            return live.abort !== undefined ? live.abort : { outcome: 'aborted', endedAtIso: CLOCK_NOW };
          }),
        },
    processTreeTermination: live.noTerminate
      ? undefined
      : {
          terminateWorktreeProcesses: vi.fn(async (_request: unknown) => {
            if (live.terminateThrows) throw new Error('termination down');
            return live.terminate !== undefined ? live.terminate : { outcome: 'terminated', killed: 2 };
          }),
        },
    saveLaneEdits: live.noSave
      ? undefined
      : vi.fn(async (_request: unknown) => {
          if (live.saveThrows) throw new Error('save down');
          return live.save !== undefined ? live.save : { outcome: 'saved' };
        }),
    // AR2c: the default adoptLane refuses (like any malformed port answer),
    // so a lane whose adopt runs stops with `adopt-failed`; adopt tests
    // override `live.adopt` with the outcome they need. An `adopted` outcome
    // journals the four adopt sub-steps, as the real AdoptLaneUseCase does,
    // so the wave's re-derivation sees the adopt completed.
    adoptLane: (live.noAdoptLane
      ? undefined
      : vi.fn(async (request: unknown) => {
          if (live.adoptThrows) throw new Error('adopt down');
          const answer = live.adopt !== undefined ? live.adopt : { outcome: 'refused', reason: 'invalid-request' };
          if (
            plainOutcome(answer) === 'adopted' &&
            typeof (request as { planDigest?: unknown } | null)?.planDigest === 'string' &&
            typeof (request as { laneId?: unknown } | null)?.laneId === 'string'
          ) {
            const planDigest = (request as { planDigest: string }).planDigest;
            const laneId = (request as { laneId: string }).laneId;
            for (const sub of ADOPT_SUB_STEPS) {
              const subKey = `relaunch/${planDigest}/${laneId}/adopt/${sub}`;
              await append({ key: subKey, kind: 'intent' });
              // AR3c1: the completed work-order result carries the resent
              // input's identity digest, as the real AdoptLaneUseCase does.
              await append({
                key: subKey,
                kind: 'result',
                outcome: 'completed',
                ...(sub === 'work-order' ? { digest: adoptIdentityDigest(laneId, request as Record<string, unknown>) } : {}),
              });
            }
          }
          return answer;
        })) as unknown as Deps['adoptLane'],
    mintEntryId: live.noMint ? undefined : vi.fn(() => `minted-${(entryCounter += 1)}`),
  };
  deps['appended'] = appended;
  return deps as unknown as Deps;
};

const dryRunRequest = (planDigest: string, over: Record<string, unknown> = {}): unknown => ({
  planDigest,
  nowIso: NOW,
  ...over,
});

const applyRequest = (planDigest: string, over: Record<string, unknown> = {}): unknown => ({
  planDigest,
  nowIso: NOW,
  apply: true,
  grantId: 'grant-1',
  saveInputs: [saveInput()],
  adoptInputs: [adoptInput()],
  ...over,
});

/** An own `__proto__` key (a literal would set the prototype instead). */
const withPollutingKey = (key: string, value: unknown): Record<string, unknown> =>
  JSON.parse(`{"${key}": ${JSON.stringify(value)}, "ok": true}`) as Record<string, unknown>;

describe('ApplyRelaunchUseCase (AR2a2)', () => {
  it('U1: refuses malformed requests — null, undefined, primitives, arrays, array-likes, bad fields, sparse saveInputs, over-cap length (O(1) pre-gate, zero reads), duplicate lane ids, null or empty attemptId, and polluting keys, leaving Object.prototype untouched', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    const digest = plan.planDigest;
    const validInput = saveInput();
    const refused = async (request: unknown): Promise<void> => {
      expect(await useCase.applyRelaunch(request)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    };
    await refused(null);
    await refused(undefined);
    await refused(7);
    await refused(true);
    await refused('x');
    await refused([dryRunRequest(digest)]);
    // An array-like is not an array: refused without reading any element.
    await refused({ length: 1, 0: dryRunRequest(digest) });
    await refused({ planDigest: 7, nowIso: NOW });
    await refused({ planDigest: digest, nowIso: NOW, apply: 'yes' });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: {} });
    // A sparse saveInputs array is refused: a hole is not a lane input.
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: new Array(2) });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: [saveInput(), saveInput()] });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: [saveInput({ attemptId: null })] });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: [saveInput({ attemptId: '' })] });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: [{ laneId: 'lane-2' }] });
    // A Proxy array with length 513 (> MAX_RELAUNCH_APPLY_LANES = 512) is
    // refused in the O(1) length pre-gate before any key enumeration: the
    // Proxy `get` trap is never invoked (reads === 0).
    const reads = { count: 0 };
    const longProxy = new Proxy(new Array(513), {
      get(target, property, receiver) {
        reads.count += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    await refused({ planDigest: digest, nowIso: NOW, saveInputs: longProxy });
    expect(reads.count).toBe(0);
    // Prototype-polluting keys in saveInputs are refused as own data keys and
    // leave Object.prototype untouched.
    const pristine = { untouched: true };
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const polluted = withPollutingKey(key, validInput);
      await refused({ planDigest: digest, nowIso: NOW, saveInputs: [polluted] });
      expect((pristine as Record<string, unknown>)['untouched']).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'untouched')).toBe(false);
    }
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
    // AR2b carry-over: a bad save-input field type or lane-id grammar refuses
    // up front, even though no `save` intent exists to consume it.
    const badField = async (over: Record<string, unknown>): Promise<void> => {
      await refused({ planDigest: plan.planDigest, nowIso: NOW, saveInputs: [saveInput(over)] });
    };
    await badField({ laneId: 'bad/id' });
    await badField({ laneId: '' });
    await badField({ worktreePath: 7 });
    await badField({ clonePath: null });
    await badField({ baseCommit: [] });
    await badField({ allowedPathPrefixes: ['ok', 7] });
    await badField({ allowedPathPrefixes: new Array(3) }); // sparse
    await badField({ policyProtectedPaths: 'src/' });
    await badField({ recordedHost: ['not', 'an', 'object'] });
    await badField({ worktreePath: 'x'.repeat(4097) }); // over-cap length
  });

  it('U2: never invokes a counting or throwing getter or a Proxy get trap on the request or saveInputs (reads === 0)', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    // A counting getter on planDigest is never read: the descriptor check
    // sees the accessor and refuses in O(1).
    const calls = { count: 0 };
    const request = getterOn({ planDigest: plan.planDigest, nowIso: NOW }, 'planDigest', calls);
    expect(await useCase.applyRelaunch(request)).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(calls.count).toBe(0);
    // A throwing getter on a save input is never run either.
    const throwing = { count: 0 };
    const element = getterOn(saveInput(), 'laneId', throwing);
    Object.defineProperty(element, 'laneId', {
      enumerable: true,
      configurable: true,
      get(): string {
        throwing.count += 1;
        throw new Error('getter must never run');
      },
    });
    expect(
      await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: NOW, saveInputs: [element] }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(throwing.count).toBe(0);
    // A Proxy over a one-element saveInputs array whose element is invalid:
    // the elements are read through property descriptors, so the `get` trap
    // stays at zero even though the request is refused.
    const reads = { count: 0 };
    const proxy = new Proxy([{ laneId: 'lane-2' }], {
      get(target, property, receiver) {
        reads.count += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: NOW, saveInputs: proxy }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    expect(reads.count).toBe(0);
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
  });

  it('U3: refuses secret-shaped strings anywhere in the request as secret-detected', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    const legacySecret = `sk-${'a'.repeat(20)}`;
    const canonicalSecret = `AIza${'a'.repeat(30)}`; // canonical-registry only
    for (const secret of [legacySecret, canonicalSecret]) {
      expect(
        await useCase.applyRelaunch({
          planDigest: plan.planDigest,
          nowIso: NOW,
          apply: true,
          grantId: secret,
        }),
      ).toEqual({ outcome: 'refused', reason: 'secret-detected' });
      expect(
        await useCase.applyRelaunch({
          planDigest: plan.planDigest,
          nowIso: NOW,
          saveInputs: [saveInput({ worktreePath: secret })],
        }),
      ).toEqual({ outcome: 'refused', reason: 'secret-detected' });
      expect(
        await useCase.applyRelaunch({
          planDigest: plan.planDigest,
          nowIso: NOW,
          saveInputs: [saveInput({ allowedPathPrefixes: [secret] })],
        }),
      ).toEqual({ outcome: 'refused', reason: 'secret-detected' });
    }
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
  });

  it('U4: refuses a non-zoned nowIso or deadlineIso as invalid-clock', async () => {
    const plan = defaultPlan();
    const useCase = new ApplyRelaunchUseCase(makeDeps({ plan }));
    expect(await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: '2026-11-23T10:00:00' })).toEqual({
      outcome: 'refused',
      reason: 'invalid-clock',
    });
    expect(
      await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: NOW, deadlineIso: 'yesterday' }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-clock' });
    expect(
      await useCase.applyRelaunch({ planDigest: plan.planDigest, nowIso: NOW, deadlineIso: 42 }),
    ).toEqual({ outcome: 'refused', reason: 'invalid-clock' });
  });

  it('U5: refuses budget exhaustion — clock at or past the deadline, a throwing clock, a non-string or invalid clock reading — checked before any outbound call and never from request.nowIso', async () => {
    const plan = defaultPlan();
    const exhausted = { outcome: 'refused', reason: 'budget-exhausted' };
    // Clock exactly at the deadline is exhausted (>=).
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, clock: () => DEADLINE })).applyRelaunch(
        dryRunRequest(plan.planDigest, { deadlineIso: DEADLINE }),
      ),
    ).toEqual(exhausted);
    // The clock is the trusted source: request.nowIso is before the deadline,
    // yet the trusted clock is past it, so the refusal comes from the clock.
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, clock: () => PAST_DEADLINE })).applyRelaunch(
        dryRunRequest(plan.planDigest, { deadlineIso: DEADLINE }),
      ),
    ).toEqual(exhausted);
    // A throwing clock is exhausted.
    expect(
      await new ApplyRelaunchUseCase(
        makeDeps({
          plan,
          clock: () => {
            throw new Error('clock down');
          },
        }),
      ).applyRelaunch(dryRunRequest(plan.planDigest)),
    ).toEqual(exhausted);
    // A non-string or non-ISO clock reading is exhausted.
    const badClockDeps = makeDeps({ plan });
    badClockDeps.clock = () => undefined as unknown as string;
    expect(await new ApplyRelaunchUseCase(badClockDeps).applyRelaunch(dryRunRequest(plan.planDigest))).toEqual(exhausted);
    const invalidClockDeps = makeDeps({ plan });
    invalidClockDeps.clock = () => 'not-an-instant';
    expect(await new ApplyRelaunchUseCase(invalidClockDeps).applyRelaunch(dryRunRequest(plan.planDigest))).toEqual(exhausted);
    // Checked before any outbound call: the store and journal are untouched.
    const spyDeps = makeDeps({ plan, clock: () => PAST_DEADLINE });
    const spyRequest = dryRunRequest(plan.planDigest, { deadlineIso: DEADLINE });
    expect(await new ApplyRelaunchUseCase(spyDeps).applyRelaunch(spyRequest)).toEqual(exhausted);
    expect(spyDeps.planRepo.findByDigest).not.toHaveBeenCalled();
    expect(spyDeps.cutoverJournal.listByKeyPrefix).not.toHaveBeenCalled();
  });

  it('U6: refuses a non-64-hex planDigest and a store-refused digest as invalid-plan-digest', async () => {
    const useCase = new ApplyRelaunchUseCase(makeDeps());
    expect(await useCase.applyRelaunch(dryRunRequest('nothex'))).toEqual({
      outcome: 'refused',
      reason: 'invalid-plan-digest',
    });
    expect(await useCase.applyRelaunch(dryRunRequest('A'.repeat(64)))).toEqual({
      outcome: 'refused',
      reason: 'invalid-plan-digest',
    });
    const deps = makeDeps({ findResult: { outcome: 'refused', reason: 'invalid-digest' } });
    const digest = defaultPlan().planDigest;
    expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(dryRunRequest(digest))).toEqual({
      outcome: 'refused',
      reason: 'invalid-plan-digest',
    });
    expect(deps.planRepo.findByDigest).toHaveBeenCalledWith(digest);
  });

  it('U7: refuses a known-absent plan as plan-not-found', async () => {
    const digest = defaultPlan().planDigest;
    const deps = makeDeps({ findResult: { outcome: 'absent' } });
    expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(dryRunRequest(digest))).toEqual({
      outcome: 'refused',
      reason: 'plan-not-found',
    });
    expect(deps.planRepo.findByDigest).toHaveBeenCalledWith(digest);
  });

  it('U8: refuses an unreadable store, an unknown plan version, a malformed store result, and a throwing store or computeDigest as plan-unreadable or plan-unknown-version', async () => {
    const digest = defaultPlan().planDigest;
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findByDigestThrows: true })).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: { outcome: 'unreadable', reason: 'unreadable' } })).applyRelaunch(
        dryRunRequest(digest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: { outcome: 'unreadable', reason: 'unknown-version' } })).applyRelaunch(
        dryRunRequest(digest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'plan-unknown-version' });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: {} })).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: null })).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    // A throwing computeDigest on the canonical body is plan-unreadable.
    expect(
      await new ApplyRelaunchUseCase(
        makeDeps({ computeDigest: () => {
          throw new Error('hash down');
        } }),
      ).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
  });

  it('U9: refuses a malformed stored plan — bad schemaVersion, bad createdAtIso, out-of-order steps, bad idempotencyKey, a getter, a Proxy or a hole in plan.lanes — without invoking any getter', async () => {
    const base = defaultPlan();
    const digest = base.planDigest;
    const refusedInvalid = async (plan: unknown, calls?: { count: number }): Promise<void> => {
      const deps = makeDeps({ findResult: { outcome: 'found', plan } });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(dryRunRequest(digest))).toEqual({
        outcome: 'refused',
        reason: 'invalid-plan',
      });
      if (calls) expect(calls.count).toBe(0);
    };
    const plan = defaultPlan() as unknown as Record<string, unknown>;
    await refusedInvalid({ ...plan, schemaVersion: 2 });
    await refusedInvalid({ ...plan, createdAtIso: 'not-an-instant' });
    // Out-of-order steps: adopt before save.
    const lanes = (plan['lanes'] as Record<string, unknown>[]).map((lane) => ({ ...lane }));
    const outOfOrder = { ...plan, lanes: [...lanes] };
    outOfOrder['lanes'][1] = {
      ...lanes[1],
      steps: [step(digest, 'lane-2', 'adopt'), step(digest, 'lane-2', 'save'), step(digest, 'lane-2', 'redispatch')],
    };
    await refusedInvalid(outOfOrder);
    // A bad idempotency key no longer names the plan, lane and step.
    const badKey = { ...plan, lanes: [...lanes] };
    badKey['lanes'][1] = {
      ...lanes[1],
      steps: [{ step: 'save', idempotencyKey: `relaunch/${otherDigest()}/lane-2/save` }, ...lanes[1] && (lanes[1] as { steps: unknown[] }).steps.slice(1)],
    };
    await refusedInvalid(badKey);
    // A counting getter on plan.lanes is never invoked (the validator reads
    // own descriptors only; preflight bound MAX_PREFLIGHT_NODES = 100_000,
    // MAX_PREFLIGHT_DEPTH = 32, lanes cap 512).
    const getterCalls = { count: 0 };
    const getterPlan = getterOn({ ...plan }, 'lanes', getterCalls);
    await refusedInvalid(getterPlan, getterCalls);
    // A Proxy over the lanes array lies in no trap that is consulted: the
    // refusal comes from the reflection answers alone.
    const proxyPlan = {
      ...plan,
      lanes: new Proxy([], {
        get(target, property, receiver) {
          return Reflect.get(target, property, receiver);
        },
      }),
    };
    await refusedInvalid(proxyPlan);
    // A hole in plan.lanes is refused.
    const holed = { ...plan, lanes: new Array(2) };
    (holed['lanes'] as unknown[])[0] = lanes[0];
    await refusedInvalid(holed);
  });

  it('U10: refuses when the recomputed canonical digest does not match the stored or the requested digest', async () => {
    const plan = defaultPlan();
    // The store answers a different digest with the same plan: the requested
    // digest does not match the plan's own canonical digest.
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan })).applyRelaunch(dryRunRequest(otherDigest())),
    ).toEqual({ outcome: 'refused', reason: 'plan-digest-mismatch' });
    // A computeDigest that disagrees with the stored digest is a mismatch too.
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, computeDigest: () => 'f'.repeat(64) })).applyRelaunch(
        dryRunRequest(plan.planDigest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'plan-digest-mismatch' });
  });

  it('U11: refuses an unreadable journal — a throw, an unreadable outcome, a non-array, a hole, a missing or non-string key or kind, a bad outcome or digest — and never invokes a counting getter on an entry (reads === 0, bound 10_000 entries)', async () => {
    const plan = defaultPlan();
    const digest = plan.planDigest;
    const refusedJournal = async (over: Parameters<typeof makeDeps>[0]): Promise<void> => {
      expect(await new ApplyRelaunchUseCase(makeDeps(over)).applyRelaunch(dryRunRequest(digest))).toEqual({
        outcome: 'refused',
        reason: 'journal-unreadable',
      });
    };
    await refusedJournal({ plan, journalThrows: true });
    await refusedJournal({ plan, journalResult: { outcome: 'unreadable' } });
    await refusedJournal({ plan, journalResult: { outcome: 'listed', entries: 'nope' } });
    // A hole in the entries array is unreadable.
    const holed = new Array(2);
    holed[0] = intent(`relaunch/${digest}/lane-2/save`);
    await refusedJournal({ plan, journalResult: { outcome: 'listed', entries: holed } });
    // An entry without a string kind, and one with a non-string outcome.
    await refusedJournal({
      plan,
      entries: [{ key: `relaunch/${digest}/lane-2/save`, digest: null }],
    });
    await refusedJournal({
      plan,
      entries: [{ key: `relaunch/${digest}/lane-2/save`, kind: 'intent', outcome: 7, digest: null }],
    });
    // A counting getter on an entry's key is never invoked (cost bound: the
    // entry scan is bounded by MAX_RELAUNCH_APPLY_ENTRIES = 10_000).
    const calls = { count: 0 };
    const entry = getterOn({ key: `relaunch/${digest}/lane-2/save`, kind: 'intent', digest: null }, 'key', calls);
    await refusedJournal({ plan, entries: [entry, { key: `relaunch/${digest}/lane-2/save`, kind: 'result', outcome: 7 }] });
    expect(calls.count).toBe(0);
    // A getter on digest is refused the same way.
    const digestCalls = { count: 0 };
    const digestGetter = getterOn(
      { key: `relaunch/${digest}/lane-2/save`, kind: 'intent', digest: 'x'.repeat(64) },
      'digest',
      digestCalls,
    );
    await refusedJournal({ plan, entries: [digestGetter] });
    expect(digestCalls.count).toBe(0);
  });

  it('U12: refuses a save-input digest mismatch — different save inputs on re-apply, an un-digested save intent, and lane ids that are prototype-polluting or dot names — keyed in a Map without pollution or collision', async () => {
    const recordedInput = saveInput();
    const buildWithIntent = (laneId: string, input: Record<string, unknown>, recordedDigest: string | null) => {
      const plan = buildPlan([conductedLane(), idleLane(hex(`plan ${laneId}`), laneId)]);
      const digest = plan.planDigest;
      const saveKey = `relaunch/${digest}/${laneId}/save`;
      return {
        plan,
        digest,
        entries: [intent(saveKey, recordedDigest === null ? null : recordedDigest)],
        recordedDigest: recordedDigest === null ? null : recordedDigest,
        saveKey,
        currentDigest: saveInputDigest(digest, { ...input, laneId }),
      };
    };
    // Different save inputs on re-apply: the recorded digest no longer matches.
    const mismatch = buildWithIntent('lane-2', recordedInput, null);
    mismatch.recordedDigest = saveInputDigest(mismatch.digest, { ...recordedInput, baseCommit: 'c'.repeat(64) });
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: mismatch.plan, entries: [intent(mismatch.saveKey, mismatch.recordedDigest)] })).applyRelaunch(
        dryRunRequest(mismatch.digest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'save-input-digest-mismatch', laneId: 'lane-2' });
    // An un-digested save intent (digest null) is refused, never accepted.
    const undigested = buildWithIntent('lane-2', recordedInput, null);
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: undigested.plan, entries: [intent(undigested.saveKey, null)] })).applyRelaunch(
        dryRunRequest(undigested.digest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'save-input-digest-mismatch', laneId: 'lane-2' });
    // The polluting and dot lane ids are valid lane ids: the Map keys them
    // without touching Object.prototype, and a matching digest replays fine
    // while a changed input is refused with the same laneId echoed back.
    const pristine = { untouched: true };
    for (const laneId of ['__proto__', '.', '..']) {
      const fixture = buildWithIntent(laneId, recordedInput, null);
      const deps = makeDeps({
        plan: fixture.plan,
        entries: [intent(fixture.saveKey, fixture.currentDigest)],
      });
      const useCase = new ApplyRelaunchUseCase(deps);
      expect(
        await useCase.applyRelaunch(dryRunRequest(fixture.digest, { saveInputs: [{ ...recordedInput, laneId }] })),
      ).not.toEqual({ outcome: 'refused', reason: 'save-input-digest-mismatch' });
      expect((pristine as Record<string, unknown>)['untouched']).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'untouched')).toBe(false);
      expect(
        await useCase.applyRelaunch(dryRunRequest(fixture.digest, { saveInputs: [{ ...recordedInput, laneId, baseCommit: 'd'.repeat(64) }] })),
      ).toEqual({ outcome: 'refused', reason: 'save-input-digest-mismatch', laneId });
    }
  });

  it('U13: refuses out-of-order journal steps and inconsistent step states with the offending laneId', async () => {
    // Out of order: the plan's first step (save) is untouched while a later
    // step (adopt) has already begun.
    const plan = defaultPlan();
    const digest = plan.planDigest;
    const adoptKey = `relaunch/${digest}/lane-2/adopt/work-order`;
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, entries: [intent(adoptKey)] })).applyRelaunch(dryRunRequest(digest)),
    ).toEqual({ outcome: 'refused', reason: 'out-of-order', laneId: 'lane-2' });
    // Inconsistent: two intents for the same step key violate the ledger
    // grammar.
    const saveKey = `relaunch/${digest}/lane-2/save`;
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, entries: [intent(saveKey), intent(saveKey)] })).applyRelaunch(
        dryRunRequest(digest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'step-inconsistent', laneId: 'lane-2' });
    // A partial adopt (dangling sub-step intent) followed by a begun
    // redispatch is out of order, not a resume.
    const running = buildPlan([conductedLane(), runningLane(hex('running plan'))]);
    const runningDigest = running.planDigest;
    const entries = [
      intent(`relaunch/${runningDigest}/lane-2/save`),
      result(`relaunch/${runningDigest}/lane-2/save`, 'completed'),
      intent(`relaunch/${runningDigest}/lane-2/abort`),
      result(`relaunch/${runningDigest}/lane-2/abort`, 'completed'),
      intent(`relaunch/${runningDigest}/lane-2/adopt/work-order`),
      intent(`relaunch/${runningDigest}/lane-2/redispatch`),
    ];
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: running, entries })).applyRelaunch(dryRunRequest(runningDigest)),
    ).toEqual({ outcome: 'refused', reason: 'out-of-order', laneId: 'lane-2' });
  });

  it('U14: refuses an apply with a missing, null or blank grantId as grant-missing and never calls authorizeRelaunchApply', async () => {
    const plan = defaultPlan();
    const digest = plan.planDigest;
    for (const grantId of [undefined, null, '   ']) {
      const deps = makeDeps({ plan });
      const request = applyRequest(digest);
      if (grantId === undefined) {
        delete (request as Record<string, unknown>)['grantId'];
      } else {
        (request as Record<string, unknown>)['grantId'] = grantId;
      }
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request)).toEqual({
        outcome: 'refused',
        reason: 'grant-missing',
      });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    }
  });

  it('U15: refuses an over-long grantId as invalid-request before the secret scan, and stops a live lane whose adopt is refused with adopt-failed (AR2c)', async () => {
    // Over-long grantId: 4097 characters, secret-shaped, so the length cap
    // (O(1)) must refuse before `hasSecretShape` (O(length)) ever runs.
    const longGrant = `sk-${'a'.repeat(4097)}`;
    const plan = defaultPlan();
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan })).applyRelaunch(
        applyRequest(plan.planDigest, { grantId: longGrant }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
    // A live wave saves and then stops at adopt: the default adoptLane
    // refuses, so the lane refuses adopt-failed.
    const liveP = buildPlan([conductedLaneWithRun(), idleLane(hex('adopt-gate plan'))]);
    const digest = liveP.planDigest;
    const deps = makeDeps({ plan: liveP, live: {} });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(deps.saveLaneEdits).toHaveBeenCalledTimes(1);
    expect(deps.appended!.map((entry) => `${entry.kind}:${entry.key}`)).toEqual([
      `intent:relaunch/${digest}/lane-2/save`,
    ]);
    // The dry-run path still never calls authorization.
    const dryDeps = makeDeps({ plan });
    await new ApplyRelaunchUseCase(dryDeps).applyRelaunch(dryRunRequest(digest));
    expect(dryDeps.authorization!.authorizeRelaunchApply).toHaveBeenCalledTimes(0);
  });

  it('U16: defaults to a dry run when apply is omitted or false, with exact absent step statuses', async () => {
    const plan = defaultPlan();
    const digest = plan.planDigest;
    const expectedLanes = [
      { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
      {
        laneId: 'lane-2',
        population: 'unrecorded',
        stepStatuses: [
          { step: 'save', status: 'absent' },
          { step: 'adopt', status: 'absent' },
          { step: 'redispatch', status: 'absent' },
        ],
        nextAction: { kind: 'run', step: 'save' },
      },
    ];
    for (const apply of [undefined, false]) {
      const deps = makeDeps({ plan });
      const request = dryRunRequest(digest);
      if (apply !== undefined) (request as Record<string, unknown>)['apply'] = apply;
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request)).toEqual({
        outcome: 'dry-run',
        planDigest: digest,
        lanes: expectedLanes,
      });
      expect(deps.cutoverJournal.listByKeyPrefix).toHaveBeenCalledWith(`relaunch/${digest}/`);
    }
    // An apply: true with a grant is still refused in AR2a2 — the dry run is
    // the only implemented outcome (see U15).
  });

  it('U17: derives replay progression across save, abort, adopt (partial resume for a dangling sub-step intent) and redispatch reconcile', async () => {
    // A running lane whose save is complete and whose abort has an intent
    // only: the next action reconciles the abort.
    const runningDigestBase = hex('running plan A');
    const running = buildPlan([conductedLane(), runningLane(runningDigestBase)]);
    const runningDigest = running.planDigest;
    const key = (code: string): string => `relaunch/${runningDigest}/lane-2/${code}`;
    const adoptKey = (sub: string): string => `relaunch/${runningDigest}/lane-2/adopt/${sub}`;
    expect(
      await new ApplyRelaunchUseCase(
        makeDeps({ plan: running, entries: [intent(key('save')), result(key('save'), 'completed'), intent(key('abort'))] }),
      ).applyRelaunch(dryRunRequest(runningDigest)),
    ).toEqual({
      outcome: 'dry-run',
      planDigest: runningDigest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'completed' },
            { step: 'abort', status: 'intent-only' },
            { step: 'adopt', status: 'absent' },
            { step: 'redispatch', status: 'absent' },
          ],
          nextAction: { kind: 'reconcile', step: 'abort', status: 'intent-only' },
        },
      ],
    });
    // A partial adopt: save and abort complete, one adopt sub-step has a
    // dangling intent (I7) — the next action is a resume, not a repeat.
    const partialEntries = [
      intent(key('save')),
      result(key('save'), 'completed'),
      intent(key('abort')),
      result(key('abort'), 'completed'),
      intent(adoptKey('work-order')),
    ];
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: running, entries: partialEntries })).applyRelaunch(
        dryRunRequest(runningDigest),
      ),
    ).toEqual({
      outcome: 'dry-run',
      planDigest: runningDigest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'completed' },
            { step: 'abort', status: 'completed' },
            { step: 'adopt', status: 'partial' },
            { step: 'redispatch', status: 'absent' },
          ],
          nextAction: { kind: 'resume', step: 'adopt' },
        },
      ],
    });
    // A complete adopt leaves only the redispatch, which stays intent-only
    // once recorded (it hands the lane back to the conductor).
    const completeEntries = [
      intent(key('save')),
      result(key('save'), 'completed'),
      intent(key('abort')),
      result(key('abort'), 'completed'),
      ...ADOPT_SUB_STEPS.flatMap((sub) => [intent(adoptKey(sub)), result(adoptKey(sub), 'completed')]),
      intent(key('redispatch')),
    ];
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: running, entries: completeEntries })).applyRelaunch(
        dryRunRequest(runningDigest),
      ),
    ).toEqual({
      outcome: 'dry-run',
      planDigest: runningDigest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'completed' },
            { step: 'abort', status: 'completed' },
            { step: 'adopt', status: 'completed' },
            { step: 'redispatch', status: 'intent-only' },
          ],
          nextAction: { kind: 'reconcile', step: 'redispatch', status: 'intent-only' },
        },
      ],
    });
  });

  it('U18: an execute() replay of a fully complete lane reports done, and a refused save keeps the lane stopped without refusing the whole dry run', async () => {
    const runningDigestBase = hex('running plan B');
    const running = buildPlan([conductedLane(), runningLane(runningDigestBase)]);
    const digest = running.planDigest;
    const key = (code: string): string => `relaunch/${digest}/lane-2/${code}`;
    const adoptKey = (sub: string): string => `relaunch/${digest}/lane-2/adopt/${sub}`;
    const entries = [
      intent(key('save')),
      result(key('save'), 'completed'),
      intent(key('abort')),
      result(key('abort'), 'completed'),
      ...ADOPT_SUB_STEPS.flatMap((sub) => [intent(adoptKey(sub)), result(adoptKey(sub), 'completed')]),
      intent(key('redispatch')),
      result(key('redispatch'), 'completed'),
    ];
    const useCase = new ApplyRelaunchUseCase(makeDeps({ plan: running, entries }));
    // execute() delegates to applyRelaunch(): a fully complete lane is done.
    expect(await useCase.execute(dryRunRequest(digest))).toEqual({
      outcome: 'dry-run',
      planDigest: digest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'completed' },
            { step: 'abort', status: 'completed' },
            { step: 'adopt', status: 'completed' },
            { step: 'redispatch', status: 'completed' },
          ],
          nextAction: { kind: 'done' },
        },
      ],
    });
    // A refused save stops the lane: nextAction is a stopped refusal, but the
    // dry run itself still reports the lane's state.
    const refusedEntries = [intent(key('save')), result(key('save'), 'refused')];
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan: running, entries: refusedEntries })).applyRelaunch(
        dryRunRequest(digest),
      ),
    ).toEqual({
      outcome: 'dry-run',
      planDigest: digest,
      lanes: [
        { laneId: 'lane-1', population: 'conducted', stepStatuses: [], nextAction: { kind: 'done' } },
        {
          laneId: 'lane-2',
          population: 'unrecorded',
          stepStatuses: [
            { step: 'save', status: 'refused' },
            { step: 'abort', status: 'absent' },
            { step: 'adopt', status: 'absent' },
            { step: 'redispatch', status: 'absent' },
          ],
          nextAction: { kind: 'stopped', step: 'save', reason: 'refused' },
        },
      ],
    });
  });

  it('HV1: a request Proxy whose getPrototypeOf or getOwnPropertyDescriptor trap throws is a typed invalid-request, never a rejection', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    const target = { planDigest: plan.planDigest, nowIso: NOW };
    const boom = (): never => {
      throw new Error('trap must not escape');
    };
    for (const traps of [{ getPrototypeOf: boom }, { getOwnPropertyDescriptor: boom }, { ownKeys: boom }]) {
      await expect(useCase.applyRelaunch(new Proxy(target, traps))).resolves.toEqual({
        outcome: 'refused',
        reason: 'invalid-request',
      });
    }
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
  });

  it('HV2: a port envelope with a throwing getter or Proxy trap is plan-unreadable or journal-unreadable and the getter never runs', async () => {
    const plan = defaultPlan();
    const calls = { count: 0 };
    const throwingGetter = (target: object, key: string): object => {
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get(): never {
          calls.count += 1;
          throw new Error('getter must never run');
        },
      });
      return target;
    };
    const planEnvelope = throwingGetter({ plan }, 'outcome');
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ findResult: planEnvelope })).applyRelaunch(dryRunRequest(plan.planDigest)),
    ).toEqual({ outcome: 'refused', reason: 'plan-unreadable' });
    const entriesEnvelope = throwingGetter({ outcome: 'listed' }, 'entries');
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, journalResult: entriesEnvelope })).applyRelaunch(
        dryRunRequest(plan.planDigest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'journal-unreadable' });
    const outcomeEnvelope = throwingGetter({ entries: [] }, 'outcome');
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, journalResult: outcomeEnvelope })).applyRelaunch(
        dryRunRequest(plan.planDigest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'journal-unreadable' });
    const trapped = new Proxy(
      { outcome: 'listed', entries: [] },
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap must not escape');
        },
      },
    );
    expect(
      await new ApplyRelaunchUseCase(makeDeps({ plan, journalResult: trapped })).applyRelaunch(
        dryRunRequest(plan.planDigest),
      ),
    ).toEqual({ outcome: 'refused', reason: 'journal-unreadable' });
    expect(calls.count).toBe(0);
  });

  it('HV3: a secret-shaped or over-long value under an unknown request key is refused like any other request string', async () => {
    const plan = defaultPlan();
    const deps = makeDeps({ plan });
    const useCase = new ApplyRelaunchUseCase(deps);
    expect(
      await useCase.applyRelaunch(dryRunRequest(plan.planDigest, { note: `sk-${'a'.repeat(20)}` })),
    ).toEqual({ outcome: 'refused', reason: 'secret-detected' });
    expect(await useCase.applyRelaunch(dryRunRequest(plan.planDigest, { note: 'x'.repeat(4097) }))).toEqual({
      outcome: 'refused',
      reason: 'invalid-request',
    });
    expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
  });

  // ---- AR2b: the live apply (one wave of save, abort, redispatch) ----

  const key = (digest: string, laneId: string, code: string): string =>
    `relaunch/${digest}/${laneId}/${code}`;
  const adoptKey = (digest: string, laneId: string, sub: string): string =>
    `relaunch/${digest}/${laneId}/adopt/${sub}`;

  /** A live plan: one conducted lane with a run, one idle lane in wave 1. */
  const livePlan = (seed = 'live plan'): RelaunchPlanRecord =>
    buildPlan([conductedLaneWithRun(), idleLane(hex(seed))]);

  /** Save intent + completed result for a lane, with the matching input digest. */
  const completedSave = (digest: string, laneId: string, input: Record<string, unknown>): unknown[] => [
    intent(key(digest, laneId, 'save'), saveInputDigest(digest, input)),
    result(key(digest, laneId, 'save'), 'completed'),
  ];

  /**
   * All four adopt sub-steps completed for a lane. AR3c1: when the wave
   * resents an adopt input, the completed work-order result journals the
   * matching identity digest, as the real AdoptLaneUseCase does.
   */
  const completedAdopt = (digest: string, laneId: string, input?: Record<string, unknown>): unknown[] =>
    ADOPT_SUB_STEPS.flatMap((sub) => [
      intent(adoptKey(digest, laneId, sub)),
      result(
        adoptKey(digest, laneId, sub),
        'completed',
        sub === 'work-order' && input !== undefined ? adoptIdentityDigest(laneId, input) : null,
      ),
    ]);

  it('U19: only the validated clone is used after validation — mutating the store plan object during the digest call cannot change the executed wave', async () => {
    const plan = livePlan('clone plan');
    const digest = plan.planDigest;
    const entries = [...completedSave(digest, 'lane-2', saveInput()), ...completedAdopt(digest, 'lane-2', adoptInput())];
    const deps = makeDeps({
      plan,
      entries,
      // The digest runs on the validated CLONE after `findByDigest` resolved;
      // mutating the ORIGINAL here must not change what executes. An
      // implementation that kept reading the original would see wave 7, find
      // no lane at wave 1, and return `wave: null` without acting.
      computeDigest: (text: string) => {
        (plan.lanes[1] as { admissionWave: number }).admissionWave = 7;
        return computeDigest(text);
      },
      live: {},
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: [saveInput()] }),
      ),
    ).toMatchObject({ outcome: 'applied', wave: 1 });
    // The wave executed: the redispatch intent for lane-2 was journaled.
    expect(
      deps.appended!.some((entry) => entry.key === key(digest, 'lane-2', 'redispatch') && entry.kind === 'intent'),
    ).toBe(true);
    expect(deps.authorization!.authorizeRelaunchApply).toHaveBeenCalledTimes(1);
  });

  it('U20: a missing runRepo, missing runner, missing append, missing mintEntryId, or a saveInput missing for one non-conducted lane refuses stale-plan-state before authorizeRelaunchApply', async () => {
    const plan = livePlan('preflight plan');
    const digest = plan.planDigest;
    const request = (): unknown => applyRequest(digest, { saveInputs: [saveInput()] });
    for (const omit of ['noRunRepo', 'noRunner', 'noAppend', 'noMint', 'noSave', 'noTerminate'] as const) {
      const deps = makeDeps({ plan, live: { [omit]: true } });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request())).toEqual({
        outcome: 'refused',
        reason: 'stale-plan-state',
      });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
      expect(deps.appended).toEqual([]);
    }
    // A missing saveInput for the non-conducted lane names the lane.
    const deps = makeDeps({ plan, live: {} });
    const noSave = applyRequest(digest) as Record<string, unknown>;
    delete noSave['saveInputs'];
    expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(noSave)).toEqual({
      outcome: 'refused',
      reason: 'stale-plan-state',
      laneId: 'lane-2',
    });
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
  });

  it('U21: a conducted runRepo.get throw, a throwing inspectWorktreeRun and an unknown worktree state refuse stale-plan-state before authorizeRelaunchApply', async () => {
    const plan = livePlan('liveness plan');
    const digest = plan.planDigest;
    const request = (): unknown => applyRequest(digest, { saveInputs: [saveInput()] });
    // The conducted run record cannot be read: the conducted lane is named.
    const runThrows = makeDeps({ plan, live: { runThrows: true } });
    expect(await new ApplyRelaunchUseCase(runThrows).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'stale-plan-state',
      laneId: 'lane-1',
    });
    expect(runThrows.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    // The worktree inspection throws.
    const inspectThrows = makeDeps({ plan, live: { inspectThrows: true } });
    expect(await new ApplyRelaunchUseCase(inspectThrows).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'stale-plan-state',
      laneId: 'lane-2',
    });
    expect(inspectThrows.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    // The worktree state is unknown.
    const inspectUnknown = makeDeps({ plan, live: { inspect: { state: 'unknown', reason: 'cannot tell' } } });
    expect(await new ApplyRelaunchUseCase(inspectUnknown).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'stale-plan-state',
      laneId: 'lane-2',
    });
    expect(inspectUnknown.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
  });

  it('U22: a plan that says idle with an unfinished save while the worktree runs refuses unexpected-running-lane before authorizeRelaunchApply', async () => {
    const plan = livePlan('idle-says plan');
    const digest = plan.planDigest;
    const deps = makeDeps({ plan, live: { inspect: { state: 'running', sessionId: 's-1' } } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'unexpected-running-lane', laneId: 'lane-2' });
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    expect(deps.appended).toEqual([]);
  });

  it('U23: blocked, unknown, missing-port, mismatched-grantId and throwing authorization each refuse with the mapped reason and zero journal writes', async () => {
    const plan = livePlan('grant plan');
    const digest = plan.planDigest;
    const request = (): unknown => applyRequest(digest, { saveInputs: [saveInput()] });
    const expectRefusal = async (
      live: LiveOver,
      expected: { outcome: string; reason: string; laneId?: string },
    ): Promise<void> => {
      const deps = makeDeps({ plan, live });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request())).toEqual(expected);
      expect(deps.appended).toEqual([]);
      expect(deps.saveLaneEdits).not.toHaveBeenCalled();
    };
    await expectRefusal(
      { authorize: { outcome: 'blocked', reason: 'grant-expired' } },
      { outcome: 'refused', reason: 'grant-expired' },
    );
    await expectRefusal(
      { authorize: { outcome: 'blocked', reason: 'grant-revoked' } },
      { outcome: 'refused', reason: 'grant-revoked' },
    );
    await expectRefusal(
      { authorize: { outcome: 'blocked', reason: 'grant-digest-mismatch' } },
      { outcome: 'refused', reason: 'grant-digest-mismatch' },
    );
    await expectRefusal(
      { authorize: { outcome: 'blocked', reason: 'not-a-known-code' } },
      { outcome: 'refused', reason: 'authorization-unavailable' },
    );
    await expectRefusal(
      { authorize: { outcome: 'unknown', reason: 'grant store down' } },
      { outcome: 'refused', reason: 'authorization-unavailable' },
    );
    await expectRefusal(
      { authorize: { outcome: 'authorized', grantId: 'another-grant' } },
      { outcome: 'refused', reason: 'grant-id-mismatch' },
    );
    await expectRefusal(
      { authorizeThrows: true },
      { outcome: 'refused', reason: 'authorization-unavailable' },
    );
    await expectRefusal(
      { noAuthorization: true },
      { outcome: 'refused', reason: 'authorization-unavailable' },
    );
  });

  it('U24: a save intent that cannot be journaled — duplicate-intent, store-read-only, store-unreadable or a throw — refuses journal-write-failed with no save attempted', async () => {
    const plan = livePlan('journal plan');
    const digest = plan.planDigest;
    const request = (): unknown => applyRequest(digest, { saveInputs: [saveInput()] });
    for (const refusal of ['duplicate-intent', 'store-read-only', 'store-unreadable']) {
      const deps = makeDeps({ plan, live: { appendResults: [{ outcome: refusal }] } });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request())).toEqual({
        outcome: 'refused',
        reason: 'journal-write-failed',
        laneId: 'lane-2',
      });
      expect(deps.saveLaneEdits).not.toHaveBeenCalled();
      expect(deps.appended).toEqual([]);
    }
    const throwing = makeDeps({ plan, live: { appendThrows: true } });
    expect(await new ApplyRelaunchUseCase(throwing).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'journal-write-failed',
      laneId: 'lane-2',
    });
    expect(throwing.saveLaneEdits).not.toHaveBeenCalled();
  });

  it('U25: saveLaneEdits refusing, answering unknown or throwing refuses save-failed after the intent was journaled', async () => {
    const plan = livePlan('save plan');
    const digest = plan.planDigest;
    const request = (): unknown => applyRequest(digest, { saveInputs: [saveInput()] });
    for (const live of [{ save: { outcome: 'refused', reason: 'diff-check-findings' } }, { save: { outcome: 'unknown', reason: 'runner down' } }, { saveThrows: true }]) {
      const deps = makeDeps({ plan, live });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request())).toEqual({
        outcome: 'refused',
        reason: 'save-failed',
        laneId: 'lane-2',
      });
      // The intent was journaled first (I7); the save result never is.
      expect(deps.appended!.map((entry) => entry.kind)).toEqual(['intent']);
      expect(deps.appended![0]!['key']).toBe(key(digest, 'lane-2', 'save'));
    }
  });

  it('U26: resuming a save in intent-only with a matching digest re-calls saveLaneEdits without appending a second intent, then stops at the refused adopt', async () => {
    const digest = livePlan('resume plan').planDigest;
    const input = saveInput();
    const entries = [intent(key(digest, 'lane-2', 'save'), saveInputDigest(digest, input))];
    const deps = makeDeps({ plan: livePlan('resume plan'), entries, live: {} });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(digest, { saveInputs: [input] })),
    ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(deps.saveLaneEdits).toHaveBeenCalledTimes(1);
    // No second save intent was journaled (I7): the only appended entry is
    // the later wave's — here none, because the adopt refused first.
    expect(deps.appended).toEqual([]);
  });

  it('U27: an abort confirmed aborted records the completed result and never terminates the process tree', async () => {
    const seed = 'abort-ok plan';
    const plan = buildPlan([conductedLaneWithRun(), runningLane(hex(seed))]);
    const digest = plan.planDigest;
    const deps = makeDeps({
      plan,
      entries: [...completedSave(digest, 'lane-2', saveInput())],
      live: { abort: { outcome: 'aborted', endedAtIso: CLOCK_NOW } },
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(deps.runner!.abortWorktreeRun).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'attempt-1', gracePeriodSeconds: 30 }),
    );
    expect(deps.processTreeTermination!.terminateWorktreeProcesses).not.toHaveBeenCalled();
    expect(deps.appended!.map((entry) => [entry.kind, entry.key, entry.outcome, entry.reasonCode])).toEqual([
      ['intent', key(digest, 'lane-2', 'abort'), undefined, undefined],
      ['result', key(digest, 'lane-2', 'abort'), 'completed', 'aborted'],
    ]);
  });

  it('U28: an abort without a confirmed result terminates the process tree (I3); a confirmed termination records completed, a refused one records the failure and refuses abort-failed', async () => {
    const seed = 'abort-terminate plan';
    const plan = buildPlan([conductedLaneWithRun(), runningLane(hex(seed))]);
    const digest = plan.planDigest;
    const entries = [...completedSave(digest, 'lane-2', saveInput())];
    const request = (): unknown => applyRequest(digest, { saveInputs: [saveInput()] });
    // still-running, unknown, refused and a thrown abort all terminate.
    for (const live of [
      { abort: { outcome: 'still-running', reason: 'process alive' } },
      { abort: { outcome: 'unknown', reason: 'no answer' } },
      { abort: { outcome: 'refused', reason: 'busy' } },
      { abortThrows: true },
    ]) {
      const deps = makeDeps({ plan, entries: [...entries], live });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request())).toEqual({
        outcome: 'refused',
        reason: 'adopt-failed',
        laneId: 'lane-2',
      });
      expect(deps.processTreeTermination!.terminateWorktreeProcesses).toHaveBeenCalledTimes(1);
      expect(deps.appended!.map((entry) => [entry.kind, entry.outcome, entry.reasonCode])).toEqual([
        ['intent', undefined, undefined],
        ['result', 'completed', 'terminated'],
      ]);
    }
    // A refused termination records the failed result and refuses the lane.
    const deps = makeDeps({
      plan,
      entries: [...entries],
      live: { abort: { outcome: 'still-running', reason: 'process alive' }, terminate: { outcome: 'refused', reason: 'no host' } },
    });
    expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'abort-failed',
      laneId: 'lane-2',
    });
    expect(deps.appended!.map((entry) => [entry.kind, entry.outcome, entry.reasonCode])).toEqual([
      ['intent', undefined, undefined],
      ['result', 'refused', 'terminate-failed'],
    ]);
  });

  it('U29: an abort left intent-only reconciles read-only — an idle worktree records completed without re-calling abortWorktreeRun, a running or unknown one refuses abort-failed', async () => {
    const seed = 'abort-reconcile plan';
    const plan = buildPlan([conductedLaneWithRun(), runningLane(hex(seed))]);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', saveInput()),
      intent(key(digest, 'lane-2', 'abort')),
    ];
    const request = (): unknown => applyRequest(digest, { saveInputs: [saveInput()] });
    // Idle: reconciled without another abort call.
    const idle = makeDeps({ plan, entries: [...entries], live: {} });
    expect(await new ApplyRelaunchUseCase(idle).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'adopt-failed',
      laneId: 'lane-2',
    });
    expect(idle.runner!.abortWorktreeRun).not.toHaveBeenCalled();
    expect(idle.appended!.map((entry) => [entry.kind, entry.outcome, entry.reasonCode])).toEqual([
      ['result', 'completed', 'reconciled-idle'],
    ]);
    // Still running: no result is recorded; the lane refuses.
    const running = makeDeps({ plan, entries: [...entries], live: { inspect: { state: 'running', sessionId: 's-1' } } });
    expect(await new ApplyRelaunchUseCase(running).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'abort-failed',
      laneId: 'lane-2',
    });
    expect(running.appended).toEqual([]);
    // Unknown: the preflight refuses before the grant is ever spent.
    const unknown = makeDeps({ plan, entries: [...entries], live: { inspect: { state: 'unknown', reason: 'down' } } });
    expect(await new ApplyRelaunchUseCase(unknown).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'stale-plan-state',
      laneId: 'lane-2',
    });
    expect(unknown.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    expect(unknown.appended).toEqual([]);
  });

  it('U30: the active-run cap refuses a redispatch intent before it is written, counting hand-offs carried over from earlier waves', async () => {
    // lane-2 (wave 1) is already handed off with its worktree still running;
    // lanes 3 and 4 sit in wave 2. With maxActiveRuns 2 the second fresh
    // hand-off crosses the cap; with 3 both fit. The planner's own wave
    // capacity keeps both plans valid, so the refusal can only come from the
    // apply's live counter.
    const lane = (id: string): FixtureLane => ({
      ...idleLane('x', id, ['lane-2']),
      hostName: `host-${id}`,
      admissionWave: 2,
    });
    const setup = (maxActiveRuns: number): { plan: RelaunchPlanRecord; inputs: Record<string, unknown>[]; entries: unknown[] } => {
      const plan = buildPlan(
        [{ ...idleLane('x', 'lane-2', []), hostName: 'host-lane-2' }, lane('lane-3'), lane('lane-4')],
        maxActiveRuns,
      );
      const inputs = [
        saveInput(),
        saveInput({ laneId: 'lane-3', attemptId: 'attempt-3' }),
        saveInput({ laneId: 'lane-4', attemptId: 'attempt-4' }),
      ];
      const entries = [
        ...completedSave(plan.planDigest, 'lane-2', inputs[0]!),
        ...completedAdopt(plan.planDigest, 'lane-2', adoptInput()),
        intent(key(plan.planDigest, 'lane-2', 'redispatch')),
        ...completedSave(plan.planDigest, 'lane-3', inputs[1]!),
        ...completedAdopt(plan.planDigest, 'lane-3', lane3AdoptInput()),
        // lane-4's adopt is still absent: it must carry an adopt input and
        // its own adopt re-checks the cap before adoptLane runs (AR2c).
        ...completedSave(plan.planDigest, 'lane-4', inputs[2]!),
      ];
      return { plan, inputs, entries };
    };
    const lane4AdoptInput = adoptInput({
      laneId: 'lane-4',
      attempt: { ...(adoptInput()['attempt'] as object), attemptId: 'attempt-4' },
      run: { ...(adoptInput()['run'] as object), runId: `run-7${'C'.repeat(25)}` },
    });
    // Cap 2: lane-2's pending hand-off and lane-3's completed adopt are
    // counted (0 conducted + 2 >= 2), so lane-4's absent adopt refuses before
    // its intent or adopt could be written; lane-3's own redispatch (a
    // completed adopt) hands off without a cap re-check.
    const capped = setup(2);
    const deps = makeDeps({
      plan: capped.plan,
      entries: capped.entries,
      live: { inspectByAttempt: { 'attempt-1': { state: 'running', sessionId: 's-2' } } },
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(capped.plan.planDigest, { saveInputs: capped.inputs, adoptInputs: [lane4AdoptInput] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'active-run-cap-reached', laneId: 'lane-4' });
    expect(
      deps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([key(capped.plan.planDigest, 'lane-3', 'redispatch')]);
    // Cap 3: lane-4's adopt fits and both wave-2 lanes hand off.
    const roomier = setup(3);
    const roomierDeps = makeDeps({ plan: roomier.plan, entries: roomier.entries, live: { adopt: lane4Adopted() } });
    expect(
      await new ApplyRelaunchUseCase(roomierDeps).applyRelaunch(
        applyRequest(roomier.plan.planDigest, { saveInputs: roomier.inputs, adoptInputs: [lane4AdoptInput] }),
      ),
    ).toMatchObject({ outcome: 'applied', wave: 2 });
    expect(roomierDeps.adoptLane).toHaveBeenCalledTimes(1);
    expect(
      roomierDeps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([
      key(roomier.plan.planDigest, 'lane-3', 'redispatch'),
      ...ADOPT_SUB_STEPS.map((sub) => adoptKey(roomier.plan.planDigest, 'lane-4', sub)),
      key(roomier.plan.planDigest, 'lane-4', 'redispatch'),
    ]);
  });

  it('U31: one wave per invocation — the first call saves and hands off wave 1 only, journaled as intent before action, and never calls prepareFixAttempt', async () => {
    const seed = 'waves plan';
    const digest = hex(seed);
    const lane2 = idleLane(digest, 'lane-2', ['lane-1']);
    const lane3 = { ...idleLane(digest, 'lane-3', ['lane-2']), hostName: 'host-c', admissionWave: 2, dispatchEndpointKey: 'opencode:host-c:4321' };
    const plan = buildPlan([conductedLaneWithRun(), lane2, lane3]);
    const inputs = [saveInput(), saveInput({ laneId: 'lane-3', attemptId: 'attempt-3' })];
    const entries = [
      ...completedSave(plan.planDigest, 'lane-2', inputs[0]!),
      ...completedAdopt(plan.planDigest, 'lane-2', adoptInput()),
      ...completedSave(plan.planDigest, 'lane-3', inputs[1]!),
      ...completedAdopt(plan.planDigest, 'lane-3', lane3AdoptInput()),
    ];
    const deps = makeDeps({ plan, entries, live: {} });
    const result = await new ApplyRelaunchUseCase(deps).applyRelaunch(
      applyRequest(plan.planDigest, { saveInputs: inputs }),
    );
    expect(result).toMatchObject({ outcome: 'applied', wave: 1 });
    // Only lane-2's redispatch intent was journaled; lane-3 (wave 2) waits.
    expect(deps.appended!.map((entry) => [entry.kind, entry.key])).toEqual([
      ['intent', key(plan.planDigest, 'lane-2', 'redispatch')],
    ]);
    // The grant was authorized for this digest with the trusted clock reading.
    expect(deps.authorization!.authorizeRelaunchApply).toHaveBeenCalledWith({
      planDigest: plan.planDigest,
      grantId: 'grant-1',
      nowIso: CLOCK_NOW,
    });
    // The wave summary re-derived from the journal shows lane-2 handed off.
    const summary = (result as unknown as { lanes: { laneId: string; stepStatuses: { step: string; status: string }[] }[] }).lanes.find(
      (entry) => entry.laneId === 'lane-2',
    );
    expect(summary?.stepStatuses.find((entry) => entry.step === 'redispatch')).toEqual({
      step: 'redispatch',
      status: 'intent-only',
    });
  });

  it('U32: replaying with the same grantId authorizes cleanly and advances wave by wave, ending with wave null once every redispatch is intent-only', async () => {
    const seed = 'replay waves plan';
    const digest = hex(seed);
    const lane2 = idleLane(digest, 'lane-2', ['lane-1']);
    const lane3 = { ...idleLane(digest, 'lane-3', ['lane-2']), hostName: 'host-c', admissionWave: 2, dispatchEndpointKey: 'opencode:host-c:4321' };
    const plan = buildPlan([conductedLaneWithRun(), lane2, lane3]);
    const inputs = [saveInput(), saveInput({ laneId: 'lane-3', attemptId: 'attempt-3' })];
    const entries = [
      ...completedSave(plan.planDigest, 'lane-2', inputs[0]!),
      ...completedAdopt(plan.planDigest, 'lane-2', adoptInput()),
      ...completedSave(plan.planDigest, 'lane-3', inputs[1]!),
      ...completedAdopt(plan.planDigest, 'lane-3', lane3AdoptInput()),
    ];
    const deps = makeDeps({ plan, entries, live: {} });
    const useCase = new ApplyRelaunchUseCase(deps);
    const request = (): unknown => applyRequest(plan.planDigest, { saveInputs: inputs });
    expect(await useCase.applyRelaunch(request())).toMatchObject({ outcome: 'applied', wave: 1 });
    expect(await useCase.applyRelaunch(request())).toMatchObject({ outcome: 'applied', wave: 2 });
    expect(
      deps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([key(plan.planDigest, 'lane-2', 'redispatch'), key(plan.planDigest, 'lane-3', 'redispatch')]);
    // The third call finds no lane left to wave: applied with wave null.
    const third = await useCase.applyRelaunch(request());
    expect(third).toMatchObject({ outcome: 'applied', wave: null });
    const lanes = (third as unknown as { lanes: { laneId: string; stepStatuses: { step: string; status: string }[] }[] }).lanes;
    for (const laneId of ['lane-2', 'lane-3']) {
      expect(
        lanes.find((entry) => entry.laneId === laneId)?.stepStatuses.find((entry) => entry.step === 'redispatch'),
      ).toEqual({ step: 'redispatch', status: 'intent-only' });
    }
    // The same grantId re-authorized on every call (a failed preflight never
    // consumes it, and a replay re-authorizes cleanly).
    expect(deps.authorization!.authorizeRelaunchApply).toHaveBeenCalledTimes(3);
  });

  // ---- Fix round 1: the three review items ----

  it('U33: a malformed recordedHost — an empty object, a partial runner record, a non-record or a host field accessor — refuses invalid-request during parsing, before any store read (cost: one bounded descriptor read per element)', async () => {
    const plan = livePlan('host plan');
    const digest = plan.planDigest;
    // The valid host block the malformed variants are compared against.
    const validHost = {
      kind: 'opencode',
      remotePort: 4321,
      host: 'host-b',
      agent: 'agent-1',
      model: 'model-1',
      variant: null,
    };
    // `recordedHost` itself is an accessor: the scan cannot read it.
    const accessorHost = { ...validHost };
    Object.defineProperty(accessorHost, 'host', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('getter must never run');
      },
    });
    const cases: unknown[] = [
      {}, // empty object: nothing like a runner record
      { kind: 'opencode' }, // a partial runner record
      { ...validHost, extra: 'x' }, // an unknown key
      { ...validHost, remotePort: 0 }, // an out-of-range port
      { ...validHost, kind: 'mystery' }, // an unknown runner kind
      [], // an array is not a host record
      'host-b', // a primitive is not a host record
      accessorHost, // an accessor field is unreadable, so invalid
    ];
    for (const recordedHost of cases) {
      const deps = makeDeps({ plan, live: {} });
      expect(
        await new ApplyRelaunchUseCase(deps).applyRelaunch(
          dryRunRequest(digest, { saveInputs: [saveInput({ recordedHost })] }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      // Parsing refused: no plan was read and no grant could be consumed.
      expect(deps.planRepo.findByDigest).not.toHaveBeenCalled();
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    }
    // The valid host block itself still parses and reaches the live wave,
    // which saves and then stops at the refused adopt (the default adoptLane).
    const deps = makeDeps({ plan, live: {} });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: [saveInput({ recordedHost: validHost })] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(deps.saveLaneEdits).toHaveBeenCalledWith(expect.objectContaining({ recordedHost: validHost }));
    expect(deps.planRepo.findByDigest).toHaveBeenCalled();
  });

  it('U34: the save-input map holds a detached snapshot — a caller-owned input mutated between parsing and the awaited plan read cannot change the digest verified or the request saved (cost: one bounded copy per element)', async () => {
    const seed = 'snapshot plan';
    const plan = buildPlan([conductedLaneWithRun(), idleLane(hex(seed))]);
    const input = saveInput();
    const entries = [intent(key(plan.planDigest, 'lane-2', 'save'), saveInputDigest(plan.planDigest, input))];
    const deps = makeDeps({ plan, entries, live: {} });
    // Mutate the caller-owned object the moment the plan store answers: an
    // implementation that retained the original object would re-read the
    // mutated fields after this await.
    const findByDigest = deps.planRepo.findByDigest as unknown as ReturnType<typeof vi.fn>;
    findByDigest.mockImplementation(async () => {
      (input as { worktreePath: string }).worktreePath = '/wt/mutated';
      (input as { baseCommit: string }).baseCommit = 'c'.repeat(64);
      return { outcome: 'found', plan } as unknown as FindRelaunchPlanResult;
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [input] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    // The digest still matched the original snapshot, so the save resumed
    // with the ORIGINAL field values, not the mutated ones.
    expect(deps.saveLaneEdits).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/wt/lane-2', baseCommit: 'b'.repeat(64) }),
    );
  });

  it('U35: a running lane saves first — the busy refusal clears via abort and a retried save — while an idle lane saves before its abort; a diff-refused save aborts nothing (I2)', async () => {
    const seed = 'ordering plan';
    const plan = buildPlan([conductedLaneWithRun(), runningLane(hex(seed))]);
    const digest = plan.planDigest;
    const request = (): unknown =>
      applyRequest(plan.planDigest, { saveInputs: [saveInput()] });
    // Running worktree: the first save attempt is refused `worktree-busy`
    // (the runner session is live), so the abort runs and the save retries
    // against the intent journaled by the first attempt.
    const running = makeDeps({ plan, live: { inspect: { state: 'running', sessionId: 's-1' } } });
    const order: string[] = [];
    const runningAbort = running.runner!.abortWorktreeRun as unknown as ReturnType<typeof vi.fn>;
    runningAbort.mockImplementation(async () => {
      order.push('abort');
      return { outcome: 'aborted', endedAtIso: CLOCK_NOW };
    });
    const runningSave = running.saveLaneEdits as unknown as ReturnType<typeof vi.fn>;
    runningSave.mockImplementation(async () => {
      order.push('save');
      return order.length <= 1 ? { outcome: 'refused', reason: 'worktree-busy', detail: null } : { outcome: 'saved' };
    });
    expect(await new ApplyRelaunchUseCase(running).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'adopt-failed',
      laneId: 'lane-2',
    });
    expect(order).toEqual(['save', 'abort', 'save']);
    expect(running.appended!.map((entry) => [entry.kind, entry.key])).toEqual([
      ['intent', key(digest, 'lane-2', 'save')],
      ['intent', key(digest, 'lane-2', 'abort')],
      ['result', key(digest, 'lane-2', 'abort')],
    ]);
    expect(running.processTreeTermination!.terminateWorktreeProcesses).not.toHaveBeenCalled();
    // A save refusal that no abort clears (a diff finding) stops the lane
    // before `abortWorktreeRun` — I2 for a running tree too (U36 below).
    // Idle worktree (same plan, honest save): save-before-abort (I2).
    const idle = makeDeps({ plan, live: { inspect: { state: 'idle' } } });
    const idleOrder: string[] = [];
    const idleAbort = idle.runner!.abortWorktreeRun as unknown as ReturnType<typeof vi.fn>;
    idleAbort.mockImplementation(async () => {
      idleOrder.push('abort');
      return { outcome: 'aborted', endedAtIso: CLOCK_NOW };
    });
    const idleSave = idle.saveLaneEdits as unknown as ReturnType<typeof vi.fn>;
    idleSave.mockImplementation(async () => {
      idleOrder.push('save');
      return { outcome: 'saved' };
    });
    expect(await new ApplyRelaunchUseCase(idle).applyRelaunch(request())).toEqual({
      outcome: 'refused',
      reason: 'adopt-failed',
      laneId: 'lane-2',
    });
    expect(idleOrder).toEqual(['save', 'abort']);
    expect(idle.appended!.map((entry) => [entry.kind, entry.key])).toEqual([
      ['intent', key(digest, 'lane-2', 'save')],
      ['intent', key(digest, 'lane-2', 'abort')],
      ['result', key(digest, 'lane-2', 'abort')],
    ]);
  });

  it('U35b: a Proxy array as allowedPathPrefixes or policyProtectedPaths is read through own descriptors only: its get trap never runs, and a bad element still refuses', async () => {
    const plan = buildPlan([conductedLaneWithRun(), runningLane(hex('proxy-text-array plan'))]);
    for (const field of ['allowedPathPrefixes', 'policyProtectedPaths']) {
      const reads = { count: 0 };
      const proxy = new Proxy(['src/'], {
        get(target, property, receiver) {
          reads.count += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      const deps = makeDeps({ plan });
      // The descriptor-only reader cannot tell a Proxy from a plain array (that
      // needs util.types, an adapter-layer API), but it never consults the get
      // trap, so the request proceeds exactly as with the equivalent plain data.
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput({ [field]: proxy })] }),
      );
      expect(reads.count).toBe(0);
      expect(deps.saveLaneEdits).toHaveBeenCalledWith(expect.objectContaining({ [field]: ['src/'] }));
      // A Proxy whose elements are not bounded text still refuses.
      const badProxy = new Proxy([7], {
        get(target, property, receiver) {
          reads.count += 1;
          return Reflect.get(target, property, receiver);
        },
      });
      expect(
        await new ApplyRelaunchUseCase(makeDeps({ plan })).applyRelaunch(
          applyRequest(plan.planDigest, { saveInputs: [saveInput({ [field]: badProxy })] }),
        ),
      ).toEqual({ outcome: 'refused', reason: 'invalid-request' });
      expect(reads.count).toBe(0);
    }
  });

  it('U35c: when the abort clearing a busy save runs past the deadline, the retried save is not attempted (budget-exhausted)', async () => {
    const plan = buildPlan([conductedLaneWithRun(), runningLane(hex('retry-deadline plan'))]);
    let now = CLOCK_NOW;
    const deps = makeDeps({ plan, clock: () => now, live: { inspect: { state: 'running', sessionId: 's-1' } } });
    (deps.runner!.abortWorktreeRun as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      now = PAST_DEADLINE;
      return { outcome: 'aborted', endedAtIso: PAST_DEADLINE };
    });
    const save = deps.saveLaneEdits as unknown as ReturnType<typeof vi.fn>;
    save.mockImplementation(async () => ({ outcome: 'refused', reason: 'worktree-busy', detail: null }));
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()], deadlineIso: DEADLINE }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('U36: a running lane whose saveLaneEdits refuses on a diff finding returns save-failed without any abort intent, call or termination — the save refusal causes no abort (I2)', async () => {
    const seed = 'diff-refusal plan';
    const plan = buildPlan([conductedLaneWithRun(), runningLane(hex(seed))]);
    const deps = makeDeps({
      plan,
      live: {
        inspect: { state: 'running', sessionId: 's-1' },
        save: { outcome: 'refused', reason: 'diff-check-findings', detail: { 'rule-x': 1 } },
      },
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(plan.planDigest, { saveInputs: [saveInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'save-failed', laneId: 'lane-2' });
    expect(deps.runner!.abortWorktreeRun).not.toHaveBeenCalled();
    expect(deps.processTreeTermination!.terminateWorktreeProcesses).not.toHaveBeenCalled();
    // The save intent was journaled (it precedes the save call), but no
    // abort entry ever reached the journal.
    expect(deps.appended!.map((entry) => [entry.kind, entry.key])).toEqual([
      ['intent', key(plan.planDigest, 'lane-2', 'save')],
    ]);
  });

  it('U37: a pending hand-off whose worktree still reports idle counts toward the active-run cap — the conductor has not started the lane yet, so a later wave cannot exceed maxActiveRuns', async () => {
    // lane-2 (wave 1) holds a redispatch intent but its worktree reports
    // idle: the conductor has not started the handed-off lane. With
    // maxActiveRuns 2, one wave-2 lane hands off and the second must refuse
    // before its intent is written; an implementation that counts only
    // observed `running` states would let both through.
    const lane = (id: string): FixtureLane => ({
      ...idleLane('x', id, ['lane-2']),
      hostName: `host-${id}`,
      admissionWave: 2,
    });
    const setup = (maxActiveRuns: number): { plan: RelaunchPlanRecord; inputs: Record<string, unknown>[]; entries: unknown[] } => {
      const plan = buildPlan(
        [{ ...idleLane('x', 'lane-2', []), hostName: 'host-lane-2' }, lane('lane-3'), lane('lane-4')],
        maxActiveRuns,
      );
      const inputs = [
        saveInput(),
        saveInput({ laneId: 'lane-3', attemptId: 'attempt-3' }),
        saveInput({ laneId: 'lane-4', attemptId: 'attempt-4' }),
      ];
      const entries = [
        ...completedSave(plan.planDigest, 'lane-2', inputs[0]!),
        ...completedAdopt(plan.planDigest, 'lane-2', adoptInput()),
        intent(key(plan.planDigest, 'lane-2', 'redispatch')),
        ...completedSave(plan.planDigest, 'lane-3', inputs[1]!),
        ...completedAdopt(plan.planDigest, 'lane-3', lane3AdoptInput()),
        // lane-4's adopt is still absent: it must carry an adopt input and
        // its own adopt re-checks the cap before adoptLane runs (AR2c).
        ...completedSave(plan.planDigest, 'lane-4', inputs[2]!),
      ];
      return { plan, inputs, entries };
    };
    const lane4AdoptInput = adoptInput({
      laneId: 'lane-4',
      attempt: { ...(adoptInput()['attempt'] as object), attemptId: 'attempt-4' },
      run: { ...(adoptInput()['run'] as object), runId: `run-7${'C'.repeat(25)}` },
    });
    // Cap 2: the pending hand-off on lane-2 (idle worktree) and lane-3's
    // completed adopt both count (0 + 2 >= 2), so lane-4's absent adopt
    // refuses before its intent or adopt could be written.
    const capped = setup(2);
    const deps = makeDeps({ plan: capped.plan, entries: capped.entries, live: { inspect: { state: 'idle' } } });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(capped.plan.planDigest, { saveInputs: capped.inputs, adoptInputs: [lane4AdoptInput] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'active-run-cap-reached', laneId: 'lane-4' });
    expect(
      deps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([key(capped.plan.planDigest, 'lane-3', 'redispatch')]);
    // Cap 3: lane-4's adopt fits and both wave-2 lanes hand off.
    const roomier = setup(3);
    const roomierDeps = makeDeps({ plan: roomier.plan, entries: roomier.entries, live: { inspect: { state: 'idle' }, adopt: lane4Adopted() } });
    expect(
      await new ApplyRelaunchUseCase(roomierDeps).applyRelaunch(
        applyRequest(roomier.plan.planDigest, { saveInputs: roomier.inputs, adoptInputs: [lane4AdoptInput] }),
      ),
    ).toMatchObject({ outcome: 'applied', wave: 2 });
    expect(roomierDeps.adoptLane).toHaveBeenCalledTimes(1);
    expect(
      roomierDeps.appended!.filter((entry) => entry.kind === 'intent').map((entry) => entry.key),
    ).toEqual([
      key(roomier.plan.planDigest, 'lane-3', 'redispatch'),
      ...ADOPT_SUB_STEPS.map((sub) => adoptKey(roomier.plan.planDigest, 'lane-4', sub)),
      key(roomier.plan.planDigest, 'lane-4', 'redispatch'),
    ]);
  });

  // ---- AR3b: run-repository reconciliation of redispatch hand-offs ----

  /**
   * A full, well-formed version-1 LaneRunRecord the reconciliation reads.
   * Fix round 1: the reader validates the whole record, so the fixture
   * carries every required field.
   */
  const runRecord = (runId: string, workOrderId: string, attemptIds: string[]): Record<string, unknown> => ({
    version: 1,
    runId,
    workOrderId,
    tier: 2,
    seatPlanRef: 'b'.repeat(64),
    cursors: { 'first-pass': null, fix: null, review: null },
    round: 0,
    attemptIds,
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: 'policy-1',
  });

  const RUN_A = `run-7${'A'.repeat(25)}`;
  const RUN_B = `run-7${'B'.repeat(25)}`;

  /** A valid wave-2 adopt input for lane-3. */
  const lane3AdoptInput = (): Record<string, unknown> =>
    adoptInput({
      laneId: 'lane-3',
      attempt: { ...(adoptInput()['attempt'] as object), attemptId: 'attempt-3' },
      run: { ...(adoptInput()['run'] as object), runId: `run-7${'C'.repeat(25)}` },
    });

  /** The full `adopted` answer matching the lane-3 adopt input. */
  const lane3Adopted = (): Record<string, unknown> => ({
    outcome: 'adopted', reused: false, workOrderId: 'wo-9', briefDigest: hex('do the thing'),
    attemptId: 'attempt-3', runId: `run-7${'C'.repeat(25)}`, commitOid: 'c'.repeat(64),
    enteredState: 'collecting', provenance: 'adopted',
  });

  /** A valid conduct journal entry carrying the run's state. */
  const conductEntry = (runId: string, state: string): Record<string, unknown> => ({
    version: 1,
    entryId: `7${'A'.repeat(25)}`,
    kind: 'conduct',
    key: null,
    runId,
    recordedAtIso: BEFORE_DEADLINE,
    mode: null,
    expectedRevision: null,
    mintedId: null,
    outcome: null,
    reasonCode: null,
    detail: null,
    grantId: null,
    state,
  });

  /** A two-wave plan whose wave-1 lane holds a redispatch intent; its plan workOrderId is null. */
  const handoffPlan = (maxActiveRuns: number): { plan: RelaunchPlanRecord; inputs: Record<string, unknown>[] } => {
    const seed = 'handoff plan';
    const digest = hex(seed);
    const lane2 = { ...idleLane(digest, 'lane-2', ['lane-1']), workOrderId: null };
    const lane3 = { ...idleLane(digest, 'lane-3', ['lane-2']), hostName: 'host-c', admissionWave: 2, dispatchEndpointKey: 'opencode:host-c:4321' };
    const plan = buildPlan([conductedLaneWithRun(), lane2, lane3], maxActiveRuns);
    const inputs = [saveInput(), saveInput({ laneId: 'lane-3', attemptId: 'attempt-3' })];
    return { plan, inputs };
  };

  it('AR3b-1: a wave-1 intent-only hand-off whose matched run is terminal appends handed-off, frees capacity and admits wave 2 in the same call, resolving the unrecorded lane work order id from the re-sent adopt input', async () => {
    const { plan, inputs } = handoffPlan(2);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
      ...completedSave(digest, 'lane-3', inputs[1]!),
    ];
    const deps = makeDeps({
      plan,
      entries,
      live: {
        runs: [runRecord(RUN_A, 'wo-9', ['attempt-1'])],
        runJournalFor: (runId: string) => (runId === RUN_A ? [conductEntry(RUN_A, 'merged')] : []),
        adopt: lane3Adopted(),
      },
    });
    const adopt3 = lane3AdoptInput();
    const result = await new ApplyRelaunchUseCase(deps).applyRelaunch(
      applyRequest(digest, { saveInputs: inputs, adoptInputs: [adoptInput(), adopt3] }),
    );
    expect(result).toMatchObject({ outcome: 'applied', wave: 2 });
    // The hand-off result for lane-2 was journaled, then lane-3 was adopted and handed off.
    expect(deps.appended!.map((entry) => [entry.kind, entry.key])).toEqual([
      ['result', key(digest, 'lane-2', 'redispatch')],
      ...ADOPT_SUB_STEPS.flatMap((sub) => [['intent', adoptKey(digest, 'lane-3', sub)], ['result', adoptKey(digest, 'lane-3', sub)]]),
      ['intent', key(digest, 'lane-3', 'redispatch')],
    ]);
    // The refreshed summary shows lane-2's redispatch completed.
    const summary = (result as unknown as { lanes: { laneId: string; stepStatuses: { step: string; status: string }[] }[] }).lanes.find(
      (entry) => entry.laneId === 'lane-2',
    );
    expect(summary?.stepStatuses.find((entry) => entry.step === 'redispatch')).toEqual({
      step: 'redispatch', status: 'completed',
    });
    // The capacity was freed: maxActiveRuns 2 with a terminal matched run still admitted lane-3's adopt.
    expect(deps.adoptLane).toHaveBeenCalledTimes(1);
  });

  it('AR3b-2: a wave-1 intent-only hand-off whose matched run is another non-terminal attempt appends handed-off but keeps the slot spent, so wave 2 refuses active-run-cap-reached', async () => {
    const { plan, inputs } = handoffPlan(2);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
      ...completedSave(digest, 'lane-3', inputs[1]!),
    ];
    const adopt3 = lane3AdoptInput();
    const deps = makeDeps({
      plan,
      entries,
      live: {
        // The worktree reports idle, but the run repository shows a live
        // other-attempt run: the slot stays spent whatever the worktree says.
        inspect: { state: 'idle' },
        runs: [runRecord(RUN_A, 'wo-9', ['attempt-other'])],
        runJournalFor: (runId: string) => (runId === RUN_A ? [conductEntry(RUN_A, 'running')] : []),
      },
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: inputs, adoptInputs: [adoptInput(), adopt3] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'active-run-cap-reached', laneId: 'lane-3' });
    // The handed-off result was still journaled for lane-2; lane-3 got nothing.
    expect(deps.appended!.map((entry) => [(entry as { reasonCode?: string }).reasonCode, entry.key])).toEqual([
      ['handed-off', key(digest, 'lane-2', 'redispatch')],
    ]);
    expect(deps.adoptLane).not.toHaveBeenCalled();
  });

  it('AR3b-3: a wave-2 completed redispatch with a matched non-terminal run and an idle worktree still counts toward the cap', async () => {
    const { plan, inputs } = handoffPlan(2);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
      result(key(digest, 'lane-2', 'redispatch'), 'completed'),
      ...completedSave(digest, 'lane-3', inputs[1]!),
    ];
    const adopt3 = lane3AdoptInput();
    const deps = makeDeps({
      plan,
      entries,
      live: {
        inspect: { state: 'idle' },
        runs: [runRecord(RUN_A, 'wo-9', ['attempt-1'])],
        runJournalFor: (runId: string) => (runId === RUN_A ? [conductEntry(RUN_A, 'running')] : []),
      },
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: inputs, adoptInputs: [adoptInput(), adopt3] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'active-run-cap-reached', laneId: 'lane-3' });
    // A completed redispatch is never re-journaled as handed-off.
    expect(deps.appended).toEqual([]);
  });

  it('AR3b-3b: AR3b-3 without lane-2\'s adopt input refuses stale-plan-state before the grant instead of admitting lane-3 past the cap', async () => {
    const { plan, inputs } = handoffPlan(2);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
      result(key(digest, 'lane-2', 'redispatch'), 'completed'),
      ...completedSave(digest, 'lane-3', inputs[1]!),
    ];
    const deps = makeDeps({
      plan,
      entries,
      live: {
        inspect: { state: 'idle' },
        runs: [runRecord(RUN_A, 'wo-9', ['attempt-1'])],
        runJournalFor: (runId: string) => (runId === RUN_A ? [conductEntry(RUN_A, 'running')] : []),
      },
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: inputs, adoptInputs: [lane3AdoptInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
    expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    expect(deps.adoptLane).not.toHaveBeenCalled();
    expect(deps.appended).toEqual([]);
  });

  it('AR3b-3c: a resent adopt input whose ids the journaled adopt digest does not reproduce refuses stale-plan-state before the grant; the true input is accepted', async () => {
    const { plan, inputs } = handoffPlan(2);
    const digest = plan.planDigest;
    const identityOf = (input: Record<string, unknown>): string => {
      const wo = input['workOrder'] as Record<string, unknown>;
      const brief = input['brief'] as Record<string, unknown>;
      const attempt = input['attempt'] as Record<string, unknown>;
      const run = input['run'] as Record<string, unknown>;
      return computeDigest(JSON.stringify([
        'adopt-lane-ids/1', 'proj-1', 'plan-1', 'lane-2', wo['workOrderId'], brief['briefId'], attempt['attemptId'], run['runId'],
      ]));
    };
    const trueInput = adoptInput();
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      intent(adoptKey(digest, 'lane-2', 'work-order'), identityOf(trueInput)),
      { ...result(adoptKey(digest, 'lane-2', 'work-order'), 'completed'), digest: identityOf(trueInput) },
      ...(['brief', 'attempt', 'run'] as const).flatMap((sub) => [
        intent(adoptKey(digest, 'lane-2', sub)),
        result(adoptKey(digest, 'lane-2', sub), 'completed'),
      ]),
      intent(key(digest, 'lane-2', 'redispatch')),
      result(key(digest, 'lane-2', 'redispatch'), 'completed'),
      ...completedSave(digest, 'lane-3', inputs[1]!),
    ];
    const live = {
      inspect: { state: 'idle' },
      runs: [runRecord(RUN_A, 'wo-9', ['attempt-1'])],
      runJournalFor: (runId: string) => (runId === RUN_A ? [conductEntry(RUN_A, 'running')] : []),
    };
    const forged = adoptInput({ workOrder: { ...(trueInput['workOrder'] as object), workOrderId: 'wo-other' } });
    const refusedDeps = makeDeps({ plan, entries, live });
    expect(
      await new ApplyRelaunchUseCase(refusedDeps).applyRelaunch(
        applyRequest(digest, { saveInputs: inputs, adoptInputs: [forged, lane3AdoptInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
    expect(refusedDeps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    // The true input reproduces the journaled digest, matches the live run and is counted: the cap holds.
    const trueDeps = makeDeps({ plan, entries, live });
    expect(
      await new ApplyRelaunchUseCase(trueDeps).applyRelaunch(
        applyRequest(digest, { saveInputs: inputs, adoptInputs: [trueInput, lane3AdoptInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'active-run-cap-reached', laneId: 'lane-3' });
  });

  it('AR3b-4: a failed handed-off append whose journal re-read shows the result completed continues; one that does not show completed refuses journal-write-failed', async () => {
    const { plan, inputs } = handoffPlan(2);
    const digest = plan.planDigest;
    const baseEntries = (): unknown[] => [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
      ...completedSave(digest, 'lane-3', inputs[1]!),
    ];
    const adopt3 = lane3AdoptInput();
    const handoffLive = {
      runs: [runRecord(RUN_A, 'wo-9', ['attempt-1'])],
      runJournalFor: (runId: string) => (runId === RUN_A ? [conductEntry(RUN_A, 'merged')] : []),
      adopt: lane3Adopted(),
    };
    // The append "lands elsewhere": the entry reaches the store the re-read
    // sees, while the append answer itself is a refusal.
    const racer = makeDeps({ plan, entries: baseEntries(), live: handoffLive });
    const racerAppend = racer.cutoverJournal.append as unknown as ReturnType<typeof vi.fn>;
    const racerOriginal = racerAppend.getMockImplementation() as (entry: Record<string, unknown>) => Promise<unknown>;
    racerAppend.mockImplementation(async (entry: Record<string, unknown>) => {
      const record = { ...entry, entryId: 'peer-1' };
      const outcome = await racerOriginal({ ...entry, outcome: entry.outcome ?? 'completed' });
      if (entry.key === key(digest, 'lane-2', 'redispatch')) {
        return { outcome: 'refused', reason: 'store-read-only', entry: record };
      }
      return outcome;
    });
    expect(
      await new ApplyRelaunchUseCase(racer).applyRelaunch(
        applyRequest(digest, { saveInputs: inputs, adoptInputs: [adoptInput(), adopt3] }),
      ),
    ).toMatchObject({ outcome: 'applied', wave: 2 });
    // The append truly failed and the store never saw the result: a refusal.
    const loser = makeDeps({ plan, entries: baseEntries(), live: { ...handoffLive, appendResults: [{ outcome: 'refused', reason: 'store-read-only' }] } });
    expect(
      await new ApplyRelaunchUseCase(loser).applyRelaunch(
        applyRequest(digest, { saveInputs: inputs, adoptInputs: [adoptInput(), adopt3] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'journal-write-failed', laneId: 'lane-2' });
  });

  it('AR3b-4b: a refused handed-off append whose journal re-read is unreadable refuses journal-unreadable', async () => {
    const { plan, inputs } = handoffPlan(2);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
      ...completedSave(digest, 'lane-3', inputs[1]!),
    ];
    const deps = makeDeps({
      plan,
      entries,
      live: {
        runs: [runRecord(RUN_A, 'wo-9', ['attempt-1'])],
        runJournalFor: (runId: string) => (runId === RUN_A ? [conductEntry(RUN_A, 'merged')] : []),
        adopt: lane3Adopted(),
        appendResults: [{ outcome: 'refused', reason: 'store-read-only' }],
      },
    });
    // The preflight read succeeds; the re-read after the refused append throws.
    const list = deps.cutoverJournal.listByKeyPrefix as unknown as ReturnType<typeof vi.fn>;
    const healthy = list.getMockImplementation() as (prefix: string) => Promise<unknown>;
    let reads = 0;
    list.mockImplementation(async (prefix: string) => {
      reads += 1;
      if (reads > 1) throw new Error('journal down');
      return healthy(prefix);
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { saveInputs: inputs, adoptInputs: [adoptInput(), lane3AdoptInput()] }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'journal-unreadable' });
    expect(reads).toBe(2);
  });

  it('AR3b-5: a hostile runRepo.list answer — throw, null, non-array, array-like, hole, over-sized, getter element, polluting key, two runs on one work order — refuses stale-plan-state before the grant is spent', async () => {
    const { plan, inputs } = handoffPlan(3);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
    ];
    const refused = async (runs: unknown): Promise<void> => {
      const deps = makeDeps({ plan, entries, live: { run: null, runs } });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(digest, { saveInputs: inputs }))).toEqual({
        outcome: 'refused', reason: 'stale-plan-state',
      });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    };
    // The runRepo.list() call itself throwing refuses before the grant.
    const runListThrowsDeps = makeDeps({ plan, entries, live: { run: null, runListThrows: true } });
    expect(
      await new ApplyRelaunchUseCase(runListThrowsDeps).applyRelaunch(applyRequest(digest, { saveInputs: inputs })),
    ).toEqual({ outcome: 'refused', reason: 'stale-plan-state' });
    expect(runListThrowsDeps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    await refused(null);
    await refused('not-an-array');
    // An array-like is not an array.
    await refused({ length: 1, 0: runRecord(RUN_A, 'wo-9', ['attempt-1']) });
    // A hole is not a run.
    const holed: unknown[] = [runRecord(RUN_A, 'wo-9', ['attempt-1'])];
    delete (holed as { 0?: unknown })[0];
    await refused(holed);
    // An over-sized list is refused in the bounded read (cap 512).
    await refused(new Array(513).fill(runRecord(RUN_A, 'wo-9', ['attempt-1'])));
    // An element whose field is an accessor is unreadable, so invalid.
    const getterRun = runRecord(RUN_A, 'wo-9', ['attempt-1']);
    Object.defineProperty(getterRun, 'workOrderId', {
      enumerable: true, configurable: true,
      get(): string {
        throw new Error('getter must never run');
      },
    });
    await refused([getterRun]);
    // A Proxy whose ownKeys trap throws is refused without running any get trap.
    await refused(new Proxy([runRecord(RUN_A, 'wo-9', ['attempt-1'])], {
      ownKeys(): ArrayLike<string | symbol> {
        throw new Error('trap must never be crossed');
      },
    }));
    // A polluting own key on the runs array is refused.
    await refused(withPollutingKey('__proto__', runRecord(RUN_A, 'wo-9', ['attempt-1'])));
    // More than one run matching the lane's work order id is a stale plan,
    // named by the lane.
    const doubled = makeDeps({
      plan, entries,
      live: { run: null, runs: [runRecord(RUN_A, 'wo-9', ['attempt-1']), runRecord(RUN_B, 'wo-9', ['attempt-1'])] },
    });
    expect(
      await new ApplyRelaunchUseCase(doubled).applyRelaunch(applyRequest(digest, { saveInputs: inputs })),
    ).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
    expect(doubled.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
  });

  it('AR3b-6: a hostile runJournal answer — throw, non-map, missing run id, malformed entry — refuses stale-plan-state before the grant is spent', async () => {
    const { plan, inputs } = handoffPlan(3);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
    ];
    const refused = async (over: Record<string, unknown>): Promise<void> => {
      const deps = makeDeps({ plan, entries, live: { run: null, runs: [runRecord(RUN_A, 'wo-9', ['attempt-1'])], ...over } });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(digest, { saveInputs: inputs }))).toEqual({
        outcome: 'refused', reason: 'stale-plan-state',
      });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    };
    await refused({ runJournalThrows: true });
    await refused({ runJournalResult: 'not-a-map' });
    await refused({ runJournalResult: new Map() }); // the matched run id is missing
    await refused({ runJournalResult: new Map([[RUN_A, [7]]]) }); // a malformed entry
    await refused({ runJournalResult: new Map([[RUN_A, new Array(201).fill(conductEntry(RUN_A, 'running'))]]) }); // over-sized
  });

  it('AR3b-11 (fix round 2): a journal answer that is only map-shaped — a Map.prototype child with own has/get accessors, an overridden method, or a Proxy get trap returning forged entries — refuses stale-plan-state before the grant is spent, and its own getter never runs (cost: O(1) prototype + two descriptor reads, O(1) per requested run id)', async () => {
    const { plan, inputs } = handoffPlan(3);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
    ];
    const refused = async (runJournalResult: unknown): Promise<void> => {
      const deps = makeDeps({
        plan, entries,
        live: { run: null, runs: [runRecord(RUN_A, 'wo-9', ['attempt-1'])], runJournalResult },
      });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(digest, { saveInputs: inputs }))).toEqual({
        outcome: 'refused', reason: 'stale-plan-state',
      });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    };
    // A map-shaped object with own `has`/`get` accessors: the accessor is
    // refused through its own descriptor, so the getter never runs.
    let getterReads = 0;
    const accessorMap = Object.create(Map.prototype, {
      [RUN_A]: { get(): unknown {
        getterReads += 1;
        return [conductEntry(RUN_A, 'running')];
      } },
    });
    Object.defineProperty(accessorMap, 'has', {
      enumerable: true, configurable: true,
      get(): unknown {
        getterReads += 1;
        return Map.prototype.has;
      },
    });
    await refused(accessorMap);
    expect(getterReads).toBe(0);
    // A map-shaped object whose `get` is an own override supplying a forged
    // entry list is refused the same way: the override never runs.
    let overrideReads = 0;
    const forged = Object.create(Map.prototype, {
      has: { value: Map.prototype.has },
      get: { value(): unknown {
        overrideReads += 1;
        return [conductEntry(RUN_A, 'running')];
      } },
    });
    await refused(forged);
    expect(overrideReads).toBe(0);
    // A Proxy over a genuine Map whose `get` trap returns a forged entry
    // list is refused too: the genuine method invocation fails the Proxy's
    // missing internal slot, so the trap is never consulted.
    let trapReads = 0;
    const trapped = new Proxy(new Map([[RUN_A, [conductEntry(RUN_A, 'running')]]]), {
      get(target, property, receiver): unknown {
        // An `await` of a promise resolving to the proxy reads `then`
        // through the trap; only a forged `get`/`has` read would matter.
        if (property === 'get' || property === 'has') {
          trapReads += 1;
          return () => [conductEntry(RUN_A, 'running')];
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await refused(trapped);
    expect(trapReads).toBe(0);
  });

  it('AR3b-9 (fix round 1): a run record outside the full LaneRunRecord grammar — a wrong version, a string attemptIds, an extra own key, a polluting own key — refuses stale-plan-state before the grant is spent (cost: one bounded full-record validation per run, O(runs))', async () => {
    const { plan, inputs } = handoffPlan(3);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
    ];
    const refused = async (runs: unknown): Promise<void> => {
      const deps = makeDeps({ plan, entries, live: { run: null, runs } });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(digest, { saveInputs: inputs }))).toEqual({
        outcome: 'refused', reason: 'stale-plan-state',
      });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    };
    // The record's version is part of the grammar: a wrong one is malformed.
    await refused([{ ...runRecord(RUN_A, 'wo-9', ['attempt-1']), version: 2 }]);
    // A string attemptIds is not the record's array grammar, however it is spelled.
    await refused([{ ...runRecord(RUN_A, 'wo-9', []), attemptIds: 'attempt-1' }]);
    // Any extra own key beyond the record's keys is refused.
    await refused([{ ...runRecord(RUN_A, 'wo-9', ['attempt-1']), extra: true }]);
    // A polluting own key (`prototype`, `constructor`) is refused the same way.
    await refused([{ ...runRecord(RUN_A, 'wo-9', ['attempt-1']), prototype: {} }]);
    await refused([{ ...runRecord(RUN_A, 'wo-9', ['attempt-1']), constructor: {} }]);
  });

  it('AR3b-10 (fix round 1): a Proxy run record whose getPrototypeOf or getOwnPropertyDescriptor trap throws, and a Proxy journal Map whose has or get trap throws, refuse stale-plan-state before the grant is spent (cost: the throws are caught, never propagated)', async () => {
    const { plan, inputs } = handoffPlan(3);
    const digest = plan.planDigest;
    const entries = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      intent(key(digest, 'lane-2', 'redispatch')),
    ];
    const refused = async (runs: unknown, runJournalResult?: unknown): Promise<void> => {
      const deps = makeDeps({
        plan, entries,
        live: { run: null, runs, ...(runJournalResult !== undefined ? { runJournalResult } : {}) },
      });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(digest, { saveInputs: inputs }))).toEqual({
        outcome: 'refused', reason: 'stale-plan-state',
      });
      expect(deps.authorization!.authorizeRelaunchApply).not.toHaveBeenCalled();
    };
    const trap = (): never => {
      throw new Error('trap must never be crossed');
    };
    // A Proxy whose getPrototypeOf trap throws on the record itself is caught.
    await refused([new Proxy(runRecord(RUN_A, 'wo-9', ['attempt-1']), { getPrototypeOf: trap })]);
    // A Proxy whose getOwnPropertyDescriptor trap throws on a run-record field is caught.
    await refused([new Proxy(runRecord(RUN_A, 'wo-9', ['attempt-1']), { getOwnPropertyDescriptor: trap })]);
    // A journal Map whose has trap throws is a malformed answer, not a rejection.
    await refused(
      [runRecord(RUN_A, 'wo-9', ['attempt-1'])],
      new Proxy(new Map([[RUN_A, [conductEntry(RUN_A, 'running')]]]), { has: trap }),
    );
    // A journal Map whose get trap throws is refused the same way.
    await refused(
      [runRecord(RUN_A, 'wo-9', ['attempt-1'])],
      new Proxy(new Map([[RUN_A, [conductEntry(RUN_A, 'running')]]]), { get: trap }),
    );
  });

  it('AR3b-7: a redispatch already refused or ambiguous refuses stale-plan-state, and an inconsistent one refuses step-inconsistent, in both cases without any append', async () => {
    const { plan, inputs } = handoffPlan(3);
    const digest = plan.planDigest;
    const head = [
      ...completedSave(digest, 'lane-2', inputs[0]!),
      ...completedAdopt(digest, 'lane-2', adoptInput()),
      ...completedSave(digest, 'lane-3', inputs[1]!),
    ];
    const fullRequest = (): unknown =>
      applyRequest(digest, { saveInputs: inputs, adoptInputs: [adoptInput(), lane3AdoptInput()] });
    for (const [outcome, reason] of [['refused', 'stale-plan-state'], ['ambiguous', 'stale-plan-state']] as const) {
      const deps = makeDeps({
        plan,
        entries: [...head, intent(key(digest, 'lane-2', 'redispatch')), result(key(digest, 'lane-2', 'redispatch'), outcome)],
        live: { run: null, runs: [] },
      });
      expect(await new ApplyRelaunchUseCase(deps).applyRelaunch(fullRequest())).toEqual({
        outcome: 'refused', reason, laneId: 'lane-2',
      });
      expect(deps.appended).toEqual([]);
    }
    // A result without its intent is an inconsistent ledger.
    const inconsistent = makeDeps({
      plan,
      entries: [...head, result(key(digest, 'lane-2', 'redispatch'), 'completed')],
      live: { run: null, runs: [] },
    });
    expect(await new ApplyRelaunchUseCase(inconsistent).applyRelaunch(fullRequest())).toEqual({
      outcome: 'refused', reason: 'step-inconsistent', laneId: 'lane-2',
    });
    expect(inconsistent.appended).toEqual([]);
  });

  it('AR3b-8: a deadline that expires during the save intent append refuses budget-exhausted before saveLaneEdits runs', async () => {
    const plan = livePlan('intent-deadline plan');
    const digest = plan.planDigest;
    let now = CLOCK_NOW;
    const deps = makeDeps({ plan, clock: () => now, live: {} });
    (deps.cutoverJournal.append as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (entry: Record<string, unknown>) => {
      if (entry.key === key(digest, 'lane-2', 'save') && entry.kind === 'intent') now = PAST_DEADLINE;
      return { outcome: 'appended', entry: { ...entry, entryId: 'entry-x' } };
    });
    expect(
      await new ApplyRelaunchUseCase(deps).applyRelaunch(
        applyRequest(digest, { deadlineIso: DEADLINE }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(deps.saveLaneEdits).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// AR3d — the end-attempt transition. An `attempt-recorded` running lane whose
// `AttemptRecord` is still `running` must be transitioned to `ended`/`partial`
// at the apply's own save commit, through a journaled `relaunch/<digest>/
// <lane>/end-attempt` step, before `adoptLane` will accept it. These tests use
// the real `AdoptLaneUseCase` with in-memory `AttemptRepositoryAdapter`,
// `WorkOrderRepositoryAdapter`, `LaneRunRepositoryAdapter`,
// `LaneRunJournalAdapter` and `CutoverJournalAdapter` — no direct store writes
// in a test body after the initial fixture setup — so the transition is proved
// end to end. Hostile `AttemptRecord` answers are read through their own
// property descriptors only: a counting getter must never run (reads === 0).
// Each case would fail against a constant or an identity implementation: the
// refusals differ per reason, the record revisions differ per scenario and the
// journal ledger states differ per crash point.
// ---------------------------------------------------------------------------

describe('AR3d — end-attempt transition on relaunch adopt', () => {
  const COMMIT = 'c'.repeat(64);
  const TREE = 'd'.repeat(64);
  const BASE = 'b'.repeat(64);
  const BRIEF_DIGEST = hex('do the thing');
  const SAVE_REF = 'refs/fleet/saved/lane-2';
  const endKeyOf = (digest: string): string => `relaunch/${digest}/lane-2/end-attempt`;
  const saveKeyOf = (digest: string): string => `relaunch/${digest}/lane-2/save`;
  const abortKeyOf = (digest: string): string => `relaunch/${digest}/lane-2/abort`;

  /** A ULID-shaped entry id: 26 chars over the Crockford base32 alphabet. */
  const ulid = (index: number): string => `01${'A'.repeat(21)}${String(index).padStart(3, '0')}`;

  /** A fresh `running` attempt record matching the lane's save input. */
  const runningAttemptRecord = (over: Record<string, unknown> = {}): AttemptRecord =>
    ({
      id: 'attempt-1',
      workOrderId: 'wo-9',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/wt/lane-2',
      baseCommit: BASE,
      state: 'running',
      outcome: null,
      briefDigest: BRIEF_DIGEST,
      briefPackagePath: 'brief/manifest.json',
      sessionId: null,
      completionReceipt: null,
      artifacts: { headCommit: BASE, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'missing' },
      reviewerSeat: null,
      createdAtIso: BEFORE_DEADLINE,
      updatedAtIso: BEFORE_DEADLINE,
      ...over,
    }) as unknown as AttemptRecord;

  const attemptRecordedLane = (laneId = 'lane-2', attemptId = 'attempt-1'): FixtureLane => ({
    ...runningLane('ar3d-seed', laneId),
    population: 'attempt-recorded' as unknown as FixtureLane['population'],
    attemptId,
    workOrderId: 'wo-9',
  });

  interface RealHarness {
    plan: RelaunchPlanRecord;
    digest: string;
    deps: Deps & { attemptRepo?: Pick<AttemptRepositoryPort, 'findAttemptById' | 'saveAttempt'> };
    cutover: CutoverJournalAdapter;
    attemptRepo: AttemptRepositoryAdapter;
    saveSpy: { calls: number };
  }

  /**
   * The AR3d environment: one real in-memory adapter set shared by the apply
   * and the real `AdoptLaneUseCase`, a fake save port that journals the save
   * result into the shared journal (as the real `SaveLaneEditsUseCase` does),
   * and a counting `saveAttempt` wrapper. Fixture writes (the seeded record
   * and any crash seeding) happen here, never in a test body.
   */
  const makeRealHarness = async (over: {
    plan?: RelaunchPlanRecord;
    live?: LiveOver;
    record?: Record<string, unknown> | null;
    conflict?: boolean;
    stubAdopt?: boolean;
    clock?: () => string;
  } = {}): Promise<RealHarness> => {
    const plan = over.plan ?? buildPlan([conductedLaneWithRun(), attemptRecordedLane()]);
    const live = over.live ?? {};
    const cutover = new CutoverJournalAdapter();
    const attemptRepo = new AttemptRepositoryAdapter();
    const workOrderRepo = new WorkOrderRepositoryAdapter();
    const runRepo = new LaneRunRepositoryAdapter();
    const runJournal = new LaneRunJournalAdapter();
    let entryCounter = 0;
    const nextEntryId = (): string => ulid((entryCounter += 1));
    const adoptLaneUseCase = new AdoptLaneUseCase({
      workOrderRepo,
      attemptRepo,
      runRepo,
      runJournal,
      cutoverJournal: cutover,
      computeDigest,
      mintEntryId: nextEntryId,
      now: () => CLOCK_NOW,
    });
    const deps = makeDeps({
      plan,
      ...(over.clock === undefined ? {} : { clock: over.clock }),
      live: { ...live, noAppend: true, noMint: true },
    }) as unknown as RealHarness['deps'];
    const holder = deps as unknown as Record<string, unknown>;
    // One shared journal: the apply, the fake save port and the real adopt
    // all read and append through the same in-memory `CutoverJournalAdapter`.
    holder['cutoverJournal'] = cutover;
    holder['mintEntryId'] = nextEntryId;
    holder['adoptLane'] =
      over.stubAdopt === true
        ? vi.fn(async () => ({ outcome: 'refused', reason: 'invalid-request' }))
        : adoptLaneUseCase.adoptLane.bind(adoptLaneUseCase);
    const saveSpy = { calls: 0 };
    holder['attemptRepo'] = {
      findAttemptById: (id: string) => attemptRepo.findAttemptById(id),
      saveAttempt: async (record: AttemptRecord) => {
        saveSpy.calls += 1;
        if (over.conflict === true) {
          // A concurrent writer wins the compare-and-swap first with a
          // legitimate ended record, so this writer's next revision is stale.
          await attemptRepo.saveAttempt({
            ...record,
            state: 'ended',
            outcome: 'partial',
            revision: record.revision ?? 1,
            artifacts: { headCommit: BASE, commitsSinceBase: [], collectedArtifactPaths: [], notes: 'missing' },
          });
        }
        await attemptRepo.saveAttempt(record);
      },
    };
    holder['saveLaneEdits'] = vi.fn(async (request: unknown) => {
      if (live.saveThrows) throw new Error('save down');
      if (live.save !== undefined) return live.save;
      const req = request as { planDigest?: string; laneId?: string };
      const append = await cutover.append({
        key: `relaunch/${req.planDigest}/${req.laneId}/save`,
        kind: 'result',
        entryId: nextEntryId(),
        recordedAtIso: CLOCK_NOW,
        outcome: 'completed',
        reasonCode: 'saved',
        digest: TREE,
        commitId: COMMIT,
        saveRef: SAVE_REF,
      });
      if (append.outcome !== 'appended') return { outcome: 'refused', reason: 'journal-write-failed' };
      return { outcome: 'saved', saveRef: SAVE_REF, commitId: COMMIT, treeDigest: TREE };
    }) as unknown as Deps['saveLaneEdits'];
    if (over.record !== null) {
      // Fixture setup only: seed the running attempt the lane relaunched from.
      await attemptRepo.saveAttempt(runningAttemptRecord(over.record ?? {}));
    }
    return { plan, digest: plan.planDigest, deps, cutover, attemptRepo, saveSpy };
  };


  const journalEntries = async (
    harness: RealHarness,
  ): Promise<
    readonly { key: string; kind: string; outcome?: unknown; reasonCode?: unknown; commitId?: unknown }[]
  > => {
    const listed = await harness.cutover.listByKeyPrefix('');
    return listed.outcome === 'listed' ? listed.entries : [];
  };

  const storedRecord = async (harness: RealHarness): Promise<unknown> =>
    harness.attemptRepo.findAttemptById('attempt-1');

  it('AR3d-happy-path: an attempt-recorded running lane is transitioned to ended/partial at the apply\u2019s own save commit and adopted — the apply applies, the record is revision 1 with headCommit === saveCommit, and the journal holds the end-attempt intent and completed result', async () => {
    const harness = await makeRealHarness();
    const applied = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(applied.outcome).toBe('applied');
    const record = (await storedRecord(harness)) as AttemptRecord;
    expect(record.state).toBe('ended');
    expect(record.outcome).toBe('partial');
    expect(record.revision).toBe(1);
    expect(record.artifacts?.headCommit).toBe(COMMIT);
    expect(harness.saveSpy.calls).toBe(1);
    const endEntries = (await journalEntries(harness)).filter((entry) => entry.key === endKeyOf(harness.digest));
    expect(endEntries.map((entry) => [entry.kind, entry.outcome, entry.reasonCode])).toEqual([
      ['intent', undefined, undefined],
      ['result', 'completed', 'attempt-ended'],
    ]);
    expect(endEntries[1]?.commitId).toBe(COMMIT);
  });

  it('AR3d-preserves-unchecked-fields: the transition keeps the stored sessionId and dispatchRevision of the running record while ending it', async () => {
    const harness = await makeRealHarness({ record: runningAttemptRecord({ sessionId: 'ses-keep-1', dispatchRevision: 3 }) as unknown as Record<string, unknown> });
    const applied = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(applied.outcome).toBe('applied');
    const record = (await storedRecord(harness)) as AttemptRecord;
    expect(record.state).toBe('ended');
    expect(record.sessionId).toBe('ses-keep-1');
    expect(record.dispatchRevision).toBe(3);
  });

  it('AR3d-happy-path-replay: re-applying a fully completed lane runs saveAttempt exactly once across both calls and stays applied', async () => {
    const harness = await makeRealHarness();
    const useCase = new ApplyRelaunchUseCase(harness.deps);
    expect((await useCase.applyRelaunch(applyRequest(harness.digest))).outcome).toBe('applied');
    const second = await useCase.applyRelaunch(applyRequest(harness.digest));
    expect(second.outcome).toBe('applied');
    expect((second as { wave?: unknown }).wave).toBe(null);
    expect(harness.saveSpy.calls).toBe(1);
    expect(((await storedRecord(harness)) as AttemptRecord).revision).toBe(1);
  });

  it('AR3d-crash-replay-result-append-failed: a journaled end-attempt intent whose result append failed after the write is replayed — the apply completes with saveAttempt run exactly once across both calls', async () => {
    const harness = await makeRealHarness();
    // Crash simulation: the first apply fails when the end-attempt result
    // append refuses, after the intent and the record write landed.
    const real = harness.cutover.append.bind(harness.cutover);
    harness.deps.cutoverJournal.append = (async (entry: Record<string, unknown>) => {
      if (entry.key === endKeyOf(harness.digest) && entry.kind === 'result') {
        return { outcome: 'refused', reason: 'store-unreadable' } as never;
      }
      return real(entry as never);
    }) as unknown as Deps['cutoverJournal']['append'];
    const first = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(first).toEqual({ outcome: 'refused', reason: 'journal-write-failed', laneId: 'lane-2' });
    expect(harness.saveSpy.calls).toBe(1);
    // The retry: the ledger holds intent-only, the record is already ended at
    // the save commit, so the wave completes without a second write.
    harness.deps.cutoverJournal.append = real as unknown as Deps['cutoverJournal']['append'];
    const second = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(second.outcome).toBe('applied');
    expect(harness.saveSpy.calls).toBe(1);
    expect(((await storedRecord(harness)) as AttemptRecord).revision).toBe(1);
  });

  it('AR3d-crash-replay-after-write: an attempt already ended/partial at the save commit is never written again — the apply completes from the stored record with an already-ended result', async () => {
    const harness = await makeRealHarness({
      record: {
        state: 'ended',
        outcome: 'partial',
        revision: 3,
        artifacts: { headCommit: COMMIT, commitsSinceBase: [COMMIT], collectedArtifactPaths: [], notes: 'missing' },
      },
    });
    const applied = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(applied.outcome).toBe('applied');
    expect(harness.saveSpy.calls).toBe(0);
    expect(((await storedRecord(harness)) as AttemptRecord).revision).toBe(3);
    const endEntries = (await journalEntries(harness)).filter((entry) => entry.key === endKeyOf(harness.digest));
    expect(endEntries.map((entry) => [entry.kind, entry.outcome, entry.reasonCode])).toEqual([
      ['intent', undefined, undefined],
      ['result', 'completed', 'already-ended'],
    ]);
  });

  it('AR3d-different-attempt-id: an adopt input naming another attempt refuses stale-plan-state and leaves the running record untouched', async () => {
    const harness = await makeRealHarness({ stubAdopt: true });
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(
      applyRequest(harness.digest, {
        adoptInputs: [adoptInput({ attempt: { attemptId: 'attempt-9', endedAtIso: CLOCK_NOW, sessionId: null } })],
      }),
    );
    expect(refused).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
    expect(harness.saveSpy.calls).toBe(0);
    expect(((await storedRecord(harness)) as AttemptRecord).state).toBe('running');
  });

  it('AR3d-foreign-lane-attempt-id: a lane whose own attemptId differs from the save input refuses stale-plan-state in the preflight, before the save, the abort or any write', async () => {
    const harness = await makeRealHarness({
      stubAdopt: true,
      plan: buildPlan([conductedLaneWithRun(), attemptRecordedLane('lane-2', 'attempt-foreign')]),
    });
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(refused).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
    expect(harness.deps.saveLaneEdits).not.toHaveBeenCalled();
    expect(harness.deps.runner!.abortWorktreeRun).not.toHaveBeenCalled();
    expect(harness.saveSpy.calls).toBe(0);
    expect(((await storedRecord(harness)) as AttemptRecord).state).toBe('running');
  });

  it('AR3d-mismatched-worktree-path: a stored record whose worktreePath differs from the save input refuses adopt-failed in the preflight, before the save, the abort or any write', async () => {
    const harness = await makeRealHarness({ stubAdopt: true, record: { worktreePath: '/wt/somewhere-else' } });
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(refused).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(harness.deps.saveLaneEdits).not.toHaveBeenCalled();
    expect(harness.deps.runner!.abortWorktreeRun).not.toHaveBeenCalled();
    expect(harness.saveSpy.calls).toBe(0);
    expect(((await storedRecord(harness)) as AttemptRecord).state).toBe('running');
  });

  it('AR3d-abort-failure-leaves-running: a failed abort refuses abort-failed and the attempt stays running with its original revision', async () => {
    const harness = await makeRealHarness({
      stubAdopt: true,
      live: { abortThrows: true, terminate: { outcome: 'refused' } },
    });
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(refused).toEqual({ outcome: 'refused', reason: 'abort-failed', laneId: 'lane-2' });
    const record = (await storedRecord(harness)) as AttemptRecord;
    expect(record.state).toBe('running');
    expect(record.revision).toBe(0);
    expect(harness.saveSpy.calls).toBe(0);
  });

  it('AR3d-revision-conflict: a concurrent saveAttempt between the read and the write refuses adopt-failed, journals a refused end-attempt result and never clobbers the concurrent record', async () => {
    const harness = await makeRealHarness({ stubAdopt: true, conflict: true });
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(refused).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    const record = (await storedRecord(harness)) as AttemptRecord;
    // The concurrent writer's record stands, not the stale write's.
    expect(record.revision).toBe(1);
    expect(record.artifacts?.headCommit).toBe(BASE);
    const endEntries = (await journalEntries(harness)).filter((entry) => entry.key === endKeyOf(harness.digest));
    expect(endEntries.map((entry) => [entry.kind, entry.outcome, entry.reasonCode])).toEqual([
      ['intent', undefined, undefined],
      ['result', 'refused', 'attempt-revision-conflict'],
    ]);
  });

  it('AR3d-hostile-attempt-record: an undefined, primitive, accessor-bearing, polluting-key, Proxy-throwing, bad-revision or wrong-id attempt record refuses adopt-failed with zero getter invocations and no write', async () => {
    const getterCalls = { count: 0 };
    const withGetter = getterOn(runningAttemptRecord() as unknown as object, 'workOrderId', getterCalls);
    // An own `__proto__` data key (a literal would set the prototype instead).
    const polluting = JSON.parse('{"__proto__": {"hijacked": true}, "id": "attempt-1"}') as Record<string, unknown>;
    // The `ownKeys` trap throws; `then` stays readable so the await itself succeeds.
    const throwingProxy = new Proxy(runningAttemptRecord(), {
      ownKeys() {
        throw new Error('proxy trap');
      },
    });
    const cases: Record<string, () => unknown> = {
      undefined: () => undefined,
      primitive: () => 7,
      'accessor-bearing': () => withGetter,
      'polluting-key': () => polluting,
      'throwing-proxy': () => throwingProxy,
      'bad-revision': () => runningAttemptRecord({ revision: 1.5 }),
      'wrong-id': () => runningAttemptRecord({ id: 'attempt-2' }),
    };
    for (const [name, answer] of Object.entries(cases)) {
      const harness = await makeRealHarness({ stubAdopt: true });
      harness.deps.attemptRepo = {
        findAttemptById: async () => answer() as unknown,
        saveAttempt: async () => {
          harness.saveSpy.calls += 1;
        },
      } as unknown as Pick<AttemptRepositoryPort, 'findAttemptById' | 'saveAttempt'>;
      const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
      expect(refused, name).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
      expect(harness.saveSpy.calls, name).toBe(0);
      expect(harness.deps.adoptLane, name).not.toHaveBeenCalled();
    }
    expect(getterCalls.count).toBe(0);
    expect((Object.prototype as Record<string, unknown>)['hijacked']).toBeUndefined();
  });

  it('AR3d-save-mismatch-no-transition: an adopt input whose source commit differs from the apply\u2019s own save result refuses adopt-failed without transitioning the attempt', async () => {
    const harness = await makeRealHarness({ stubAdopt: true });
    const mismatched = adoptInput({
      source: { kind: 'save-ref', saveRef: SAVE_REF, commitOid: 'e'.repeat(64), treeDigest: TREE },
    });
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(
      applyRequest(harness.digest, { adoptInputs: [mismatched] }),
    );
    expect(refused).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(harness.saveSpy.calls).toBe(0);
    expect(((await storedRecord(harness)) as AttemptRecord).state).toBe('running');
  });

  it('AR3d-non-running-or-mismatch-refuses: an ended/failed record, an ended/partial record at another commit, and a record with a mismatched brief digest or work order refuse adopt-failed without overwriting', async () => {
    const cases: Record<string, Record<string, unknown>> = {
      'ended-failed': { state: 'ended', outcome: 'failed', revision: 2 },
      'ended-partial-other-commit': {
        state: 'ended',
        outcome: 'partial',
        revision: 2,
        artifacts: { headCommit: '9'.repeat(64), commitsSinceBase: [], collectedArtifactPaths: [], notes: 'missing' },
      },
      'brief-mismatch': { briefDigest: hex('a different brief') },
      'work-order-mismatch': { workOrderId: 'wo-elsewhere' },
    };
    for (const [name, over] of Object.entries(cases)) {
      const harness = await makeRealHarness({ stubAdopt: true, record: over });
      const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
      expect(refused, name).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
      expect(harness.saveSpy.calls, name).toBe(0);
      expect(((await storedRecord(harness)) as AttemptRecord).revision, name).toBe(over.revision ?? 0);
    }
  });

  it('AR3d-refusal-missing-attempt-repo: an attempt-recorded lane without an attempt repo refuses stale-plan-state before the grant is spent', async () => {
    const harness = await makeRealHarness({ stubAdopt: true });
    delete (harness.deps as unknown as Record<string, unknown>)['attemptRepo'];
    const authorize = harness.deps.authorization?.authorizeRelaunchApply as unknown as ReturnType<typeof vi.fn>;
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(refused).toEqual({ outcome: 'refused', reason: 'stale-plan-state', laneId: 'lane-2' });
    expect(authorize).not.toHaveBeenCalled();
    expect(harness.saveSpy.calls).toBe(0);
  });

  it('AR3d-crash-replay-before-write: an end-attempt intent journaled before a failed write leaves the record running, and the retry writes it exactly once', async () => {
    const harness = await makeRealHarness();
    let attempts = 0;
    harness.deps.attemptRepo = {
      findAttemptById: (id: string) => harness.attemptRepo.findAttemptById(id),
      saveAttempt: async (record: AttemptRecord) => {
        attempts += 1;
        if (attempts === 1) throw new Error('store down');
        harness.saveSpy.calls += 1;
        await harness.attemptRepo.saveAttempt(record);
      },
    };
    const first = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(first).toEqual({ outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' });
    expect(((await storedRecord(harness)) as AttemptRecord).state).toBe('running');
    const ledger = (await journalEntries(harness)).filter((entry) => entry.key === endKeyOf(harness.digest));
    expect(ledger.map((entry) => entry.kind)).toEqual(['intent']);
    const second = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(second.outcome).toBe('applied');
    expect(harness.saveSpy.calls).toBe(1);
    const record = (await storedRecord(harness)) as AttemptRecord;
    expect([record.state, record.revision]).toEqual(['ended', 1]);
  });

  it('AR3d-budget-spent-during-transition: a deadline that expires while the attempt is being written refuses budget-exhausted and never reaches adoptLane', async () => {
    const spent = { afterWrite: false };
    const harness = await makeRealHarness({ stubAdopt: true, clock: () => (spent.afterWrite ? PAST_DEADLINE : CLOCK_NOW) });
    const inner = harness.deps.attemptRepo!;
    harness.deps.attemptRepo = {
      findAttemptById: (id: string) => inner.findAttemptById(id),
      saveAttempt: async (record: AttemptRecord) => {
        await inner.saveAttempt(record);
        spent.afterWrite = true;
      },
    };
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(
      applyRequest(harness.digest, { deadlineIso: DEADLINE }),
    );
    expect(refused).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(harness.saveSpy.calls).toBe(1);
    expect(harness.deps.adoptLane).not.toHaveBeenCalled();
  });

  it('AR3d-budget-exhausted: an expired deadline refuses budget-exhausted before any attempt write or grant use', async () => {
    const harness = await makeRealHarness({ stubAdopt: true, clock: () => PAST_DEADLINE });
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(
      applyRequest(harness.digest, { deadlineIso: DEADLINE }),
    );
    expect(refused).toEqual({ outcome: 'refused', reason: 'budget-exhausted' });
    expect(harness.saveSpy.calls).toBe(0);
    expect(((await storedRecord(harness)) as AttemptRecord).state).toBe('running');
  });

  it('AR3d-journal-write-failed: a refused end-attempt intent append refuses journal-write-failed with the record untouched', async () => {
    const harness = await makeRealHarness({ stubAdopt: true });
    const real = harness.cutover.append.bind(harness.cutover);
    harness.deps.cutoverJournal.append = (async (entry: Record<string, unknown>) => {
      if (entry.key === endKeyOf(harness.digest) && entry.kind === 'intent') {
        return { outcome: 'refused', reason: 'duplicate-intent' } as never;
      }
      return real(entry as never);
    }) as unknown as Deps['cutoverJournal']['append'];
    const refused = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(refused).toEqual({ outcome: 'refused', reason: 'journal-write-failed', laneId: 'lane-2' });
    expect(harness.saveSpy.calls).toBe(0);
    expect(((await storedRecord(harness)) as AttemptRecord).state).toBe('running');
  });

  it('AR3d-end-attempt-ledger-refusal: an end-attempt ledger already refused refuses adopt-failed, and a result recorded without its intent refuses step-inconsistent — neither writes', async () => {
    const plan = buildPlan([conductedLaneWithRun(), attemptRecordedLane()]);
    const digest = plan.planDigest;
    const cases: Record<string, { entries: unknown[]; expected: Record<string, unknown> }> = {
      refused: {
        entries: [intent(endKeyOf(digest)), { ...result(endKeyOf(digest), 'refused'), reasonCode: 'simulated-refusal' }],
        expected: { outcome: 'refused', reason: 'adopt-failed', laneId: 'lane-2' },
      },
      inconsistent: {
        entries: [{ ...result(endKeyOf(digest), 'completed'), commitId: COMMIT }],
        expected: { outcome: 'refused', reason: 'step-inconsistent', laneId: 'lane-2' },
      },
    };
    for (const [name, testCase] of Object.entries(cases)) {
      const seeded = [
        intent(saveKeyOf(digest), saveInputDigest(digest, saveInput())),
        {
          ...result(saveKeyOf(digest), 'completed'),
          digest: TREE,
          commitId: COMMIT,
          saveRef: SAVE_REF,
        },
        intent(abortKeyOf(digest)),
        result(abortKeyOf(digest), 'completed'),
        ...testCase.entries,
      ];
      const deps = makeDeps({
        plan,
        entries: seeded,
        live: { noMint: true },
      }) as unknown as RealHarness['deps'];
      const saveSpy = { calls: 0 };
      (deps as unknown as Record<string, unknown>)['attemptRepo'] = {
        findAttemptById: async () => runningAttemptRecord(),
        saveAttempt: async () => {
          saveSpy.calls += 1;
        },
      };
      (deps as unknown as Record<string, unknown>)['adoptLane'] = vi.fn(async () => ({
        outcome: 'refused',
        reason: 'invalid-request',
      }));
      (deps as unknown as Record<string, unknown>)['mintEntryId'] = () => ulid(1);
      const refused = await new ApplyRelaunchUseCase(deps).applyRelaunch(applyRequest(digest));
      expect(refused, name).toEqual(testCase.expected);
      expect(saveSpy.calls, name).toBe(0);
    }
  });

  it('AR3d-unrecorded-lane: an unrecorded running lane over the same real adapters still applies on a valid save — the empty attempt store is a no-op and the adopt records its own attempt', async () => {
    const harness = await makeRealHarness({
      plan: buildPlan([conductedLaneWithRun(), runningLane(hex('AR3d unrecorded plan'))]),
      record: null,
    });
    const applied = await new ApplyRelaunchUseCase(harness.deps).applyRelaunch(applyRequest(harness.digest));
    expect(applied.outcome).toBe('applied');
    expect(harness.saveSpy.calls).toBe(0);
    // The adopt created its own ended/partial attempt record at the save commit.
    const adopted = (await harness.attemptRepo.findAttemptById('attempt-1')) as AttemptRecord | null;
    expect(adopted?.state).toBe('ended');
    expect(adopted?.outcome).toBe('partial');
    expect(adopted?.artifacts?.headCommit).toBe(COMMIT);
  });
});
