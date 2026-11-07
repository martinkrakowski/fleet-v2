/**
 * CO14 CLI tests: `release install | swap | rollback` through
 * `manageReleaseFromPayload` with a fake lease and a fake executor, and through
 * the registered command group with a real in-memory runtime (whose
 * coordination store holds no grant). The root does not exist, so the real
 * store adapter reads an empty store and nothing touches the filesystem.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { loadInstallation, type FleetInstallation } from '@fleet/installation';
import type {
  ActionAuthorizationPort,
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
  ConductorDriverLeaseRecord,
  ConductorDriverLeasePort,
} from '@fleet/work-execution';

import { CliUsageError } from '../commands/payload.js';
import { createFleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import { manageReleaseFromPayload, printLeftovers, releaseAuthorization, releaseCommands } from '../release.js';

const ROOT = '/nonexistent-fleet-release-root-co14';
const SOURCE = '/nonexistent-fleet-v2-source-co14';
const SHA = 'a'.repeat(40);
const NOW = '2026-11-06T10:00:00.000Z';
const PROJECT = 'fleet-v2';

const LIVE_LEASE: ConductorDriverLeaseRecord = {
  version: 1,
  holderId: 'driver-1',
  fence: 1,
  leaseUntilIso: '2026-11-06T10:05:00.000Z',
};

class RecordingExecutor implements CommandExecutorPort {
  readonly runs: string[][] = [];
  async run(argv: readonly string[], _options?: CommandRunOptions): Promise<CommandRunResult> {
    this.runs.push([...argv]);
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

/** No grant is recorded: every resolve is blocked. */
const NO_GRANT: ActionAuthorizationPort = {
  resolveActionAuthorization: async () => ({ outcome: 'blocked', reason: 'no recorded decision' }),
  consumeActionAuthorization: async () => ({ outcome: 'refused', reason: 'no grant' }),
};

function deps(lease: ConductorDriverLeaseRecord | null = null): {
  lease: ConductorDriverLeasePort;
  authorization: ActionAuthorizationPort;
  executor: RecordingExecutor;
  nowIso: () => string;
  env: () => Record<string, string | undefined>;
} {
  return {
    lease: { read: async () => lease } as unknown as ConductorDriverLeasePort,
    authorization: NO_GRANT,
    executor: new RecordingExecutor(),
    nowIso: () => NOW,
    env: () => ({ PATH: '/usr/bin' }),
  };
}

const installPayload = { action: 'install', root: ROOT, sha: SHA, source: SOURCE };

const createdDirs: string[] = [];
afterEach(() => {
  for (const directory of createdDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Load a v2 installation file that must be valid; the test fails loudly otherwise. */
function loadValidInstallation(file: string): FleetInstallation {
  const loaded = loadInstallation({ file });
  if (loaded.status !== 'loaded') {
    throw new Error(`expected a valid installation file: ${loaded.status}`);
  }
  return loaded.installation;
}

describe('release command', () => {
  it('install without apply returns the plan and runs no command', async () => {
    const d = deps();
    const result = await manageReleaseFromPayload(installPayload, d);
    expect(result).toEqual({
      outcome: 'planned',
      action: 'install',
      target: SHA,
      current: null,
      previous: null,
      kept: [],
      wouldPrune: [],
      lease: 'free',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('install with apply and no project is refused', async () => {
    const d = deps();
    expect(await manageReleaseFromPayload({ ...installPayload, apply: true }, d)).toEqual({
      outcome: 'refused',
      reason: 'authority-required',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('install with apply and no recorded grant is refused', async () => {
    const d = deps();
    expect(await manageReleaseFromPayload({ ...installPayload, apply: true, project: PROJECT }, d)).toEqual({
      outcome: 'refused',
      reason: 'authority-refused',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('a free-text --authority flag is a usage error, never authority', async () => {
    const d = deps();
    await expect(
      manageReleaseFromPayload({ ...installPayload, apply: true, authority: 'owner-said-yes' }, d),
    ).rejects.toBeInstanceOf(CliUsageError);
    expect(d.executor.runs).toEqual([]);
  });

  it('the registered release group refuses apply on a runtime with no recorded grant', async () => {
    // CO14c: the command runs only on the served root, so the runtime carries
    // an installation whose daemon entry point runs from the root's `current`,
    // and the root exists.
    const root = mkdtempSync(path.join(tmpdir(), 'fleet-release-co14-'));
    createdDirs.push(root);
    const stateDir = mkdtempSync(path.join(tmpdir(), 'fleet-release-co14-state-'));
    createdDirs.push(stateDir);
    const installationFile = path.join(stateDir, 'fleet.json');
    writeFileSync(
      installationFile,
      JSON.stringify({
        schemaVersion: 2,
        forge: { mode: 'none' },
        hosts: {
          lane: {
            transport: 'local',
            worktreeRoot: path.join(stateDir, 'worktrees'),
            roles: ['orchestrator', 'lane-runner'],
            runner: { kind: 'opencode', port: 46003 },
          },
        },
        daemon: {
          nodePath: '/usr/bin/node',
          cliPath: `${root}/current/apps/cli/dist/bin.js`,
          stateDir,
          unitDir: path.join(stateDir, 'units'),
          installationFile,
        },
      }),
      'utf8',
    );
    const loaded = loadValidInstallation(installationFile);
    const rt = createFleetCliRuntime({ stateDir, installation: loaded });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['release', 'install', '--root', root, '--sha', SHA, '--source', SOURCE, '--project', PROJECT, '--apply'],
      { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
      rt,
    );
    expect(err.join('')).toBe('');
    expect(code).toBe(1);
    expect(JSON.parse(out.join(''))).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    const authorization = releaseAuthorization(rt);
    expect(
      await authorization.resolveActionAuthorization({
        actionId: `release-install-${SHA}`,
        projectId: PROJECT,
        workOrderId: 'w',
        attemptId: 'a',
        actionKind: 'release-install',
        expectedHeadSha: SHA,
        policyRevision: 'p',
      }),
    ).toMatchObject({ outcome: 'blocked' });
    // A forge action kind is never resolved through the release grant path.
    expect(
      await authorization.resolveActionAuthorization({
        actionId: 'x',
        projectId: PROJECT,
        workOrderId: 'w',
        attemptId: 'a',
        actionKind: 'merge-pr',
        expectedHeadSha: SHA,
        policyRevision: 'p',
      }),
    ).toEqual({ outcome: 'blocked', reason: 'not a release action' });
  });

  it('install with a live driver lease is refused', async () => {
    const d = deps(LIVE_LEASE);
    expect(await manageReleaseFromPayload({ ...installPayload, apply: true, project: PROJECT }, d)).toEqual({
      outcome: 'refused',
      reason: 'driver-lease-live',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('a usage error is a CliUsageError, not a refusal', async () => {
    const d = deps();
    const bad: Array<Record<string, unknown>> = [
      { action: 'install', sha: SHA, source: SOURCE },
      { action: 'install', root: 'relative', sha: SHA },
      { action: 'install', root: '/a/../b', sha: SHA },
      { action: 'install', root: ROOT, sha: 'XYZ' },
      { action: 'install', root: ROOT },
      { action: 'install', root: ROOT, sha: SHA, keep: '1' },
      { action: 'install', root: ROOT, sha: SHA, keep: '65' },
      { action: 'install', root: ROOT, sha: SHA, keep: 'many' },
      { action: 'install', root: ROOT, sha: SHA, bogus: '1' },
      { action: 'install', root: ROOT, sha: SHA, apply: 'maybe' },
      { action: 'install', root: ROOT, sha: SHA, project: '' },
      { action: 'rollback', root: ROOT, sha: SHA },
      { action: 'swap', root: ROOT, sha: SHA, source: SOURCE },
      { action: 'upgrade', root: ROOT, sha: SHA },
    ];
    for (const payload of bad) {
      await expect(manageReleaseFromPayload(payload, d)).rejects.toBeInstanceOf(CliUsageError);
    }
    const handler = releaseCommands['install'];
    await expect(handler({ root: ROOT, sha: SHA, action: 'swap' }, {} as never)).rejects.toBeInstanceOf(CliUsageError);
  });

  it('the command result carries no path and no project or grant value', async () => {
    const d = deps();
    const results = [
      await manageReleaseFromPayload({ ...installPayload, keep: '3' }, d),
      await manageReleaseFromPayload({ ...installPayload, apply: true }, d),
      await manageReleaseFromPayload({ action: 'swap', root: ROOT, sha: SHA, apply: true, project: PROJECT }, d),
      await manageReleaseFromPayload({ action: 'rollback', root: ROOT, apply: true, project: PROJECT }, d),
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(ROOT);
      expect(text).not.toContain(SOURCE);
      expect(text).not.toContain(PROJECT);
      expect(text).not.toContain('nonexistent');
    }
    expect(results[2]).toEqual({ outcome: 'refused', reason: 'not-found' });
    expect(results[3]).toEqual({ outcome: 'refused', reason: 'not-found' });
  });

  // CO14c fix round 4: the release-root-changed refusal prints one line per
  // leftover path for the operator; no other refusal prints any.
  it('prints one line per leftover for the release-root-changed refusal only', () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      printLeftovers({ outcome: 'refused', reason: 'release-root-changed', leftovers: ['/srv/r/.staging-x.home'] });
      printLeftovers({ outcome: 'refused', reason: 'authority-refused' });
      printLeftovers({ outcome: 'refused', reason: 'release-root-changed', leftovers: [] });
      printLeftovers({ outcome: 'refused', reason: 'release-root-changed' });
    } finally {
      process.stdout.write = original;
    }
    expect(written).toEqual(['left in place (not ours to remove): /srv/r/.staging-x.home\n']);
  });
});
