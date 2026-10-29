// Lane Q1c: scenarios 4-5 of the production-quality plan §4.1, driven for
// real over ssh to localhost. Everything below is skipped unless
// FLEET_E2E_SSH=1; with it a conducted run walks the post-dispatch pipeline
// — collect, gate, brief-check, code-review, accept, open-PR, CI — through
// the real `bin/ocm-run`, the fixture's fake opencode server and a fake lane
// that commits and ends. Every scenario is bounded to 150 s and every fixture
// is stopped (which also restores any fix-placement chmod and PATH) even on
// failure.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startConductedFixture, type ConductedFixture } from './conducted.js';

const TEST_TIMEOUT_MS = 150000;
const HAPPY_PATH_PASS_BUDGET = 12;
// The same budget as the happy path: the lane's session stays active for the fake
// client's busy window, so the early passes only wait.
const TERMINATION_PASS_BUDGET = 12;
// A pause between passes lets the lane end and the forge/review fakes answer
// instead of burning the pass budget on back-to-back waits.
const PASS_PAUSE_MS = 750;
/** The run-driving loop's own wall-clock budget inside the 150 s scenario bound. */
const DRIVE_BUDGET_MS = 120000;

const liveFixtures = new Set<ConductedFixture>();

async function startFixture(options?: Parameters<typeof startConductedFixture>[0]) {
  const current = await startConductedFixture(options);
  liveFixtures.add(current);
  return current;
}

afterEach(async () => {
  // LIFO: a later fixture stacked its PATH entries on top of an earlier one;
  // each stop is isolated so one failure never skips another fixture's cleanup.
  const current = [...liveFixtures].reverse();
  liveFixtures.clear();
  const failures: unknown[] = [];
  for (const instance of current) {
    try {
      await instance.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
});

function runRecordOf(current: ConductedFixture) {
  return current.runtime.conductor.laneRunRepository.get(current.runId);
}

function journalOf(current: ConductedFixture) {
  return current.runtime.conductor.laneRunJournal.listForRun(current.runId);
}

/** The journal's result reason codes in record order. */
async function resultReasonCodesOf(current: ConductedFixture): Promise<readonly string[]> {
  const entries = await journalOf(current);
  return entries
    .filter((entry) => entry.kind === 'result' && entry.reasonCode !== null)
    .map((entry) => entry.reasonCode as string);
}

/** `expected` must appear inside `actual` in order (a subsequence of reason codes). */
function expectCodesInOrder(actual: readonly string[], expected: readonly string[]): void {
  let cursor = 0;
  for (const code of actual) {
    if (cursor < expected.length && code === expected[cursor]) {
      cursor += 1;
    }
  }
  expect(
    cursor,
    `expected the journal reasons [${expected.join(', ')}] in order inside [${actual.join(', ')}]`,
  ).toBe(expected.length);
}

function git(args: readonly string[], cwd: string): string {
  return String(execFileSync('git', [...args], { cwd, encoding: 'utf8', timeout: 20000 })).trim();
}

/**
 * Drive live passes until the run parks (or the budget runs out), recording
 * the acceptance receipts once the journal shows `collected`. Answers the
 * number of passes driven.
 */
async function driveUntilParked(current: ConductedFixture, maxPasses: number): Promise<number> {
  const deadline = Date.now() + DRIVE_BUDGET_MS;
  let receiptsRecorded = false;
  let passes = 0;
  for (;;) {
    const run = await runRecordOf(current);
    if (run !== null && run.parked !== null) {
      return passes;
    }
    if (passes >= maxPasses || Date.now() >= deadline) {
      throw new Error(
        `the run did not park within ${maxPasses} passes (${passes} driven, journal: ` +
        `${(await resultReasonCodesOf(current)).join(',')})`,
      );
    }
    const pass = await current.runPass();
    expect(pass.code).toBe(0);
    passes += 1;
    await new Promise((resolve) => setTimeout(resolve, PASS_PAUSE_MS));
    const entries = await journalOf(current);
    if (
      !receiptsRecorded &&
      entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'collected')
    ) {
      receiptsRecorded = await current.recordAcceptanceReceipts();
    }
  }
}

describe.skipIf(process.env.FLEET_E2E_SSH !== '1')('conducted accept + park over ssh (Q1c)', () => {
  it('scenario 5: a conducted run reaches the owner-merge park through gate, reviews, acceptance and open-PR', async () => {
    const current = await startFixture({ committingLane: true });
    const startResult = await current.start(1);
    expect(startResult.code).toBe(0);

    await driveUntilParked(current, HAPPY_PATH_PASS_BUDGET);

    // The whole post-dispatch walk journalled its reason codes in order.
    expectCodesInOrder(await resultReasonCodesOf(current), [
      'dispatch-started',
      'collected',
      'gate-passed',
      'review-passed',
      'review-passed',
      'accepted',
      'pr-opened',
    ]);

    // The lane's commit: exactly one, on the run's branch, inside the owned package.
    const worktrees = readdirSync(current.worktreeRoot).filter((name) => /^[0-9a-f]{32}$/.test(name));
    expect(worktrees).toHaveLength(1);
    const worktreePath = path.join(current.worktreeRoot, worktrees[0]);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    expect(branch).toBe(`fleet/${current.runId}`);
    const commits = git(['rev-list', `${current.baseCommit}..HEAD`], worktreePath)
      .split('\n')
      .filter((line) => line.length > 0);
    expect(commits).toHaveLength(1);
    const changed = git(['diff', '--name-only', current.baseCommit, 'HEAD'], worktreePath)
      .split('\n')
      .filter((line) => line.length > 0);
    expect(changed).toEqual(['packages/example/README.md']);

    // The run parked for the owner's merge, with the stub PR's number.
    const run = await runRecordOf(current);
    expect(run).not.toBeNull();
    expect(run!.prNumber).toBe(7);
    expect(run!.parked).toMatchObject({
      reason: 'owner-merge',
      qualifier: null,
      parkedFrom: 'merging',
    });
    expect(run!.parkCount).toBe(1);

    // The `gh` stub saw exactly one call — the PR create for the run's branch — and no merge.
    const ghLines = (await fs.readFile(current.ghArgvLog, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(ghLines).toHaveLength(1);

    expect(ghLines[0]).toContain('pr create');
    expect(ghLines[0]).toContain(`--head fleet/${current.runId}`);
    expect(ghLines[0]).not.toContain('merge');

    // The park raised one attention item and asked one keyed owner question.
    const attention = await current.runtime.coordination.attentionItemRepository.list({
      projectId: 'project-example-1',
    });
    expect(attention).toHaveLength(1);
    const questions = await current.runtime.coordination.ownerQuestionRepository.list();
    expect(questions).toHaveLength(1);

    // The fake lane's session ended by itself, interrupted at most once.
    const stateResponse = await fetch(`${current.fakeOpencodeUrl}/__state`);
    const state = (await stateResponse.json()) as {
      sessions: Record<string, string>;
      interrupts: string[];
    };
    expect(Object.values(state.sessions)).toEqual(['ended']);
    expect(state.interrupts.length).toBeLessThanOrEqual(1);
  }, TEST_TIMEOUT_MS);

  it('scenario 4: a refused fix-prepare parks the run within two passes (KF-9)', async () => {
    const current = await startFixture({ committingLane: true, reviewVerdicts: ['PASS', 'FAIL'] });
    const startResult = await current.start(1);
    expect(startResult.code).toBe(0);

    // Drive passes until parked; once the brief-check review has passed, break
    // the fix brief's placement (chmod 0444 on the worktree's brief) so the
    // fix round's `tee` fails on the host.
    const deadline = Date.now() + DRIVE_BUDGET_MS;
    let placementFailed = false;
    let reviewFailedPass: number | null = null;
    let passes = 0;
    for (;;) {
      const run = await runRecordOf(current);
      if (run !== null && run.parked !== null) {
        break;
      }
      if (passes >= TERMINATION_PASS_BUDGET || Date.now() >= deadline) {
        throw new Error(
          `the refused fix-prepare did not park within ${TERMINATION_PASS_BUDGET} passes ` +
          `(${passes} driven, journal: ${(await resultReasonCodesOf(current)).join(',')})`,
        );
      }
      const pass = await current.runPass();
      expect(pass.code).toBe(0);
      passes += 1;
      await new Promise((resolve) => setTimeout(resolve, PASS_PAUSE_MS));
      const codes = await resultReasonCodesOf(current);
      if (!placementFailed && codes.includes('review-passed')) {
        await current.makeFixPlacementFail();
        placementFailed = true;
      }
      if (reviewFailedPass === null && codes.includes('review-failed')) {
        reviewFailedPass = passes;
      }
    }
    const parkPass = passes;

    // The journal: review-failed, then exactly one prepare-refused under a
    // round-1 prepare key, then the spent-key park.
    const entries = await journalOf(current);
    const reviewFailedIndex = entries.findIndex((entry) => entry.kind === 'result' && entry.reasonCode === 'review-failed');
    expect(reviewFailedIndex).toBeGreaterThanOrEqual(0);
    const prepareRefusalIndexes = entries
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.kind === 'result' &&
          entry.reasonCode === 'prepare-refused' &&
          entry.key !== null &&
          entry.key.startsWith(`${current.runId}/r1/prepare/`),
      )
      .map(({ index }) => index);
    expect(prepareRefusalIndexes).toHaveLength(1);
    const parkedConductIndex = entries.findIndex((entry) => entry.kind === 'conduct' && entry.state === 'parked');
    // In order: the failed review, then the one refused fix-prepare, then the park.
    expect(reviewFailedIndex).toBeLessThan(prepareRefusalIndexes[0]!);
    expect(prepareRefusalIndexes[0]!).toBeLessThan(parkedConductIndex);

    const run = await runRecordOf(current);
    expect(run).not.toBeNull();
    expect(run!.parked).toMatchObject({ reason: 'step-refused', qualifier: 'prepare' });
    expect(run!.parkCount).toBe(1);

    // A `parked` conduct entry was journalled.
    expect(entries.some((entry) => entry.kind === 'conduct' && entry.state === 'parked')).toBe(true);

    // The park raised one attention item (no owner question for step-refused).
    const attention = await current.runtime.coordination.attentionItemRepository.list({
      projectId: 'project-example-1',
    });
    expect(attention).toHaveLength(1);

    // No identical intent was re-sent and no duplicate-key refusal appeared.
    const intentKeys = entries
      .filter((entry) => entry.kind === 'intent' && entry.key !== null)
      .map((entry) => entry.key as string);
    expect(new Set(intentKeys).size).toBe(intentKeys.length);
    expect(codesOf(entries).includes('duplicate-key')).toBe(false);

    // From the review-failed journal entry to the park: at most two passes.
    expect(reviewFailedPass).not.toBeNull();
    expect(parkPass - (reviewFailedPass as number)).toBeLessThanOrEqual(2);
  }, TEST_TIMEOUT_MS);
});

/** Every result reason code of one journal, in record order. */
function codesOf(entries: readonly { kind: string; reasonCode: string | null }[]): string[] {
  return entries
    .filter((entry) => entry.kind === 'result' && entry.reasonCode !== null)
    .map((entry) => entry.reasonCode as string);
}
