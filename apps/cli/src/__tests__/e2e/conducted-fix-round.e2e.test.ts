// Lane E2E-FIX: scenario 6 of the live conducted runs' fix-round bugs
// (KF-16 to KF-21): a real fix round end to end over ssh to localhost. The
// code review FAILs after a passing brief check, the run prepares and
// dispatches a fix attempt on the `fx-1` seat with the fix model, the fix
// lane commits again, the run re-gates, re-reviews, accepts and opens the
// PR. Everything below is skipped unless FLEET_E2E_SSH=1; helpers are copied
// from the accept-park test rather than editing that file.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startConductedFixture, type ConductedFixture } from './conducted.js';

// Two lane sessions plus a fix round took about 112 s on the lane host; CI runners are slower.
const TEST_TIMEOUT_MS = 360000;
/** A fix round adds a prepare, a dispatch, a collect, a gate and two reviews to the happy path. */
const FIX_ROUND_PASS_BUDGET = 24;
// A pause between passes lets the lane end and the forge/review fakes answer
// instead of burning the pass budget on back-to-back waits.
const PASS_PAUSE_MS = 750;
/** The run-driving loop's own wall-clock budget inside the 150 s scenario bound. */
const DRIVE_BUDGET_MS = 300000;

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

/** The last 600 bytes of the fixture's ocm-run stderr log, for a failure message. */
async function ocmRunTailOf(current: ConductedFixture): Promise<string> {
  try {
    const text = await fs.readFile(current.ocmRunStderrLog, 'utf8');
    return text.slice(-600).replace(/\n/g, ' | ');
  } catch {
    return '(no ocm-run stderr log)';
  }
}

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
  let passes = 0;
  for (;;) {
    const run = await runRecordOf(current);
    if (run !== null && run.parked !== null) {
      return passes;
    }
    if (passes >= maxPasses || Date.now() >= deadline) {
      throw new Error(
        `the run did not park within ${maxPasses} passes (${passes} driven, ocm-run: ${await ocmRunTailOf(current)}; journal: ` +
        `${(await resultReasonCodesOf(current)).join(',')})`,
      );
    }
    const pass = await current.runPass();
    expect(pass.code).toBe(0);
    passes += 1;
    await new Promise((resolve) => setTimeout(resolve, PASS_PAUSE_MS));
    // Every collected head needs its own acceptance receipts (a fix round
    // opens a new assessment at the new head); the fixture helper answers
    // false while the collected head or its assessment is not there yet, so
    // retrying on each pass is harmless.
    const entries = await journalOf(current);
    if (entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'collected')) {
      await current.recordAcceptanceReceipts();
    }
  }
}

/** One flattened argv line per ocm-run call, in call order. */
async function ocmRunArgvLinesOf(current: ConductedFixture): Promise<readonly string[]> {
  const text = await fs.readFile(current.ocmRunArgvLog, 'utf8');
  return text.split('\n').filter((line) => line.length > 0);
}

describe.skipIf(process.env.FLEET_E2E_SSH !== '1')('conducted fix round over ssh (E2E-FIX)', () => {
  it('scenario 6: a conducted fix round dispatches the fx-1 seat with the fix model, re-gates, re-reviews and opens the PR', async () => {
    const current = await startFixture({
      committingLane: true,
      reviewVerdicts: ['PASS', 'FAIL'],
      fixModel: 'example-provider/fix-model',
      captureBriefs: 'brief-captures',
    });
    const startResult = await current.start(1);
    expect(startResult.code).toBe(0);

    await driveUntilParked(current, FIX_ROUND_PASS_BUDGET);

    // The whole walk, first attempt and fix round alike, journalled its
    // reason codes in order: the first attempt reached a passing brief check
    // and a failing code review, the fix attempt was prepared, dispatched,
    // collected, re-gated, passed both reviews, was accepted and its PR opened.
    expectCodesInOrder(await resultReasonCodesOf(current), [
      'dispatch-started',
      'collected',
      'gate-passed',
      'review-passed', // brief-check
      'review-failed', // code-review
      'prepared',
      'dispatch-started',
      'collected',
      'gate-passed',
      'review-passed', // brief-check
      'review-passed', // code-review
      'accepted',
      'pr-opened',
    ]);

    // The run parked for the owner's merge, back in `merging`, on fix round 1.
    const run = await runRecordOf(current);
    expect(run).not.toBeNull();
    expect(run!.prNumber).toBe(7);
    expect(run!.parked).toMatchObject({
      reason: 'owner-merge',
      qualifier: null,
      parkedFrom: 'merging',
    });
    expect(run!.parkCount).toBe(1);
    expect(run!.round).toBe(1);

    // Exactly two attempts: the first pass and the fix attempt. The fix
    // attempt record carries the fix seat and a collected head the first
    // attempt never reached.
    expect(run!.attemptIds).toHaveLength(2);
    const firstAttempt = await current.runtime.execution.attemptRepository
      .findAttemptById(run!.attemptIds[0]!);
    const fixAttempt = await current.runtime.execution.attemptRepository
      .findAttemptById(run!.attemptIds[1]!);
    expect(firstAttempt).not.toBeNull();
    expect(fixAttempt).not.toBeNull();
    expect(fixAttempt!.kind).toBe('fix');
    expect(fixAttempt!.seatSelection?.seatId).toBe('fx-1');
    expect(fixAttempt!.artifacts).not.toBeNull();
    expect(firstAttempt!.artifacts).not.toBeNull();
    expect(fixAttempt!.artifacts!.headCommit).not.toBe(firstAttempt!.artifacts!.headCommit);

    // The lane's work: exactly two commits on the run's branch since the
    // base (one per dispatched session), both touching only the owned README.
    const worktrees = readdirSync(current.worktreeRoot).filter((name) => /^[0-9a-f]{32}$/.test(name));
    expect(worktrees).toHaveLength(1);
    const worktreePath = path.join(current.worktreeRoot, worktrees[0]);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    expect(branch).toBe(`fleet/${current.runId}`);
    const commits = git(['rev-list', `${current.baseCommit}..HEAD`], worktreePath)
      .split('\n')
      .filter((line) => line.length > 0);
    expect(commits).toHaveLength(2);
    for (const commit of commits) {
      const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', commit], worktreePath)
        .split('\n')
        .filter((line) => line.length > 0);
      expect(changed).toEqual(['packages/example/README.md']);
    }

    // Exactly two ocm-run dispatches: the first on the implementer model,
    // the second — the fix attempt — on the fix model.
    const dispatches = (await ocmRunArgvLinesOf(current)).filter((line) => line.includes('--detach'));
    expect(dispatches).toHaveLength(2);
    expect(dispatches[0]).toContain('-m example/implementer-model');
    expect(dispatches[0]).not.toContain('example-provider/fix-model');
    expect(dispatches[1]).toContain('-m example-provider/fix-model');
    expect(dispatches[1]).not.toContain('example/implementer-model');

    // The brief the fix lane received: the numbered review finding, the
    // frozen proof commands and the original brief appended verbatim below
    // its marker.
    const captureDir = path.join(current.dir, 'brief-captures');
    const captured = readdirSync(captureDir).filter((name) => name.startsWith('brief-'));
    expect(captured).toHaveLength(2);
    const briefs = await Promise.all(
      captured.map((name) => fs.readFile(path.join(captureDir, name), 'utf8')),
    );
    const fixBrief = briefs.find((text) => text.includes('[blocker] packages/example/README.md:1'));
    expect(fixBrief).toBeDefined();
    expect(fixBrief).toContain('Proof commands');
    expect(fixBrief).toContain('true');
    expect(fixBrief).toContain('<!-- fleet:original-brief -->');
  }, TEST_TIMEOUT_MS);
});
