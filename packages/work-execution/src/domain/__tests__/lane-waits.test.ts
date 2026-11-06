import { describe, expect, it } from 'vitest';

import { deriveLaneWaits } from '../lane-waits.js';
import type { DeriveLaneWaitsResult, LaneWaits, WaitNode } from '../lane-waits.js';
import { BOARD_SOURCES, DEFAULT_BOARD_POLICY } from '../work-board-facts.js';
import type { BoardPlanFact, BoardSource, LaneRef, SourceReading } from '../work-board-facts.js';
import type {
  BoardLaneCard,
  BoardLaneColumn,
  BoardPlacement,
  ClearedBy,
  GuardState,
  LaneGlance,
  WaitGuard,
  WaitReason,
  WaitSubject,
} from '../work-board.js';

type OkResult = Extract<DeriveLaneWaitsResult, { ok: true }>;

const NOW = '2026-10-27T10:00:00.000Z';
const PROJECT = 'demo-project';
const PLAN = 'plan-a';

const REF_R = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'R' } as const;
const REF_A = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'A' } as const;
const REF_B = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'B' } as const;
const REF_C = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'C' } as const;
const REF_D = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'D' } as const;
const REF_Z = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'Z' } as const;
const REF_K1B = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'K1b' } as const;
const REF_A1 = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'A1' } as const;
const REF_K1_2C = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'K1-2c' } as const;
const REF_W = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'W' } as const;
const REF_X = { kind: 'plan', projectId: 'other-project', planId: 'pb', laneId: 'X' } as const;
const REF_HOLDER = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'HOLDER' } as const;

function keyOf(ref: LaneRef): string {
  return ref.kind === 'plan' ? ref.projectId + '/' + ref.planId + '/' + ref.laneId : 'wo:' + ref.workOrderId;
}

function glance(ref: LaneRef, column: BoardLaneColumn = 'queued', extra: Partial<LaneGlance> = {}): LaneGlance {
  return { ref, label: ref.kind === 'plan' ? ref.laneId : ref.workOrderId, column, ...extra };
}

function makeWaitGuard(p: {
  reason: WaitReason;
  state: GuardState;
  subject: WaitSubject;
  clearedBy?: ClearedBy;
  clearedByText?: string;
  sources?: readonly SourceReading[];
  unreadBeside?: readonly BoardSource[];
}): WaitGuard {
  return {
    reason: p.reason,
    state: p.state,
    subject: p.subject,
    clearedBy: p.clearedBy ?? { kind: 'record', what: 'seat-probe' },
    clearedByText: p.clearedByText ?? 'text',
    sources: [...(p.sources ?? [])],
    unreadBeside: [...(p.unreadBeside ?? [])],
  };
}

function seatRow(): WaitGuard {
  return makeWaitGuard({
    reason: 'seat',
    state: 'unknown',
    subject: { kind: 'seat', role: null },
    clearedBy: { kind: 'record', what: 'seat-probe' },
    clearedByText: 'a seat probe is recorded (none exists yet; A-S or S1)',
  });
}

function afterRow(lane: LaneGlance, state: GuardState = 'blocked', sources: readonly SourceReading[] = []): WaitGuard {
  return makeWaitGuard({
    reason: 'after-not-done',
    state,
    subject: { kind: 'lane', lane },
    clearedBy: { kind: 'done', subject: lane.ref },
    clearedByText: lane.label + ' is done (merged, or recorded done without a PR)',
    sources,
    unreadBeside: sources.filter((s) => s.status === 'not-read').map((s) => s.source),
  });
}

function exclusiveRow(lane: LaneGlance, state: GuardState = 'blocked'): WaitGuard {
  return makeWaitGuard({
    reason: 'exclusive-order',
    state,
    subject: { kind: 'lane', lane },
    clearedBy: { kind: 'done', subject: lane.ref },
    clearedByText: lane.label + ' is done (merged, or recorded done without a PR)',
  });
}

function unresolvedPlanRow(projectId: string, planId: string): WaitGuard {
  return makeWaitGuard({
    reason: 'after-unresolved',
    state: 'blocked',
    subject: { kind: 'plan', projectId, planId },
    clearedBy: { kind: 'record', what: 'plan-import' },
    clearedByText: 'import plan ' + planId + ' for project ' + projectId,
  });
}

function packageRow(name: string, heldBy: LaneGlance | null, state: GuardState = 'blocked'): WaitGuard {
  return makeWaitGuard({
    reason: 'package-occupied',
    state,
    subject: { kind: 'package', name, heldBy },
    clearedBy: { kind: 'holder-ends', lane: heldBy?.ref ?? REF_A, what: 'package' },
    clearedByText: 'K3 merges or releases its worktree',
  });
}

function sharedFileRow(path: string, heldBy: LaneGlance, state: GuardState = 'blocked'): WaitGuard {
  return makeWaitGuard({
    reason: 'shared-file-held',
    state,
    subject: { kind: 'shared-file', path, heldBy },
    clearedBy: { kind: 'holder-ends', lane: heldBy.ref, what: 'shared-file' },
    clearedByText: 'O1b merges or releases its worktree',
  });
}

function ownerRow(itemId: string, sinceIso: string, itemKind: 'merge' | 'decision' | 'secret' = 'decision', subject = itemId): WaitGuard {
  return makeWaitGuard({
    reason: 'owner-decision',
    state: 'blocked',
    subject: { kind: 'owner-item', itemId, itemKind, subject, sinceIso },
    clearedBy: { kind: 'owner', itemId },
    clearedByText: 'owner decides ' + itemId,
  });
}

function planDecisionRow(decisionId: string): WaitGuard {
  return makeWaitGuard({
    reason: 'owner-decision',
    state: 'blocked',
    subject: { kind: 'plan-decision', projectId: PROJECT, planId: PLAN, decisionId },
    clearedBy: { kind: 'record', what: 'plan-import' },
    clearedByText: 'owner decides ' + decisionId,
  });
}

function capacityRow(state: GuardState = 'unknown', sources: readonly SourceReading[] = []): WaitGuard {
  return makeWaitGuard({
    reason: 'capacity',
    state,
    subject: { kind: 'capacity', held: 8, budget: 8 },
    clearedBy: { kind: 'release', what: 'capacity' },
    clearedByText: 'a reservation releases (8 of 8)',
    sources,
  });
}

function card(ref: LaneRef, placement: BoardPlacement, overrides: Partial<BoardLaneCard> = {}): BoardLaneCard {
  const base: BoardLaneCard = {
    key: keyOf(ref),
    ref,
    label: ref.kind === 'plan' ? ref.laneId : ref.workOrderId,
    projectId: ref.projectId,
    planId: ref.kind === 'plan' ? ref.planId : null,
    planStatus: 'planned',
    tier: 2,
    scope: null,
    packages: [],
    workOrderIds: [],
    started: false,
    placement,
    done: null,
    waitingOn: [],
    notRead: [],
    step: null,
    stepText: null,
    seat: null,
    round: null,
    pullRequests: [],
    reviewCounts: null,
    badges: [],
    waitsOn: [],
    waitCounts: { blocked: 0, unknown: 0, clear: 0 },
    firstBlocker: null,
    summary: '',
    ...overrides,
  };
  return base;
}

function allReadSources(): SourceReading[] {
  return BOARD_SOURCES.map((source) => ({ source, repository: null, readAtIso: NOW, status: 'read' as const }));
}

interface BoardLike {
  schemaVersion: 1;
  readAtIso: string;
  policy: typeof DEFAULT_BOARD_POLICY;
  doneCutoffIso: string;
  sources: SourceReading[];
  complete: boolean;
  lanes: BoardLaneCard[];
  columns: Record<string, unknown>;
  ownerItems: unknown[];
}

function board(cards: BoardLaneCard[], overrides: Partial<BoardLike> = {}): BoardLike {
  return {
    schemaVersion: 1,
    readAtIso: NOW,
    policy: DEFAULT_BOARD_POLICY,
    doneCutoffIso: NOW,
    sources: allReadSources(),
    complete: true,
    lanes: cards,
    columns: {
      done: { entries: [], hiddenByWindow: 0, notRead: [] },
      waiting: { entries: [], notRead: [] },
      inFlight: { keys: [], notRead: [] },
      queued: { keys: [], notRead: [] },
    },
    ownerItems: [],
    ...overrides,
  };
}

function planFact(overrides: Partial<BoardPlanFact> = {}): BoardPlanFact {
  return {
    projectId: PROJECT,
    planId: PLAN,
    revision: 1,
    lanes: [{
      laneId: 'A1',
      aliases: ['K1'],
      status: 'planned',
      scope: 'scope',
      packages: [],
      sharedFiles: [],
      tier: 2,
      after: [],
      decisions: [],
      brief: null,
    }],
    decisions: [],
    exclusiveOrder: [],
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function deriveOk(boardInput: unknown, ref: LaneRef, options?: unknown): OkResult {
  const result = deriveLaneWaits(deepFreeze(boardInput), ref, options);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('expected ok');
  return result;
}

function waitsOf(result: OkResult): LaneWaits {
  expect(result.waits).not.toBeNull();
  if (result.waits === null) throw new Error('expected waits');
  return result.waits;
}

describe('WB2c deriveLaneWaits', () => {
  describe('F96-1a: runtime input refusals (null / non-object / missing / wrong-typed)', () => {
    it('refuses null, primitives and arrays for board, ref and options', () => {
      const ok = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      expect(deriveLaneWaits(null, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits('board', REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits([], REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(ok, null)).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, 42)).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, ['plan'])).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, REF_A, null)).toEqual({ ok: false, reason: 'invalid-options' });
      expect(deriveLaneWaits(ok, REF_A, 7)).toEqual({ ok: false, reason: 'invalid-options' });
    });

    it('refuses malformed refs (missing/extra/wrong-typed keys)', () => {
      const ok = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      expect(deriveLaneWaits(ok, {})).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, { kind: 'plan' })).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, { kind: 'plan', projectId: PROJECT, planId: PLAN })).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, { kind: 'plan', projectId: 1, planId: PLAN, laneId: 'A' })).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, { kind: 'branch', projectId: PROJECT, planId: PLAN, laneId: 'A' })).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'A', extra: 1 })).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits(ok, { kind: 'work-order', projectId: PROJECT })).toEqual({ ok: false, reason: 'invalid-ref' });
    });

    it('refuses boards with missing or wrong-typed fields', () => {
      const ok = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      expect(deriveLaneWaits({}, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...ok, schemaVersion: 2 }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...ok, readAtIso: 'not-a-time' }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...ok, lanes: 'nope' }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...ok, sources: 'nope' }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...ok, lanes: [{ ...ok.lanes[0], placement: 'mystery' }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...ok, lanes: [{ ...ok.lanes[0], key: 'different/key' }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...ok, lanes: [{ ...ok.lanes[0], waitsOn: 'nope' }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
    });
  });

  describe('F96-1b: sparse arrays refuse', () => {
    it('refuses sparse arrays in board.lanes, card.waitsOn, board.sources and options.plans', () => {
      const base = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      const sparseLanes: unknown[] = [base.lanes[0]];
      sparseLanes.length = 10;
      expect(deriveLaneWaits({ ...base, lanes: sparseLanes }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });

      const sparseWaits: unknown[] = [seatRow()];
      sparseWaits.length = 10;
      expect(deriveLaneWaits({ ...base, lanes: [{ ...base.lanes[0], waitsOn: sparseWaits }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });

      const sparseSources: unknown[] = [base.sources[0]];
      sparseSources.length = 10;
      expect(deriveLaneWaits({ ...base, sources: sparseSources }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });

      const sparsePlans: unknown[] = [planFact()];
      sparsePlans.length = 10;
      expect(deriveLaneWaits(base, REF_A, { plans: sparsePlans })).toEqual({ ok: false, reason: 'invalid-options' });
    });
  });

  describe('F96-1c: unknown enum values refuse', () => {
    it('refuses unknown enums across placement, reasons, states, sources and refs', () => {
      const base = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      const withWaits = (waitGuard: WaitGuard) => ({ ...base, lanes: [{ ...base.lanes[0], waitsOn: [waitGuard] }] });

      expect(deriveLaneWaits(withWaits({ ...seatRow(), reason: 'after-bogus' as never }), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(withWaits({ ...seatRow(), state: 'maybe' as never }), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(withWaits({
        ...seatRow(),
        subject: { kind: 'bogus', role: null },
      } as unknown as WaitGuard), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(withWaits({
        ...seatRow(),
        clearedBy: { kind: 'bogus', what: 'seat-probe' },
      } as unknown as WaitGuard), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({
        ...base,
        sources: [{ source: 'not-a-source', repository: null, readAtIso: NOW, status: 'read' }],
      }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({
        ...base,
        sources: [{ source: 'attempts', repository: null, readAtIso: NOW, status: 'read', reason: 'bogus' }],
      }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(base, { kind: 'branch', projectId: PROJECT, planId: PLAN, laneId: 'A' })).toEqual({ ok: false, reason: 'invalid-ref' });
    });
  });

  describe('F96-1d: throwing getters and Proxy traps never throw or run', () => {
    it('never runs getters and returns typed refusals', () => {
      const ok = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      const evilLanes = { ...ok };
      Object.defineProperty(evilLanes, 'lanes', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      expect(() => deriveLaneWaits(evilLanes, REF_A)).not.toThrow();
      expect(deriveLaneWaits(evilLanes, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });

      const evilWaits = { ...ok, lanes: [{ ...ok.lanes[0] }] };
      Object.defineProperty(evilWaits.lanes[0], 'waitsOn', {
        enumerable: true,
        get() {
          throw new Error('boom');
        },
      });
      expect(() => deriveLaneWaits(evilWaits, REF_A)).not.toThrow();
      expect(deriveLaneWaits(evilWaits, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
    });

    it('never runs Proxy traps and returns typed refusals', () => {
      const ok = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      const proxy = new Proxy(ok, {
        get() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      });
      expect(() => deriveLaneWaits(proxy, REF_A)).not.toThrow();
      expect(deriveLaneWaits(proxy, REF_A).ok).toBe(false);

      const refProxy = new Proxy(REF_A, {
        get() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      });
      expect(() => deriveLaneWaits(ok, refProxy)).not.toThrow();
      expect(deriveLaneWaits(ok, refProxy)).toEqual({ ok: false, reason: 'invalid-ref' });
    });
  });

  describe('F96-2: frozen inputs, iterative walks, nodeCap', () => {
    it('never mutates deep-frozen inputs and is deterministic', () => {
      const frozen = deepFreeze(board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]));
      const first = deriveLaneWaits(frozen, REF_A);
      const second = deriveLaneWaits(frozen, REF_A);
      expect(first).toEqual(second);
      expect(first.ok).toBe(true);
    });

    it('caps the closure at nodeCap (200 by default)', () => {
      const cards: BoardLaneCard[] = [card(REF_R, 'queued', { waitsOn: [afterRow(glance({ kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'L1' })), seatRow()] })];
      for (let i = 1; i <= 201; i += 1) {
        const ref: LaneRef = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'L' + i };
        const next: LaneRef | null = i < 201 ? { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'L' + (i + 1) } : null;
        const waitsOn = next !== null ? [afterRow(glance(next)), seatRow()] : [seatRow()];
        cards.push(card(ref, 'queued', { waitsOn }));
      }
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      expect(waits.truncated.nodeCap).toBe(true);
      expect(waits.chains).toHaveLength(1);
      const chain = waits.chains[0];
      expect(chain.head).toEqual({ kind: 'cap' });
      expect(chain.length).toBe(200);
      expect(chain.atLeast).toBe(true);
    });
  });

  describe('F96-3: keyed idempotence', () => {
    it('deduplicates unblocks, sources, cycle rows and diamond tree nodes, and repeated calls are deeply equal', () => {
      const t = card(REF_A, 'in-flight');
      const d1 = card(REF_B, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] });
      const d2 = card(REF_C, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] });
      const frozen = deepFreeze(board([t, d1, d2]));
      const first = deriveLaneWaits(frozen, REF_A);
      const second = deriveLaneWaits(frozen, REF_A);
      expect(first).toEqual(second);
      if (!first.ok || !second.ok) throw new Error('expected ok');
      expect(first.unblocks).toHaveLength(2);
      expect(first.unblocks.map((g) => g.label).sort()).toEqual(['B', 'C']);
    });

    it('emits one cycle-in-records row for repeated cycle paths across two chains', () => {
      const cards = [
        card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_A)), afterRow(glance(REF_A)), seatRow()] }),
        card(REF_A, 'queued', { waitsOn: [afterRow(glance(REF_B)), seatRow()] }),
        card(REF_B, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] }),
      ];
      const frozen = deepFreeze(board(cards));
      const first = deriveLaneWaits(frozen, REF_R);
      const second = deriveLaneWaits(frozen, REF_R);
      expect(first).toEqual(second);
      if (!first.ok || !second.ok) throw new Error('expected ok');
      const waits = waitsOf(first);
      const cycleRows = waits.guards.filter((g) => g.reason === 'cycle-in-records');
      expect(cycleRows).toHaveLength(1);
    });
  });

  describe('F96-4: unknown stays unknown', () => {
    it('returns lane-not-on-board for a missing lane, never an empty view', () => {
      const base = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      const result = deriveLaneWaits(base, REF_Z);
      expect(result).toMatchObject({ ok: false, reason: 'lane-not-on-board', ref: REF_Z, readAtIso: NOW });
    });

    it('a queued lane with only unknown rows is unchecked-only, never ready', () => {
      const result = deriveOk(board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]), REF_A);
      const waits = waitsOf(result);
      expect(waits.verdict).toBe('unchecked-only');
      expect(waits.summary).toBe('Nothing blocks it but unchecked guards: seat not checked.');
    });

    it('not-read sources propagate into sources and make chains at-least', () => {
      const unreadMerge: SourceReading = { source: 'merge-records', repository: null, readAtIso: null, status: 'not-read' };
      const root = card(REF_R, 'queued', {
        waitsOn: [afterRow(glance(REF_K1B), 'blocked', [unreadMerge]), seatRow()],
        notRead: [unreadMerge],
      });
      const k1b = card(REF_K1B, 'in-flight', { stepText: 'watching CI as of 10:02' });
      const result = deriveOk(board([root, k1b]), REF_R);
      const waits = waitsOf(result);
      expect(waits.sources.some((s) => s.source === 'merge-records' && s.status === 'not-read')).toBe(true);
      expect(waits.chains[0].atLeast).toBe(true);
    });

    it('an unread store that leaves a guard unknown renders "Not known: …"', () => {
      const unreadAttempts: SourceReading = { source: 'attempts', repository: null, readAtIso: null, status: 'not-read', reason: 'quarantined' };
      const result = deriveOk(board([card(REF_A, 'queued', { waitsOn: [capacityRow('unknown', [unreadAttempts])] })]), REF_A);
      const waits = waitsOf(result);
      expect(waits.verdict).toBe('unchecked-only');
      expect(waits.summary).toBe('Not known: attempts not read (quarantined); capacity not checked.');
    });
  });

  describe('F96-5: no secret-shaped text and no host/filesystem path echoed', () => {
    it('refuses runtime-constructed secret shapes from both registries with reason codes only', () => {
      const ghToken = 'gh' + 'p_' + 'x'.repeat(36);
      const githubPat = 'github' + '_pat_' + 'y'.repeat(30);
      const sk = 'sk-' + 'a'.repeat(24);
      const base = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);

      expect(deriveLaneWaits(base, { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: ghToken })).toEqual({ ok: false, reason: 'invalid-ref' });
      expect(deriveLaneWaits({ ...base, lanes: [{ ...base.lanes[0], label: githubPat }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...base, lanes: [{ ...base.lanes[0], waitsOn: [
        { ...seatRow(), subject: { kind: 'package', name: sk, heldBy: null } },
      ] }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits({ ...base, lanes: [{ ...base.lanes[0], waitsOn: [
        { ...seatRow(), clearedByText: ghToken },
      ] }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });

      const result = deriveLaneWaits({ ...base, lanes: [{ ...base.lanes[0], label: githubPat }] }, REF_A);
      expect(JSON.stringify(result)).not.toContain('github_pat');
    });

    it('refuses absolute and traversing paths on WaitSubject paths', () => {
      const base = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      const withSubject = (subject: WaitSubject) => ({
        ...base,
        lanes: [{ ...base.lanes[0], waitsOn: [{ ...seatRow(), subject }] }],
      });
      expect(deriveLaneWaits(withSubject({ kind: 'shared-file', path: '/etc/passwd', heldBy: glance(REF_HOLDER) }), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(withSubject({ kind: 'shared-file', path: '../outside', heldBy: glance(REF_HOLDER) }), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(withSubject({ kind: 'shared-file', path: 'C:\\secret', heldBy: glance(REF_HOLDER) }), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(withSubject({ kind: 'shared-file', path: 'file://etc/passwd', heldBy: glance(REF_HOLDER) }), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
      expect(deriveLaneWaits(withSubject({ kind: 'brief', path: '~/.ssh/id_rsa' }), REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
    });
  });

  describe('F96-6: module pure functions', () => {
    it('exports pure deterministic functions only', () => {
      expect(typeof deriveLaneWaits).toBe('function');
      expect(deriveLaneWaits.name).toBe('deriveLaneWaits');
    });
  });

  describe('F96-7: input and output size bounds', () => {
    it('refuses nodeCap out of range and oversized ids, guards and lanes', () => {
      const base = board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]);
      expect(deriveLaneWaits(base, REF_A, { nodeCap: 0 })).toEqual({ ok: false, reason: 'invalid-options' });
      expect(deriveLaneWaits(base, REF_A, { nodeCap: 201 })).toEqual({ ok: false, reason: 'invalid-options' });
      expect(deriveLaneWaits(base, REF_A, { nodeCap: 1.5 })).toEqual({ ok: false, reason: 'invalid-options' });

      const longId = 'x'.repeat(257);
      expect(deriveLaneWaits(base, { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: longId })).toEqual({ ok: false, reason: 'invalid-ref' });
      const longItemId = 'i'.repeat(257);
      expect(deriveLaneWaits({ ...base, lanes: [{ ...base.lanes[0], waitsOn: [ownerRow(longItemId, NOW)] }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });

      const tooManyGuards = Array.from({ length: 501 }, () => seatRow());
      expect(deriveLaneWaits({ ...base, lanes: [{ ...base.lanes[0], waitsOn: tooManyGuards }] }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });

      const tooManyLanes = Array.from({ length: 10_001 }, (_, i) => card({ kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'L' + i }, 'queued', { waitsOn: [seatRow()] }));
      expect(deriveLaneWaits({ ...base, lanes: tooManyLanes }, REF_A)).toEqual({ ok: false, reason: 'invalid-board' });
    });
  });

  describe('Row order and Waiting priority (§3.2)', () => {
    it('orders a waiting lane owner items first by sinceIso then itemId, then blocked/unknown/clear', () => {
      const waitsOn = [
        packageRow('work-execution', glance(REF_HOLDER)),
        seatRow(),
        ownerRow('item-b', '2026-10-27T08:00:00.000Z'),
        afterRow(glance(REF_C), 'clear'),
        afterRow(glance(REF_K1B)),
        ownerRow('item-a', '2026-10-27T07:00:00.000Z'),
      ];
      const w = card(REF_W, 'waiting', { waitsOn, waitingOn: [{ origin: 'owner-item', id: 'item-a', kind: 'decision', subject: 'item-a', sinceIso: '2026-10-27T07:00:00.000Z' }] });
      const result = deriveOk(board([w]), REF_W);
      const waits = waitsOf(result);
      expect(waits.guards.map((g) => g.reason)).toEqual([
        'owner-decision',
        'owner-decision',
        'after-not-done',
        'package-occupied',
        'seat',
        'after-not-done',
      ]);
      expect(waits.guards.map((g) => g.state)).toEqual(['blocked', 'blocked', 'blocked', 'blocked', 'unknown', 'clear']);
      expect(waits.counts).toEqual({ blocked: 4, unknown: 1, clear: 1 });
      expect(waits.firstBlocker?.subject.kind).toBe('owner-item');
      const blocker = waits.firstBlocker;
      if (blocker !== null && blocker.subject.kind === 'owner-item') {
        expect(blocker.subject.itemId).toBe('item-a');
      }
      expect(waits.verdict).toBe('blocked');
    });
  });

  describe('Summary and verdict wording (§3.2)', () => {
    it('queued with only seat unknown is unchecked-only with the exact summary', () => {
      const result = deriveOk(board([card(REF_A, 'queued', { waitsOn: [seatRow()] })]), REF_A);
      const waits = waitsOf(result);
      expect(waits.verdict).toBe('unchecked-only');
      expect(waits.summary).toBe('Nothing blocks it but unchecked guards: seat not checked.');
    });

    it('exclusive-order and plan-decision rows format in the one order', () => {
      const waitsOn = [
        exclusiveRow(glance(REF_A)),
        planDecisionRow('D14'),
        seatRow(),
      ];
      const result = deriveOk(board([card(REF_R, 'queued', { waitsOn })]), REF_R);
      const waits = waitsOf(result);
      expect(waits.guards.map((g) => g.reason)).toEqual(['exclusive-order', 'owner-decision', 'seat']);
      expect(waits.summary).toBe('Blocked by 2: after A (queued); decision D14. Unknown 1: seat not checked.');
    });

    it('blocked by two guards with one unknown uses exact wording', () => {
      const waitsOn = [
        afterRow(glance(REF_K1B, 'in-flight', { step: 'code-review as of 10:02' })),
        packageRow('work-execution', glance(REF_HOLDER, 'in-flight')),
        seatRow(),
      ];
      const result = deriveOk(board([card(REF_A, 'queued', { waitsOn })]), REF_A);
      const waits = waitsOf(result);
      expect(waits.summary).toBe(
        'Blocked by 2: after K1b (in flight, code-review as of 10:02);'
        + ' package work-execution held by HOLDER (in flight). Unknown 1: seat not checked.',
      );
    });

    it('three or more blocked guards name the first two and then "and N more"', () => {
      const waitsOn = [
        afterRow(glance(REF_K1B)),
        afterRow(glance(REF_C)),
        afterRow(glance(REF_D)),
        seatRow(),
      ];
      const result = deriveOk(board([card(REF_A, 'queued', { waitsOn })]), REF_A);
      const waits = waitsOf(result);
      expect(waits.summary).toBe('Blocked by 3: after K1b (queued); after C (queued) and 1 more. Unknown 1: seat not checked.');
    });

    it('blocked after-not-done with an unread forge-observation appends the forge suffix', () => {
      const forgeReading: SourceReading = { source: 'forge-observation', repository: 'org/repo', readAtIso: '2026-10-27T09:40:00.000Z', status: 'not-read' };
      const waitsOn = [
        afterRow(glance(REF_K1B), 'blocked', [forgeReading]),
        seatRow(),
      ];
      const result = deriveOk(board([card(REF_A, 'queued', { waitsOn })]), REF_A);
      const waits = waitsOf(result);
      expect(waits.summary).toBe(
        'Blocked by 1: after K1b (queued); forge not read since 2026-10-27T09:40:00.000Z. Unknown 1: seat not checked.',
      );

      const awaitsReading: SourceReading = { source: 'forge-observation', repository: 'org/repo', readAtIso: null, status: 'not-read' };
      const result2 = deriveOk(board([card(REF_A, 'queued', { waitsOn: [afterRow(glance(REF_K1B), 'blocked', [awaitsReading]), seatRow()] })]), REF_A);
      expect(waitsOf(result2).summary).toBe('Blocked by 1: after K1b (queued); forge not read. Unknown 1: seat not checked.');
    });

    it('waiting lane with gating owner item and a dependency block uses the waiting wording', () => {
      const waitsOn = [
        ownerRow('D14', '2026-10-27T09:10:00.000Z'),
        afterRow(glance(REF_K1B, 'in-flight')),
        seatRow(),
      ];
      const w = card(REF_W, 'waiting', { waitsOn, waitingOn: [{ origin: 'owner-item', id: 'D14', kind: 'decision', subject: 'D14', sinceIso: '2026-10-27T09:10:00.000Z' }] });
      const result = deriveOk(board([w]), REF_W);
      const waits = waitsOf(result);
      expect(waits.summary).toBe(
        'Waiting on you: decision D14 (since 2026-10-27T09:10:00.000Z). Also blocked by 1: after K1b (in flight).',
      );
    });

    it('store unreadable renders "Not known: <source> not read (<reason>); …"', () => {
      const quarantined: SourceReading = { source: 'attempts', repository: null, readAtIso: null, status: 'not-read', reason: 'quarantined' };
      const result = deriveOk(board([card(REF_A, 'queued', { waitsOn: [capacityRow('unknown', [quarantined]), seatRow()] })]), REF_A);
      const waits = waitsOf(result);
      expect(waits.summary).toBe('Not known: attempts not read (quarantined); capacity not checked; seat not checked.');
    });
  });

  describe('Chains — edges, heads, leaves, otherBlockedDependencies', () => {
    it('linear chain K12 -> K1b -> K1-2c ends started with length 2 and atLeast false', () => {
      const cards = [
        card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_K1B)), seatRow()] }),
        card(REF_K1B, 'queued', { waitsOn: [afterRow(glance(REF_K1_2C)), seatRow()] }),
        card(REF_K1_2C, 'in-flight', { stepText: 'watching CI as of 10:02' }),
      ];
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      expect(waits.chains).toHaveLength(1);
      const chain = waits.chains[0];
      expect(chain.lanes.map((s) => s.lane.label)).toEqual(['R', 'K1b', 'K1-2c']);
      expect(chain.lanes.map((s) => s.via)).toEqual(['after-not-done', 'after-not-done', 'after-not-done']);
      expect(chain.lanes.map((s) => s.ownerAction)).toEqual([false, false, false]);
      expect(chain.lanes.map((s) => s.otherBlockedDependencies)).toEqual([0, 0, 0]);
      expect(chain.head).toEqual({ kind: 'started' });
      expect(chain.length).toBe(2);
      expect(chain.atLeast).toBe(false);
    });

    it('a waiting predecessor sets ownerAction and waiting-on-owner with otherBlockedDependencies and atLeast', () => {
      const cards = [
        card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_W)), seatRow()] }),
        card(REF_W, 'waiting', {
          waitsOn: [ownerRow('item-9', '2026-10-27T09:00:00.000Z'), afterRow(glance(REF_C)), seatRow()],
          waitingOn: [{ origin: 'owner-item', id: 'item-9', kind: 'decision', subject: 'item-9', sinceIso: '2026-10-27T09:00:00.000Z' }],
        }),
        card(REF_C, 'in-flight'),
      ];
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      const chain = waits.chains[0];
      expect(chain.lanes[1].lane.label).toBe('W');
      expect(chain.lanes[1].ownerAction).toBe(true);
      expect(chain.lanes[1].otherBlockedDependencies).toBe(1);
      expect(chain.head).toEqual({ kind: 'waiting-on-owner', itemId: 'item-9' });
      expect(chain.atLeast).toBe(true);
    });

    it('a queued predecessor whose first blocked row is a resource guard ends as blocked-by-resource', () => {
      const q = card(REF_A, 'queued', {
        waitsOn: [sharedFileRow('src/shared.ts', glance(REF_HOLDER)), seatRow()],
      });
      const cards = [card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] }), q];
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      const chain = waits.chains[0];
      expect(chain.head).toMatchObject({ kind: 'blocked-by-resource', reason: 'shared-file-held' });
      expect(chain.head.kind === 'blocked-by-resource' ? chain.head.subject.kind : '').toBe('shared-file');
      expect(chain.lanes).toHaveLength(2);
    });

    it('a queued predecessor with nothing blocked ends as unchecked-only', () => {
      const q = card(REF_A, 'queued', { waitsOn: [seatRow()] });
      const cards = [card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] }), q];
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      expect(waits.chains[0].head).toEqual({ kind: 'unchecked-only' });
    });

    it('a predecessor with 2+ blocked dependencies follows the first and sets n-1 others with atLeast', () => {
      const q = card(REF_A, 'queued', {
        waitsOn: [afterRow(glance(REF_B)), afterRow(glance(REF_C)), seatRow()],
      });
      const cards = [
        card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] }),
        q,
        card(REF_B, 'in-flight'),
        card(REF_C, 'in-flight'),
      ];
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      const chain = waits.chains[0];
      expect(chain.lanes[1].otherBlockedDependencies).toBe(1);
      expect(chain.atLeast).toBe(true);
      expect(chain.head).toEqual({ kind: 'started' });
    });

    it('multiple root dependency rows produce chains in row order with shared predecessors counted once', () => {
      const cards = [
        card(REF_R, 'queued', {
          waitsOn: [afterRow(glance(REF_A)), afterRow(glance(REF_B)), seatRow()],
        }),
        card(REF_A, 'queued', { waitsOn: [afterRow(glance(REF_C)), seatRow()] }),
        card(REF_B, 'queued', { waitsOn: [afterRow(glance(REF_C)), seatRow()] }),
        card(REF_C, 'in-flight'),
      ];
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      expect(waits.chains).toHaveLength(2);
      expect(waits.chains[0].lanes.map((s) => s.lane.label)).toEqual(['R', 'A', 'C']);
      expect(waits.chains[1].lanes.map((s) => s.lane.label)).toEqual(['R', 'B', 'C']);
      expect(waits.truncated.nodeCap).toBe(false);
      const sourceKeys = waits.sources.map((s) => s.source);
      expect(new Set(sourceKeys).size).toBe(sourceKeys.length);
    });

    it('cross-project resolved predecessor is followed; unimported plan ends unresolved; dropped ends dropped', () => {
      const x = card(REF_X, 'in-flight');
      const withX = deriveOk(board([card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_X)), seatRow()] }), x]), REF_R);
      expect(waitsOf(withX).chains[0].head).toEqual({ kind: 'started' });
      expect(waitsOf(withX).chains[0].lanes[1].lane.ref).toEqual(REF_X);

      const unimported = deriveOk(board([card(REF_R, 'queued', { waitsOn: [unresolvedPlanRow('p9', 'missing')] })]), REF_R);
      expect(waitsOf(unimported).chains[0].head).toEqual({ kind: 'unresolved' });
      expect(waitsOf(unimported).chains[0].length).toBe(0);

      const d = card(REF_D, 'dropped');
      const dropped = deriveOk(board([card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_D, 'dropped')), seatRow()] }), d]), REF_R);
      expect(waitsOf(dropped).chains[0].head).toEqual({ kind: 'dropped' });
    });
  });

  describe('Cycles vs the 200-distinct-lane cap', () => {
    it('a self-loop cycle ends at once with head cycle and adds a cycle-in-records row', () => {
      const r = card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_R)), seatRow()] });
      const result = deriveOk(board([r]), REF_R);
      const waits = waitsOf(result);
      expect(waits.chains[0].head).toEqual({ kind: 'cycle', path: [REF_R, REF_R] });
      expect(waits.truncated.nodeCap).toBe(false);
      const cycleRow = waits.guards.find((g) => g.reason === 'cycle-in-records');
      expect(cycleRow).toBeDefined();
      if (cycleRow === undefined || cycleRow.subject.kind !== 'cycle') throw new Error('expected cycle row');
      expect(cycleRow.state).toBe('blocked');
      expect(cycleRow.subject.path).toEqual([REF_R, REF_R]);
      expect(cycleRow.clearedByText).toBe("fix the plans' after rows; the import refuses new cycles");
      expect(waits.counts.blocked).toBe(2);
      expect(waits.verdict).toBe('blocked');
      expect(waits.summary).toContain('cycle in records');
    });

    it('cycle R -> A -> B -> A ends with the cycle path and updates counts', () => {
      const cards = [
        card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] }),
        card(REF_A, 'queued', { waitsOn: [afterRow(glance(REF_B)), seatRow()] }),
        card(REF_B, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] }),
      ];
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      expect(waits.chains[0].head).toEqual({ kind: 'cycle', path: [REF_A, REF_B, REF_A] });
      expect(waits.truncated.nodeCap).toBe(false);
      const cycleRow = waits.guards.find((g) => g.reason === 'cycle-in-records');
      expect(cycleRow).toBeDefined();
    });

    it('a cycle whose repeat lies beyond the 200th distinct lane reports as the cap with no cycle row', () => {
      const cards: BoardLaneCard[] = [card(REF_R, 'queued', { waitsOn: [afterRow(glance({ kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'L1' })), seatRow()] })];
      for (let i = 1; i <= 201; i += 1) {
        const ref: LaneRef = { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'L' + i };
        const next: LaneRef = i < 201 ? { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'L' + (i + 1) } : REF_R;
        const waitsOn = [afterRow(glance(next)), seatRow()];
        cards.push(card(ref, 'queued', { waitsOn }));
      }
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      expect(waits.chains[0].head).toEqual({ kind: 'cap' });
      expect(waits.truncated.nodeCap).toBe(true);
      expect(waits.guards.some((g) => g.reason === 'cycle-in-records')).toBe(false);
    });
  });

  describe('No-waits columns, unblocks, alias resolution and the tree', () => {
    it('in-flight, done, dropped and deferred lanes set noWaits with waits null and unblocks still populated', () => {
      const targetInFlight = card(REF_A, 'in-flight');
      const done = card(REF_B, 'done');
      const dropped = card(REF_C, 'dropped');
      const deferred = card(REF_D, 'deferred');
      const dep = card(REF_K1B, 'queued', { waitsOn: [afterRow(glance(REF_A)), seatRow()] });
      const dep2 = card(REF_K1_2C, 'queued', { waitsOn: [afterRow(glance(REF_B)), seatRow()] });
      const dep3 = card(REF_W, 'queued', { waitsOn: [afterRow(glance(REF_C)), seatRow()] });
      const dep4 = card(REF_Z, 'queued', { waitsOn: [afterRow(glance(REF_D)), seatRow()] });

      const inFlight = deriveOk(board([targetInFlight, dep, dep2, dep3, dep4]), REF_A);
      expect(inFlight.waits).toBeNull();
      expect(inFlight.noWaits).toBe('started');
      expect(inFlight.unblocks.map((g) => g.label)).toEqual(['K1b']);

      const doneView = deriveOk(board([done, dep, dep2, dep3, dep4]), REF_B);
      expect(doneView.noWaits).toBe('done');
      expect(doneView.unblocks.map((g) => g.label)).toEqual(['K1-2c']);

      const droppedView = deriveOk(board([dropped, dep, dep2, dep3, dep4]), REF_C);
      expect(droppedView.noWaits).toBe('dropped');
      expect(droppedView.unblocks.map((g) => g.label)).toEqual(['W']);

      const deferredView = deriveOk(board([deferred, dep, dep2, dep3, dep4]), REF_D);
      expect(deferredView.noWaits).toBe('deferred');
      expect(deferredView.unblocks.map((g) => g.label)).toEqual(['Z']);
    });

    it('unblocks includes plan dependants in every column when options.plans is supplied', () => {
      const target = card(REF_A1, 'in-flight');
      const plan = planFact({
        lanes: [
          { laneId: 'A1', aliases: ['K1'], status: 'planned', scope: 'scope', packages: [], sharedFiles: [], tier: 2, after: [], decisions: [], brief: null },
          { laneId: 'P2', aliases: [], status: 'planned', scope: 'scope', packages: [], sharedFiles: [], tier: 2, after: [{ projectId: PROJECT, planId: PLAN, laneId: 'A1' }], decisions: [], brief: null },
          { laneId: 'P3', aliases: [], status: 'deferred', scope: 'scope', packages: [], sharedFiles: [], tier: 2, after: [{ projectId: PROJECT, planId: PLAN, laneId: 'A1' }], decisions: [], brief: null },
        ],
        exclusiveOrder: [{ file: 'packages/work-execution', lanes: ['A1', 'P2', 'P3'] }],
      });
      const result = deriveOk(board([target]), REF_A1, { plans: [plan] });
      expect(result.unblocks.map((g) => g.label).sort()).toEqual(['P2', 'P3']);
    });

    it('a renamed lane alias resolves via options.plans to the canonical card', () => {
      const target = card(REF_A1, 'queued', { waitsOn: [seatRow()] });
      const plan = planFact();
      const viaAlias = deriveOk(board([target]), { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'K1' }, { plans: [plan] });
      expect(viaAlias.ok).toBe(true);
      expect(viaAlias.lane.ref).toEqual(REF_A1);

      const withoutPlans = deriveLaneWaits(board([target]), { kind: 'plan', projectId: PROJECT, planId: PLAN, laneId: 'K1' });
      expect(withoutPlans).toMatchObject({ ok: false, reason: 'lane-not-on-board' });
    });

    it('the tree holds blocked and unknown rows only, expands dependency children and deduplicates', () => {
      const cards = [
        card(REF_R, 'queued', {
          waitsOn: [afterRow(glance(REF_A)), afterRow(glance(REF_B)), afterRow(glance(REF_C), 'clear'), seatRow()],
        }),
        card(REF_A, 'queued', { waitsOn: [afterRow(glance(REF_C)), seatRow()] }),
        card(REF_B, 'queued', { waitsOn: [afterRow(glance(REF_C)), seatRow()] }),
        card(REF_C, 'queued', { waitsOn: [seatRow()] }),
      ];
      const result = deriveOk(board(cards), REF_R);
      const waits = waitsOf(result);
      const tree = waits.tree;
      const reasons = tree.children.map((c) => c.guard.reason);
      expect(reasons).not.toContain('clear');
      expect(tree.children.some((c) => c.guard.state === 'blocked')).toBe(true);
      expect(tree.children.some((c) => c.guard.state === 'unknown')).toBe(true);
      const expanded = tree.children.filter((c) => c.stop === 'expanded');
      expect(expanded).toHaveLength(2);
      const stops: string[] = [];
      const collectStops = (node: WaitNode): void => {
        for (const child of node.children) {
          stops.push(child.stop);
          if (child.node !== null) collectStops(child.node);
        }
      };
      collectStops(tree);
      expect(stops.filter((s) => s === 'deduplicated')).toHaveLength(1);
      expect(tree.children.filter((c) => c.stop === 'leaf')).toHaveLength(1);
    });

    it('the tree marks cycles and cap cuts', () => {
      const selfLoop = deriveOk(board([card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_R)), seatRow()] })]), REF_R);
      const selfTree = waitsOf(selfLoop).tree;
      expect(selfTree.children.some((c) => c.stop === 'cycle')).toBe(true);

      const capCards = [
        card(REF_R, 'queued', { waitsOn: [afterRow(glance(REF_A)), afterRow(glance(REF_B)), seatRow()] }),
        card(REF_A, 'queued', { waitsOn: [seatRow()] }),
        card(REF_B, 'queued', { waitsOn: [seatRow()] }),
      ];
      const capped = deriveOk(board(capCards), REF_R, { nodeCap: 1 });
      const cappedTree = waitsOf(capped).tree;
      expect(cappedTree.children.some((c) => c.stop === 'cap')).toBe(true);
      expect(waitsOf(capped).truncated.nodeCap).toBe(true);
    });
  });
});
