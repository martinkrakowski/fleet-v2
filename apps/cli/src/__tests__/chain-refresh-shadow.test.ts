/**
 * CO8 shadow wiring: the real daemon composition runs the chain-refresh job in
 * shadow mode. A tick records a shadow observation (a job event carrying only
 * codes) and the gh executor sees reads only: no merge, no push, no forge write.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';
import {
  ChainRepositoryAdapter,
  createChainRecord,
  sha256HexDigest,
} from '@fleet/work-execution';

import { createFleetCliRuntime } from '../composition.js';

const MAIN = 'fedcba9876543210fedcba9876543210fedcba98';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO = { owner: 'fleet', repo: 'fleet-v2' };
const NOW = new Date().toISOString();
const DEADLINE = new Date(Date.parse(NOW) + 45_000).toISOString();

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const installation = {
  schemaVersion: 2,
  hosts: {
    local: {
      transport: 'local',
      worktreeRoot: '/tmp/fleet-co8-worktrees',
      roles: ['orchestrator', 'lane-runner'],
      runner: { kind: 'opencode', port: 46000 },
    },
  },
  forge: { mode: 'github', github: { owner: REPO.owner, repo: REPO.repo } },
} as unknown as FleetInstallation;

describe('chain refresh daemon job, shadow composition', () => {
  it('a tick records a shadow observation and the executor sees zero writes', async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-co8-shadow-'));
    dirs.push(stateDir);
    const chains = new ChainRepositoryAdapter({ stateDir });
    const created = createChainRecord({
      repository: REPO,
      chainName: 'example',
      expectedHeadSha: SHA,
      actionKey: 'chain-start-1',
      createdAtIso: NOW,
    });
    if (!created.ok) throw new Error('setup');
    await chains.recordChainIntent({ record: created.record, deadlineIso: DEADLINE });
    await chains.recordChainOutcome({
      repository: REPO,
      chainName: 'example',
      actionKey: 'chain-start-1',
      expectedRevision: 1,
      state: 'started',
      reason: null,
      deadlineIso: DEADLINE,
    });

    const ghCalls: string[][] = [];
    const runtime = createFleetCliRuntime({
      stateDir,
      installation,
      env: { FLEET_GH_CONFIG_MERGE: '/tmp/fleet-co8-merge-config' },
      daemonNow: () => NOW,
      forgeActionDelegate: {
        runGh: async (args) => {
          ghCalls.push([...args]);
          const ref = args.find((arg) => arg.includes('/git/ref/heads/main'));
          return ref === undefined
            ? { exitCode: 1, stdout: '', stderr: 'unexpected' }
            : { exitCode: 0, stdout: JSON.stringify({ ref: 'refs/heads/main', object: { sha: MAIN } }), stderr: '' };
        },
      },
      forgeGhRunner: async (args) => {
        ghCalls.push([...args]);
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    const digest = sha256HexDigest(`${REPO.owner}/${REPO.repo}`).slice(0, 12);
    const jobId = `chain-refresh:${digest}`;
    const result = await runtime.daemon.runDaemonTick.runTick({
      tickId: 'tick-01M6RFDJ9JJAHKXN1AEVN2Z3FW',
      repositories: [
        {
          owner: REPO.owner,
          repo: REPO.repo,
          repoDigest: digest,
          projectId: 'proj-1',
          policy: {
            policyRevision: 'aaaaaaaaaaaa',
            shadow: true,
            unattended: false,
            requiredContexts: ['gate', 'premerge'],
            updateBranch: false,
            macosProcedure: null,
            maxAttempts: 9,
            checksGraceMinutes: { gate: 30, premerge: 30 },
            veto: { mode: 'off', holdConfidence: 0.8 },
          },
        },
      ],
      budgetSeconds: 45,
      deadlineIso: DEADLINE,
      intervalSeconds: 60,
      settleSeconds: 20,
      jobFilter: [jobId],
      forgeReachable: true,
    });
    expect(result.outcome).toBe('completed');

    const events = await runtime.daemon.events.readAfterCursor(null);
    expect(events.ok).toBe(true);
    const jobEvents = events.ok ? events.events.filter((event) => event.jobId === jobId) : [];
    expect(jobEvents).toHaveLength(1);
    expect(jobEvents[0]).toMatchObject({ kind: 'job', outcome: 'skipped', reasonCode: 'shadow-would-refresh-1' });

    // Zero writes: every gh call is a plain read, never a POST, a merge or a push.
    expect(ghCalls.length).toBeGreaterThan(0);
    for (const args of ghCalls) {
      expect(args).not.toContain('--method');
      expect(args).not.toContain('POST');
      expect(args.some((arg) => arg.endsWith('/merges'))).toBe(false);
      expect(args[0]).toBe('api');
    }

    // The record is untouched: shadow wrote no intent.
    const after = await chains.readChain({ repository: REPO, chainName: 'example', deadlineIso: DEADLINE });
    expect(after.status === 'ok' && after.record.refresh).toBeNull();
  });
});
