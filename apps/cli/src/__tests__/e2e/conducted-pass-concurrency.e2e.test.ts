// KF-34b2: the real-path proof for one conducted pass advancing two runs at
// pass concurrency 2. `conductor run --live --once --pass-concurrency=2`
// dispatches both runs through `bin/ocm-run` over ssh to the fixture's sshd
// and the fake opencode server; the session-start gate spaces the second run's
// REAL session create at least the default 20 s stagger behind the first.
// Everything below is skipped unless FLEET_E2E_SSH=1. Every scenario is
// bounded to 120 s and every fixture is stopped even on failure.

import { describe, expect, it, afterEach, vi } from 'vitest';

import type { LaneRunJournalEntryRecord } from '@fleet/work-execution';

import { startConductedFixture, type ConductedFixture } from './conducted.js';

const TEST_TIMEOUT_MS = 120000;

/** The default session-start stagger the live wiring passes (20 000 ms). */
const STAGGER_MS = 20000;

const liveFixtures = new Set<ConductedFixture>();

async function startFixture(options?: Parameters<typeof startConductedFixture>[0]) {
  const current = await startConductedFixture(options);
  liveFixtures.add(current);
  return current;
}

afterEach(async () => {
  // Restore the prototype spies before the next test and stop the fixtures in
  // LIFO order: the newest fixture's PATH entry sits first, so it must be
  // removed first.
  vi.restoreAllMocks();
  const current = [...liveFixtures];
  liveFixtures.clear();
  for (const instance of current.reverse()) {
    await instance.stop();
  }
});

/** Parse the first stdout line of a run/start result as a JSON document. */
function firstDocument(result: { stdout: readonly string[] }): Record<string, unknown> {
  const line = result.stdout.find((candidate) => candidate.trim().length > 0);
  if (line === undefined) {
    throw new Error('the command printed no JSON document');
  }
  return JSON.parse(line) as Record<string, unknown>;
}

interface FakeServerState {
  readonly sessions: Record<string, string>;
  readonly interrupts: readonly string[];
  readonly createdIds: readonly string[];
  readonly createdAtMs: Record<string, number>;
}

/** The fake opencode server's `/__state` snapshot (sessions, creates, times). */
async function readFakeState(fakeOpencodeUrl: string): Promise<FakeServerState> {
  const response = await fetch(`${fakeOpencodeUrl}/__state`);
  if (!response.ok) {
    throw new Error(`/__state answered ${response.status}`);
  }
  return (await response.json()) as FakeServerState;
}

function runRecordOf(current: ConductedFixture, runId: string) {
  return current.runtime.conductor.laneRunRepository.get(runId);
}

function journalOf(current: ConductedFixture, runId: string): Promise<readonly LaneRunJournalEntryRecord[]> {
  return current.runtime.conductor.laneRunJournal.listForRun(runId);
}

/**
 * The recorded gate-grant time of a run's dispatch: the dispatch step intent's
 * `recordedAtIso` is the step's `nowIso` — the moment the start gate granted
 * the run's slot (the gate sits before the one-way intent in
 * `performDispatch`).
 */
async function dispatchGrantMsOf(current: ConductedFixture, runId: string): Promise<number> {
  const entries = await journalOf(current, runId);
  const intent = entries.find((entry) =>
    entry.kind === 'intent'
    && entry.key !== null
    && entry.key.includes('/dispatch/'),
  );
  if (intent === undefined) {
    throw new Error(`run ${runId} has no dispatch intent in its journal`);
  }
  return Date.parse(intent.recordedAtIso);
}

describe.skipIf(process.env.FLEET_E2E_SSH !== '1')('conducted pass concurrency 2 over ssh (KF-34b2)', () => {
  it('scenario a: one pass advances two runs, and the second REAL session create is spaced a full stagger behind', async () => {
    const fixture = await startFixture({ secondRun: true });

    // Both runs start at Tier 1 under the admission cap of two active runs.
    const startA = await fixture.start(1, ['--max-active-runs', '2']);
    expect(startA.code).toBe(0);
    const startB = await fixture.startSecond!(1, ['--max-active-runs', '2']);
    expect(startB.code).toBe(0);

    // ONE pass with pass concurrency 2 advances both runs.
    const pass = await fixture.runPass(['--max-active-runs', '2', '--pass-concurrency=2']);
    expect(pass.code).toBe(0);

    // The pass's JSON report lists both run ids, each with at least one
    // acted/entered step (both advanced in that one pass).
    const report = firstDocument(pass) as {
      outcome: string;
      runs: Array<{ runId: string; outcome: string; steps: Array<{ outcome: string }> }>;
    };
    expect(report.outcome).toBe('completed');
    const byRun = new Map(report.runs.map((run) => [run.runId, run]));
    for (const runId of [fixture.runId, fixture.runId2!]) {
      const runReport = byRun.get(runId);
      expect(runReport, `run ${runId} in the pass report`).toBeDefined();
      expect(runReport!.outcome).toBe('advanced');
      expect(runReport!.steps.some((step) =>
        step.outcome === 'acted' || step.outcome === 'entered',
      )).toBe(true);
    }

    // The fake server shows exactly two creates, and each run's attempt
    // records its own session id.
    const state = await readFakeState(fixture.fakeOpencodeUrl);
    expect(state.createdIds).toHaveLength(2);
    const attemptA = await fixture.runtime.execution.attemptRepository.findAttemptById(fixture.attemptId);
    const attemptB = await fixture.runtime.execution.attemptRepository.findAttemptById(fixture.attemptId2!);
    expect(attemptA).not.toBeNull();
    expect(attemptB).not.toBeNull();
    expect(attemptA!.sessionId).not.toBeNull();
    expect(attemptB!.sessionId).not.toBeNull();
    expect(state.createdIds).toContain(attemptA!.sessionId);
    expect(state.createdIds).toContain(attemptB!.sessionId);
    expect(attemptA!.sessionId).not.toBe(attemptB!.sessionId);

    // The gate grants: the dispatch intents' recordedAtIso are the grant
    // times, A the earlier. The second run's grant is a full stagger later.
    const grantA1 = await dispatchGrantMsOf(fixture, fixture.runId);
    const grantB1 = await dispatchGrantMsOf(fixture, fixture.runId2!);
    const [aGrant, bGrant, aSession, bSession] = grantA1 <= grantB1
      ? [grantA1, grantB1, attemptA!.sessionId!, attemptB!.sessionId!]
      : [grantB1, grantA1, attemptB!.sessionId!, attemptA!.sessionId!];
    expect(bGrant - aGrant).toBeGreaterThanOrEqual(STAGGER_MS);

    // The REAL creates: B creates after its grant, and that grant is at least
    // a stagger after A's — so B's create is at least a stagger after A's
    // grant, expressed against A's actual create time (A's dispatch may have
    // been slow). No fixed floor on the create gap: the gate spaces grants,
    // so a slow first create legitimately shortens the gap between creates.
    const aCreate = state.createdAtMs[aSession];
    const bCreate = state.createdAtMs[bSession];
    expect(bCreate).toBeGreaterThan(aCreate);
    expect(bCreate - aCreate).toBeGreaterThanOrEqual(STAGGER_MS - (aCreate - aGrant));
  }, TEST_TIMEOUT_MS);

  it('scenario b: a halt recorded mid-pass stops the sibling run before its session start', async () => {
    const fixture = await startFixture({ secondRun: true });

    const startA = await fixture.start(1, ['--max-active-runs', '2']);
    expect(startA.code).toBe(0);
    const startB = await fixture.startSecond!(1, ['--max-active-runs', '2']);
    expect(startB.code).toBe(0);

    // Start the pass without awaiting it, then wait until exactly one session
    // create exists on the fake server (the first run's dispatch).
    const passPromise = fixture.runPass(['--max-active-runs', '2', '--pass-concurrency=2']);
    // A no-op consumer so a poll failure never leaves an unhandled rejection.
    void passPromise.catch(() => {});
    let firstState: FakeServerState | null = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await readFakeState(fixture.fakeOpencodeUrl);
      if (state.createdIds.length === 1) {
        firstState = state;
        break;
      }
      if (state.createdIds.length > 1) {
        throw new Error(`the sibling run created its session before the halt: ${state.createdIds.length} creates`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(firstState, 'one session create within 15 s').not.toBeNull();
    const firstSession = firstState!.createdIds[0];

    try {
      // The halt goes through the runtime's halt port — not the CLI, whose
      // captured io is shared with the still-running pass.
      await fixture.runtime.conductor.halt.set({ halted: true, nowIso: new Date().toISOString() });
      const pass = await passPromise;

      // A halted `--once` pass completes (never refuses): pollConductorPasses
      // sets its exit code only for a refused pass, so a halted pass exits 0.
      expect(pass.code).toBe(0);

      // Still exactly one create: the sibling never started a session.
      const state = await readFakeState(fixture.fakeOpencodeUrl);
      expect(state.createdIds).toEqual([firstSession]);

      // The run whose attempt holds the created session dispatched; the other
      // run's attempt never got one and its run is parked `halted`.
      const attemptFirst = await fixture.runtime.execution.attemptRepository.findAttemptById(fixture.attemptId);
      const attemptSecond = await fixture.runtime.execution.attemptRepository.findAttemptById(fixture.attemptId2!);
      expect(attemptFirst).not.toBeNull();
      expect(attemptSecond).not.toBeNull();
      const siblingRunId = attemptFirst!.sessionId === firstSession
        ? fixture.runId2!
        : fixture.runId;
      const siblingAttempt = attemptFirst!.sessionId === firstSession ? attemptSecond! : attemptFirst!;
      expect(siblingAttempt.sessionId).toBeNull();
      const siblingRun = await runRecordOf(fixture, siblingRunId);
      expect(siblingRun).not.toBeNull();
      expect(siblingRun!.parked).not.toBeNull();
      expect(siblingRun!.parked!.reason).toBe('halted');
    } finally {
      await fixture.runtime.conductor.halt.set({ halted: false, nowIso: new Date().toISOString() });
    }
  }, TEST_TIMEOUT_MS);
});
