// Lane K6 tests: the CLI composition root wires the claim-triage port
// (decision-kernel plan, 2026-10-16, §5) into CaptureCompletedAttemptNotesUseCase.
//
// Triage stays off unless the installation's v2 decisions block is enabled, a
// key source is declared and the claim-triage consumer carries its own
// `acknowledgeCandidateClaimsLeaveHost: true` acknowledgement. No real
// network and no key material anywhere: the key reader is a stub and the key
// never enters argv, env or logs.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import type { DecisionsSectionV2, FleetInstallation } from '@fleet/installation';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';

const FIXTURE_DIR = new URL(
  '../../../../packages/brief-knowledge/src/infrastructure/adapters/__fixtures__/jev/',
  import.meta.url,
);

/** Proves the fixture dir resolves; the shape of the answers is irrelevant. */
readFileSync(fileURLToPath(new URL('jev-score-response.json', FIXTURE_DIR)), 'utf8');

const PROJECT_ID = 'proj-k6';

const NOTES_REQUEST = {
  projectId: PROJECT_ID,
  attemptId: 'att-k6-1',
  workOrderId: 'wo-k6-1',
  headCommitSha: 'def5678',
  notesMarkdown: '- The CLI root wires claim triage behind the acknowledgement\n',
};

/**
 * A spy transport recording every call. The response body is irrelevant: the
 * triage port never throws, and this suite asserts on the requests made, not
 * on the advice they produce. The body never carries key material.
 */
function spyFetch(): typeof fetch & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

/**
 * Minimal v2 installation, shaped as the parser would produce it: a v2 file
 * always declares a forge mode (D6) and may name zero hosts. Only the
 * decisions block under test is varied.
 */
function installationWithDecisions(
  decisions: FleetInstallation extends { decisions?: infer D } ? D : never,
): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {},
    forge: { mode: 'none' },
    ...(decisions !== undefined ? { decisions } : {}),
  } as FleetInstallation;
}

const JEV_BASE = {
  provider: 'jev',
  model: 'typesafe/jev-1.14',
  keyFile: '/keys/jev.key',
  minConfidence: 0.5,
  monthlyBudgetUsd: 0.01,
  assumedCostPerCallUsd: 0.00002,
  acknowledgeProseLeavesHost: true,
} as const;

/** Jev enabled, but the claim-triage entry carries no acknowledgement. */
const JEV_WITH_UNACKNOWLEDGED_TRIAGE = {
  ...JEV_BASE,
  consumers: {
    'claim-triage': {},
  },
} as unknown as DecisionsSectionV2;

/** Jev enabled with the claim-triage consumer acknowledged: triage is wired. */
const JEV_WITH_ACKNOWLEDGED_TRIAGE: DecisionsSectionV2 = {
  ...JEV_BASE,
  consumers: {
    'claim-triage': { acknowledgeCandidateClaimsLeaveHost: true },
  },
};

/** Jev enabled and acknowledged, but the key is not readable: no request. */
const JEV_WITH_UNREADABLE_KEY: DecisionsSectionV2 = {
  ...JEV_BASE,
  consumers: {
    'claim-triage': { acknowledgeCandidateClaimsLeaveHost: true },
  },
};

async function capture(runtime: FleetCliRuntime): Promise<{ outcome: string }> {
  const result = await runtime.knowledge.captureCompletedAttemptNotes.captureCompletedAttemptNotes(
    NOTES_REQUEST,
  );
  return { outcome: result.outcome };
}

/** The post-capture triage hook is started, not awaited: give it a beat. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
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
  const directory = path.join(tmpdir(), `fleet-cli-k6-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  createdDirs.add(directory);
  return directory;
}

describe('CLI knowledge composition claim triage wiring', () => {
  it('with no acknowledgement the capture use case gets no triage and no network', async () => {
    const stateDir = newTempStateDir();
    const fetch = spyFetch();
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: installationWithDecisions(JEV_WITH_UNACKNOWLEDGED_TRIAGE),
      adviceFetch: fetch,
      adviceReadKey: async () => 'stub-key-not-real',
    });
    expect((await capture(runtime)).outcome).toBe('captured');
    await settle();
    expect(fetch.calls).toHaveLength(0);
    expect(() => readFileSync(monthReceiptPath(stateDir), 'utf8')).toThrow('ENOENT');
  });

  it('with everything set and an injected fetch a capture triggers exactly one triage request', async () => {
    const stateDir = newTempStateDir();
    const fetch = spyFetch();
    const readKeys: string[] = [];
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: installationWithDecisions(JEV_WITH_ACKNOWLEDGED_TRIAGE),
      adviceFetch: fetch,
      adviceReadKey: async (keyPath) => {
        readKeys.push(keyPath);
        return 'stub-key-not-real';
      },
    });
    expect((await capture(runtime)).outcome).toBe('captured');
    await settle();
    // One candidate, one batch, one reservation: exactly one request.
    expect(fetch.calls).toHaveLength(1);
    // The stub key reader saw exactly the configured keyFile path.
    expect(readKeys).toEqual([JEV_BASE.keyFile]);
    // The request was receipted in the same journal the ranking advice uses.
    const raw = readFileSync(monthReceiptPath(stateDir), 'utf8');
    const lines = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.some((line) => line.kind === 'reserved')).toBe(true);
  });

  it('with no key there is no triage request and no network', async () => {
    const stateDir = newTempStateDir();
    const fetch = spyFetch();
    const runtime = createFleetCliRuntime({
      stateDir,
      installation: installationWithDecisions(JEV_WITH_UNREADABLE_KEY),
      adviceFetch: fetch,
      // The key cannot be read: the request is refused before any network.
      adviceReadKey: async () => {
        throw new Error('no key material');
      },
    });
    expect((await capture(runtime)).outcome).toBe('captured');
    await settle();
    expect(fetch.calls).toHaveLength(0);
  });
});
