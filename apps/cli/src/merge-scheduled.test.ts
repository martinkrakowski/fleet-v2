/**
 * OD7a1: `merge import --scheduled`. Quiet grant refusals (grant-missing,
 * grant-expired, grant-revoked, grant-not-approved, plus an absent
 * `daemon.shadow.grantId`) exit 0 as `shadow-intake skipped <reason>`; loud
 * grant/authorization refusals and every non-grant `ImportTrainStateRefusal`
 * reason exit 1 as refused; the grant handle is picked up at run time from
 * the loaded installation's `daemon.shadow.grantId`.
 */

import { describe, expect, it } from 'vitest';

import { createFleetCliRuntime } from './composition.js';
import { runCli, type CliIo } from './index.js';
import { parseMergeImportFlags } from './merge.js';
import type { FleetInstallation } from '@fleet/installation';

const HEAD_A = '0123456789abcdef0123456789abcdef01234567';

function installationWithShadowGrant(grantId: string | undefined): FleetInstallation {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      lane: {
        transport: 'local',
        worktreeRoot: '/srv/fleet/worktrees',
        roles: ['orchestrator'],
        runner: { kind: 'opencode', port: 46000 },
      },
    },
    daemon: {
      nodePath: '/srv/fleet/node/bin/node',
      cliPath: '/srv/fleet/cli/fleet-v2.mjs',
      stateDir: '/srv/fleet/state',
      unitDir: '/srv/fleet/units',
      installationFile: '/srv/fleet/fleet.json',
      ...(grantId === undefined
        ? { shadow: { legacyStateDir: '/srv/fleet/legacy-state' } }
        : {
            shadow: { legacyStateDir: '/srv/fleet/legacy-state', grantId },
          }),
    },
  };
}

interface InjectedCall {
  readonly grantId: string | null | undefined;
  readonly projectId: string | null | undefined;
  readonly apply: boolean;
}

function runtimeWithStub(
  installation: FleetInstallation | undefined,
  stubResult: () => unknown,
): { runtime: ReturnType<typeof createFleetCliRuntime>; calls: InjectedCall[] } {
  const calls: InjectedCall[] = [];
  const runtime = createFleetCliRuntime({
    ...(installation !== undefined ? { installation } : {}),
  });
  (runtime.execution as { importTrainState: unknown }).importTrainState = {
    importTrainState: async (request: InjectedCall) => {
      calls.push(request);
      return stubResult();
    },
  };
  return { runtime, calls };
}

async function runScheduledImport(
  runtime: ReturnType<typeof createFleetCliRuntime>,
  extraArgv: readonly string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await runCli(
    ['merge', 'import', '--repository', 'fleet/v2', '--legacy-state-dir', '/tmp/legacy', ...extraArgv],
    io,
    runtime,
  );
  return { code, out: out.join(''), err: err.join('') };
}

const SCHEDULED_APPLY = ['--apply', '--scheduled', '--project', 'project-1'];

describe('merge import --scheduled (OD7a1)', () => {
  it.each([
    'grant-missing',
    'grant-expired',
    'grant-revoked',
    'grant-not-approved',
  ])('%s exits 0 as shadow-intake skipped', async (reason) => {
    const { runtime } = runtimeWithStub(
      installationWithShadowGrant('grant-1'),
      () => ({ outcome: 'refused', reason }),
    );
    const result = await runScheduledImport(runtime, SCHEDULED_APPLY);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`shadow-intake skipped ${reason}\n`);
  });

  it('an absent daemon.shadow.grantId under --apply --scheduled skips quietly at exit 0, never exit 2', async () => {
    const { runtime, calls } = runtimeWithStub(
      installationWithShadowGrant(undefined),
      () => {
        throw new Error('importTrainState must not be called');
      },
    );
    const result = await runScheduledImport(runtime, SCHEDULED_APPLY);
    expect(result.code).toBe(0);
    expect(result.out).toBe('shadow-intake skipped grant-missing\n');
    expect(calls).toEqual([]);
  });

  it('picks the grant up at run time from daemon.shadow.grantId when --grant is omitted', async () => {
    const { runtime, calls } = runtimeWithStub(
      installationWithShadowGrant('grant-9'),
      () => ({
        outcome: 'applied',
        imported: 1,
        refused: 0,
        unknownLineNumbers: [],
        notImportableBase: 0,
        alreadyQueued: 0,
        parkedLines: 0,
        chainFiles: 0,
        batchLines: 0,
        inprogressLines: 0,
        unknownBySource: { queue: [], parked: [], inprogress: [] },
        keys: [
          { pullRequest: 42, headOid: HEAD_A, base: 'main', source: 'queue', disposition: 'would-import' },
        ],
        keysTruncated: false,
      }),
    );
    const result = await runScheduledImport(runtime, SCHEDULED_APPLY);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ grantId: 'grant-9', projectId: 'project-1', apply: true });
  });

  it.each([
    'grant-wrong-scope',
    'grant-wrong-repository',
    'grant-wrong-project',
    'grant-id-mismatch',
    'grant-digest-mismatch',
    'authorization-unavailable',
  ])('%s stays loud at exit 1', async (reason) => {
    const { runtime } = runtimeWithStub(
      installationWithShadowGrant('grant-1'),
      () => ({ outcome: 'refused', reason }),
    );
    const result = await runScheduledImport(runtime, SCHEDULED_APPLY);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ outcome: 'refused', reason });
  });

  it.each([
    'invalid-request',
    'invalid-repository',
    'invalid-state-dir',
    'project-required',
    'journal-unavailable',
    'journal-refused',
    'legacy-unreadable',
    'secret-shaped',
  ])('%s stays loud at exit 1', async (reason) => {
    const { runtime } = runtimeWithStub(
      installationWithShadowGrant('grant-1'),
      () => ({ outcome: 'refused', reason }),
    );
    const result = await runScheduledImport(runtime, SCHEDULED_APPLY);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ outcome: 'refused', reason });
  });

  it('parseMergeImportFlags accepts --apply --scheduled without --grant', () => {
    const flags = parseMergeImportFlags({
      repository: 'fleet/v2',
      legacyStateDir: '/tmp/legacy',
      apply: true,
      scheduled: true,
      project: 'project-1',
    });
    expect(flags.scheduled).toBe(true);
    expect(flags.grantId).toBeNull();
    expect(flags.projectId).toBe('project-1');
  });

  it('parseMergeImportFlags still refuses --apply without --grant when --scheduled is absent', () => {
    expect(() =>
      parseMergeImportFlags({
        repository: 'fleet/v2',
        legacyStateDir: '/tmp/legacy',
        apply: true,
        project: 'project-1',
      }),
    ).toThrow();
  });
});
