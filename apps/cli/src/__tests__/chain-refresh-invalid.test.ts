/**
 * CO8a: through the real daemon composition, an invalid
 * `policy.daemon.chainRefresh` mode (`live` or any unknown value) no longer
 * refuses the merge policy. A tick runs the merge pass normally, skips the
 * chain-refresh job with the typed outcome `chain-refresh-mode-invalid`, and
 * raises exactly one policy-level attention item naming the key. The raw value
 * is never echoed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';
import { sha256HexDigest } from '@fleet/work-execution';

import { createFleetCliRuntime } from '../composition.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OWNER = 'fleet-org';
const REPO_A = 'alpha';
const NOW = new Date().toISOString();
const DEADLINE = new Date(Date.parse(NOW) + 45_000).toISOString();

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function installationBadChainRefresh(value: unknown): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      'lane-host': {
        transport: 'local',
        worktreeRoot: '/srv/fleet/worktrees',
        roles: ['orchestrator', 'lane-runner'],
        runner: {
          kind: 'opencode',
          port: 46000,
          capabilities: {
            networkEgressRestricted: true,
            cpuAndMemoryLimited: true,
            processTreeTermination: true,
            filesystemScope: 'scoped-worktree',
          },
          maxLanes: 2,
        },
      },
    },
    tools: ['opencode'],
    seats: [
      {
        id: 'implementer',
        tool: 'opencode',
        model: 'example-provider/example-model',
        roles: ['implementer'],
        costClass: 'plan-quota',
      },
    ],
    chains: { implementer: [{ seatId: 'implementer' }] },
    policy: {
      merge: {
        repos: {
          [`${OWNER}/${REPO_A}`]: {
            projectId: 'proj-alpha',
            shadow: true,
            unattended: true,
            requiredContexts: ['gate'],
          },
        },
      },
      daemon: { chainRefresh: value as never },
    },
    shelf: { provider: 'local' },
    forge: { mode: 'github', owner: OWNER, repo: REPO_A },
    verification: { procedures: { gate: { command: 'yarn', args: ['test'] } } },
  } as unknown as FleetInstallation;
}

function greenPullRequest(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          headRefOid: HEAD,
          mergeStateStatus: 'CLEAN',
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
            },
          },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    },
  });
}

function ghStub(calls: string[][]) {
  return async (args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    calls.push([...args]);
    if (args[0] === 'api' && args[1] === 'rate_limit') {
      return { exitCode: 0, stdout: '{"resources":{}}', stderr: '' };
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      return { exitCode: 0, stdout: greenPullRequest(), stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected gh call' };
  };
}

async function enqueue(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  repo: string,
  pullRequest = 1,
): Promise<void> {
  const decision = await runtime.execution.enqueueMerge.enqueue({
    repository: { owner: OWNER, repo },
    pullRequest,
    headOid: HEAD,
    tier: 0,
    enqueuedBy: 'conductor',
    runId: null,
    entryId: runtime.conductor.newUlid(),
    successorEntryId: runtime.conductor.newUlid(),
    enqueuedAtIso: new Date().toISOString(),
    deadlineIso: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(decision.outcome).toBe('created');
}

describe('chain refresh daemon job, invalid mode (CO8a)', () => {
  for (const bad of ['livee', 'live']) {
    it(`with chainRefresh ${JSON.stringify(bad)} a tick runs the merge pass, skips chain refresh with chain-refresh-mode-invalid and raises exactly one attention item`, async () => {
      const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-co8a-'));
      dirs.push(stateDir);
      const ghCalls: string[][] = [];
      const runtime = createFleetCliRuntime({
        stateDir,
        installation: installationBadChainRefresh(bad),
        env: { FLEET_GH_CONFIG_MERGE: '/tmp/fleet-co8a-merge-config' },
        daemonNow: () => NOW,
        forgeGhRunner: ghStub(ghCalls),
      });

      await enqueue(runtime, REPO_A);

      const digest = sha256HexDigest(`${OWNER}/${REPO_A}`).slice(0, 12);
      const jobId = `chain-refresh:${digest}`;
      const result = await runtime.daemon.runDaemonTick.runTick({
        tickId: 'tick-01M6RFDJ9JJAHKXN1AEVN2Z3FW',
        repositories: [
          {
            owner: OWNER,
            repo: REPO_A,
            repoDigest: digest,
            projectId: 'proj-alpha',
            policy: {
              policyRevision: 'aaaaaaaaaaaa',
              shadow: true,
              unattended: true,
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
        forgeReachable: true,
      });

      expect(result.outcome).toBe('completed');
      expect(result.exitCode).toBe(0);
      const byJob = Object.fromEntries(
        (result.status?.jobs ?? []).map((job) => [job.jobId, job]),
      );
      // The merge pass runs normally.
      expect(byJob[`merge-pass:${digest}`]).toMatchObject({ outcome: 'completed' });
      // The chain-refresh job is skipped with the typed outcome.
      expect(byJob[jobId]).toMatchObject({ outcome: 'skipped', reasonCode: 'chain-refresh-mode-invalid' });

      // Exactly one policy-level attention item naming the key, never the value.
      const items = await runtime.coordination.listAttentionItems.listAttentionItems({});
      const matching = items.items.filter((entry) => entry.item.kind === 'chain-refresh-mode-invalid');
      expect(matching).toHaveLength(1);
      expect(matching[0].item.summary).toContain('policy.daemon.chainRefresh');
      expect(matching[0].item.summary).not.toContain(String(bad));

      // The raw value appears nowhere in the tick result.
      expect(JSON.stringify(result)).not.toContain(String(bad));

      // No forge writes: every gh call is a plain read.
      expect(ghCalls.length).toBeGreaterThan(0);
      for (const args of ghCalls) {
        expect(args).not.toContain('--method');
        expect(args).not.toContain('POST');
        expect(args.some((arg) => arg.endsWith('/merges'))).toBe(false);
        expect(args[0]).toBe('api');
      }
    });
  }
});
