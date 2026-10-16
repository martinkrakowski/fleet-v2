// Lane D5b tests: the CLI composition root wires the ranking advice port
// (decision port plan, 2026-10-16) into ProposeBriefContextUseCase only.
//
// The jev provider is exercised against the owner-recorded fixture under
// packages/brief-knowledge: the stub fetch replays the recorded answers bound
// to the claims they scored (the recorded state hash covers the recorded
// candidate order; a different candidate order re-keys the same answers onto
// the same claims). No real network and no key material anywhere: the key
// reader is a stub and the key never enters argv, env or logs.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import type { KnowledgeEntryRecord, RankingAdviceDecisions } from '@fleet/brief-knowledge';
import type { FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';

const FIXTURE_DIR = new URL(
  '../../../../packages/brief-knowledge/src/infrastructure/adapters/__fixtures__/jev/',
  import.meta.url,
);
const FIXTURE_RESPONSE = JSON.parse(
  readFileSync(fileURLToPath(new URL('jev-score-response.json', FIXTURE_DIR)), 'utf8'),
) as {
  model: string;
  answers: Record<
    string,
    { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
  >;
  usage: { input_tokens: number; output_tokens: number; cost: number };
  provider: string;
  id: string;
};

/** The claim the owner-recorded request scored as highly relevant (k0). */
const RECORDED_HIGH_CLAIM =
  'Date strings are parsed with parseISO; never use new Date(string).';
const RECORDED_LOW_CLAIM = 'The README badge links to the CI workflow.';

const TASK_SUMMARY = 'Update the README badge in src/utils/docs';
const PROJECT_ID = 'proj-d5b';
const PATH_PREFIXES = ['src/utils'];

const JEV_DECISIONS: RankingAdviceDecisions = {
  provider: 'jev',
  model: 'typesafe/jev-1.14',
  keyFile: '/keys/jev.key',
  minConfidence: 0.5,
  monthlyBudgetUsd: 0.01,
  assumedCostPerCallUsd: 0.00002,
  acknowledgeProseLeavesHost: true,
};

function entry(
  id: string,
  claimText: string,
  pathPrefixes: readonly string[],
): KnowledgeEntryRecord {
  return {
    id,
    version: '1.0.0',
    projectId: PROJECT_ID,
    sourceAttemptId: 'attempt-1',
    sourceCommitSha: '0'.repeat(40),
    claimText,
    pathPrefixes,
    sharedAcrossProjects: false,
    disposition: 'accepted',
    verification: 'supported',
    checkerId: null,
    dispositionReason: null,
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: '2026-10-16T00:00:00.000Z',
    updatedAtIso: '2026-10-16T00:00:00.000Z',
  };
}

/**
 * Spy transport replaying the owner-recorded fixture. The recorded answers
 * belong to the claims they scored, so the replay binds them by claimText:
 * the recorded high answer goes to the same claim, everything else gets the
 * recorded irrelevant answer. Every call is recorded; the body never carries
 * key material.
 */
function replayFetch(): typeof fetch & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = JSON.parse(String(init?.body ?? '{}')) as { state?: string };
    const state = JSON.parse(body.state ?? '{}') as {
      candidates?: Record<string, string>;
    };
    const answers: Record<string, unknown> = {};
    for (const [key, claim] of Object.entries(state.candidates ?? {})) {
      answers[key] =
        claim === RECORDED_HIGH_CLAIM
          ? FIXTURE_RESPONSE.answers.k0
          : FIXTURE_RESPONSE.answers.k1;
    }
    return new Response(JSON.stringify({ ...FIXTURE_RESPONSE, answers }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

/** Minimal v2 installation carrying only the decisions block under test. */
function installationWithDecisions(
  decisions: RankingAdviceDecisions | undefined,
): FleetInstallation {
  return { schemaVersion: 2, ...(decisions !== undefined ? { decisions } : {}) };
}

async function seedKeepers(runtime: FleetCliRuntime): Promise<void> {
  await runtime.knowledge.knowledgeEntryRepository.saveEntry(
    entry('entry-readme', RECORDED_LOW_CLAIM, PATH_PREFIXES),
  );
  await runtime.knowledge.knowledgeEntryRepository.saveEntry(
    entry('entry-date', RECORDED_HIGH_CLAIM, PATH_PREFIXES),
  );
}

async function propose(runtime: FleetCliRuntime): Promise<{
  outcome: string;
  proposals: readonly { knowledgeEntryId: string; proposedBecause: string }[];
}> {
  const result = await runtime.knowledge.proposeBriefContext.proposeBriefContext({
    projectId: PROJECT_ID,
    laneId: 'lane-d5b',
    taskSummary: TASK_SUMMARY,
    pathPrefixes: PATH_PREFIXES,
  });
  return result.outcome === 'proposed'
    ? { outcome: 'proposed', proposals: result.proposals }
    : { outcome: result.outcome, proposals: [] };
}

function monthReceiptPath(stateDir: string): string {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(stateDir, 'decision-receipts', `${monthKey}.jsonl`);
}

const createdDirs = new Set<string>();

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function newTempStateDir(): string {
  const directory = path.join(tmpdir(), `fleet-cli-d5b-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  createdDirs.add(directory);
  return directory;
}

describe('CLI knowledge composition ranking advice wiring', () => {
  it('with no decisions block: same order as before and fetch is never called', async () => {
    const fetch = replayFetch();
    const runtime = createFleetCliRuntime({ adviceFetch: fetch });
    await seedKeepers(runtime);
    const result = await propose(runtime);
    expect(result.outcome).toBe('proposed');
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual([
      'entry-readme',
      'entry-date',
    ]);
    expect(result.proposals.every((p) => !p.proposedBecause.includes('decision('))).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  it("with provider 'none': same order as before and fetch is never called", async () => {
    const fetch = replayFetch();
    const runtime = createFleetCliRuntime({
      installation: installationWithDecisions({ provider: 'none' }),
      adviceFetch: fetch,
    });
    await seedKeepers(runtime);
    const result = await propose(runtime);
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual([
      'entry-readme',
      'entry-date',
    ]);
    expect(fetch.calls).toHaveLength(0);
  });

  it('with a jev block but no stateDir: fetch is never called', async () => {
    const fetch = replayFetch();
    const runtime = createFleetCliRuntime({
      installation: installationWithDecisions(JEV_DECISIONS),
      adviceFetch: fetch,
      adviceReadKey: async () => 'stub-key-not-real',
    });
    await seedKeepers(runtime);
    const result = await propose(runtime);
    expect(result.outcome).toBe('proposed');
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual([
      'entry-readme',
      'entry-date',
    ]);
    expect(fetch.calls).toHaveLength(0);
  });

  it('with a jev block, a stateDir and the recorded fixture: the keepers are reordered and receipted', async () => {
    const stateDir = newTempStateDir();
    const fetch = replayFetch();
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: installationWithDecisions(JEV_DECISIONS),
      adviceFetch: fetch,
      adviceReadKey: async () => 'stub-key-not-real',
    });
    await seedKeepers(runtime);
    const result = await propose(runtime);
    expect(result.outcome).toBe('proposed');
    // The recorded judgement (the date claim is highly relevant) reorders the
    // deterministic set: the lexical runner-up leads.
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual([
      'entry-date',
      'entry-readme',
    ]);
    expect(result.proposals[0]?.proposedBecause).toContain(
      `decision(${FIXTURE_RESPONSE.model}, c=0.91)`,
    );
    expect(fetch.calls).toHaveLength(1);

    const raw = readFileSync(monthReceiptPath(stateDir), 'utf8');
    const lines = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.kind).toBe('reserved');
    expect(lines[1]?.kind).toBe('settled');
    expect(lines[1]?.provider).toBe('jev');
    expect(lines[1]?.lexicalOrder).toEqual(['entry-readme', 'entry-date']);
    expect(lines[1]?.decidedOrder).toEqual(['entry-date', 'entry-readme']);
  });
});
