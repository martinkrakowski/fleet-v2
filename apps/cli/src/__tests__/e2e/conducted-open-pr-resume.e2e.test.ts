// Lane R4a: resume an `ambiguous open-pr` park by adopting its settled open
// PR. Everything below is skipped unless FLEET_E2E_SSH=1; with it a conducted
// run walks the pipeline for real over ssh to localhost. The fixture's gh
// stub makes the first `gh pr create` answer without a reported pull-request
// number, so `performOpenPr` journals `forge-ambiguous` and G3b parks
// `ambiguous open-pr` (the PR exists but gh did not report its number). Then
// `conductor resume <runId>` is invoked and the run is driven on: the resume
// re-reads the PR by branch, adopts it (record `prNumber` set, spent key
// reconciled), and the decider's G3b0 enters `watching-ci` — with exactly one
// PR-create invocation ever and no second `open-pr` intent.

import { promises as fs } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../index.js';
import { startConductedFixture, type ConductedFixture } from './conducted.js';

const TEST_TIMEOUT_MS = 150000;
const PASS_PAUSE_MS = 750;
const DRIVE_BUDGET_MS = 120000;
const PASS_BUDGET = 16;

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

/** Every result reason code of one journal, in record order. */
function codesOf(entries: readonly { kind: string; reasonCode: string | null }[]): string[] {
  return entries
    .filter((entry) => entry.kind === 'result' && entry.reasonCode !== null)
    .map((entry) => entry.reasonCode as string);
}

/**
 * Drive live passes until the run parks `ambiguous open-pr`, recording the
 * acceptance receipts once the journal shows `collected`. Answers the number
 * of passes driven.
 */
async function driveUntilAmbiguousOpenPrParked(current: ConductedFixture, maxPasses: number): Promise<number> {
  const deadline = Date.now() + DRIVE_BUDGET_MS;
  let receiptsRecorded = false;
  let passes = 0;
  for (;;) {
    const run = await runRecordOf(current);
    if (
      run !== null &&
      run.parked !== null &&
      run.parked.reason === 'ambiguous' &&
      run.parked.qualifier === 'open-pr'
    ) {
      return passes;
    }
    if (passes >= maxPasses || Date.now() >= deadline) {
      throw new Error(
        `the run did not park ambiguous open-pr within ${maxPasses} passes (${passes} driven, journal: ${(await resultReasonCodesOf(current)).join(',')})`,
      );
    }
    const pass = await current.runPass();
    expect(pass.code).toBe(0);
    passes += 1;
    await new Promise((resolve) => setTimeout(resolve, PASS_PAUSE_MS));
    const entries = await journalOf(current);
    if (!receiptsRecorded && entries.some((entry) => entry.kind === 'result' && entry.reasonCode === 'collected')) {
      receiptsRecorded = await current.recordAcceptanceReceipts();
    }
  }
}

/** Drive live passes until the run is unparked and a `watching-ci` conduct is journalled. */
async function driveUntilWatchingCi(current: ConductedFixture, maxPasses: number): Promise<number> {
  const deadline = Date.now() + DRIVE_BUDGET_MS;
  let passes = 0;
  for (;;) {
    const run = await runRecordOf(current);
    const entries = await journalOf(current);
    if (
      run !== null &&
      run.parked === null &&
      entries.some((entry) => entry.kind === 'conduct' && entry.state === 'watching-ci')
    ) {
      return passes;
    }
    if (passes >= maxPasses || Date.now() >= deadline) {
      throw new Error(
        `the run did not reach watching-ci within ${maxPasses} passes (${passes} driven, journal: ${(await resultReasonCodesOf(current)).join(',')})`,
      );
    }
    const pass = await current.runPass();
    expect(pass.code).toBe(0);
    passes += 1;
    await new Promise((resolve) => setTimeout(resolve, PASS_PAUSE_MS));
  }
}

describe.skipIf(process.env.FLEET_E2E_SSH !== '1')('conducted ambiguous open-pr resume over ssh (R4a)', () => {
  it('parks ambiguous open-pr, resumes, adopts the PR and reaches watching-ci with no second create', async () => {
    const current = await startFixture({
      committingLane: true,
      failPrCreateOnce: true,
      prViewOpenAfterCreate: true,
    });
    const startResult = await current.start(1);
    expect(startResult.code).toBe(0);

    await driveUntilAmbiguousOpenPrParked(current, PASS_BUDGET);

    // The run is parked `ambiguous open-pr` with the ambiguous forge result.
    const parkedRun = await runRecordOf(current);
    expect(parkedRun).not.toBeNull();
    expect(parkedRun!.parked).toMatchObject({
      reason: 'ambiguous',
      qualifier: 'open-pr',
      parkedFrom: 'opening-pr',
    });
    expect(parkedRun!.parkCount).toBe(1);
    expect(parkedRun!.prNumber).toBeNull();
    const parkedEntries = await journalOf(current);
    expect(codesOf(parkedEntries)).toContain('forge-ambiguous');
    expect(parkedEntries.some((entry) => entry.kind === 'conduct' && entry.state === 'parked')).toBe(true);

    // Invoke `conductor resume <runId>` through the CLI.
    const io = { stdout: () => {}, stderr: () => {} };
    const resumeCode = await runCli(
      ['conductor', 'resume', current.runId],
      io,
      current.runtime,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { stateDir: current.stateDir },
    );
    expect(resumeCode).toBe(0);

    await driveUntilWatchingCi(current, PASS_BUDGET);

    // The resume adopted the settled open PR: prNumber set, park gone, the
    // run reached watching-ci, and `resumed` is among the reason codes.
    const run = await runRecordOf(current);
    expect(run).not.toBeNull();
    expect(run!.prNumber).toBe(7);
    expect(run!.parked).toBeNull();
    const entries = await journalOf(current);
    expect(entries.some((entry) => entry.kind === 'conduct' && entry.state === 'watching-ci')).toBe(true);
    expect(await resultReasonCodesOf(current)).toContain('resumed');

    // Exactly one PR-create invocation in the gh argv log: no second create.
    const ghLines = (await fs.readFile(current.ghArgvLog, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    const createLines = ghLines.filter((line) => line.includes('pr create'));
    expect(createLines).toHaveLength(1);

    // No second open-pr intent: exactly one open-pr step intent remains.
    const openPrIntents = entries.filter(
      (entry) => entry.kind === 'intent' && entry.key !== null && entry.key.includes('/open-pr/'),
    );
    expect(openPrIntents).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});
