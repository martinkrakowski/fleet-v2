// Forge read wiring: the CLI runtime exposes the PR-state read bound to the
// installation's owner/repo and the forge-evidence runner in forge mode
// github, and leaves it unconfigured in mode none.
/**
 * Covers the two wiring cases from AM4b-2 step 5.2: mode github answers a
 * read through the stub runner with the installation's -R, and mode none
 * never reads and never calls a stub runner.
 */

import { describe, expect, it } from 'vitest';

import { PULL_REQUEST_VIEW_FIELDS } from '@fleet/work-execution';
import type { FleetInstallation, ForgeSectionV2 } from '@fleet/installation';

import { createFleetCliRuntime } from '../composition.js';

const MERGED_FIXTURE = JSON.stringify({
  baseRefName: 'main',
  closedAt: '2026-10-25T20:12:08Z',
  headRefName: 'feat/example-lane',
  headRefOid: '3dd5d90509461e3d2154b52da28671aeffa84130',
  mergeCommit: { oid: '3fe9fac07688024ae64dc5a3da66010e4418d628' },
  mergedAt: '2026-10-25T20:12:08Z',
  number: 202,
  state: 'MERGED',
});

/** Minimal v2 installation: one local host with a declared container runner. */
function makeInstallation(forge: ForgeSectionV2): FleetInstallation {
  return {
    schemaVersion: 2,
    hosts: {
      local: {
        transport: 'local',
        worktreeRoot: '/tmp/fleet-o8-worktrees',
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
    forge,
  };
}

function makeGhRunner() {
  const calls: string[][] = [];
  const forgeGhRunner = async (args: readonly string[]) => {
    calls.push([...args]);
    return { exitCode: 0, stdout: MERGED_FIXTURE, stderr: '' };
  };
  return { calls, forgeGhRunner };
}

describe('forge read wiring', () => {
  it('mode github binds the read to the installation owner/repo and the runner', async () => {
    const { calls, forgeGhRunner } = makeGhRunner();
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({
        mode: 'github',
        owner: 'example-owner',
        repo: 'example-repo',
      }),
      forgeGhRunner,
    });

    const result = await runtime.execution.forgeRead.readPullRequest({
      ref: { kind: 'number', number: 202 },
    });

    expect(result).toEqual({
      outcome: 'found',
      pullRequest: expect.objectContaining({ number: 202, state: 'merged' }),
    });
    expect(calls).toEqual([
      ['pr', 'view', '202', '-R', 'example-owner/example-repo', '--json', PULL_REQUEST_VIEW_FIELDS],
    ]);
    expect(runtime.execution.forgeRead.isConfigured()).toBe(true);
  });

  it('mode none leaves the read unconfigured and never calls a stub runner', async () => {
    const { calls, forgeGhRunner } = makeGhRunner();
    const runtime = createFleetCliRuntime({
      installation: makeInstallation({ mode: 'none' }),
      forgeGhRunner,
    });

    expect(runtime.execution.forgeRead.isConfigured()).toBe(false);
    const result = await runtime.execution.forgeRead.readPullRequest({
      ref: { kind: 'number', number: 202 },
    });

    expect(result).toEqual({ outcome: 'unavailable', reason: 'forge read is not configured' });
    expect(calls).toHaveLength(0);
  });
});
