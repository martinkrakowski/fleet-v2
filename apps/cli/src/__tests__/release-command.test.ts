/**
 * CO14 CLI tests: `release install | swap | rollback` through
 * `manageReleaseFromPayload` with a fake lease and a fake executor. The root
 * does not exist, so the real store adapter reads an empty store and nothing
 * touches the filesystem.
 */

import { describe, expect, it } from 'vitest';

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
  ConductorDriverLeaseRecord,
  ConductorDriverLeasePort,
} from '@fleet/work-execution';

import { CliUsageError } from '../commands/payload.js';
import { manageReleaseFromPayload, releaseCommands } from '../release.js';

const ROOT = '/nonexistent-fleet-release-root-co14';
const SOURCE = '/nonexistent-fleet-v2-source-co14';
const SHA = 'a'.repeat(40);
const NOW = '2026-11-06T10:00:00.000Z';
const AUTHORITY = 'owner-deploy-2026-11-06';

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

function deps(lease: ConductorDriverLeaseRecord | null = null): {
  lease: ConductorDriverLeasePort;
  executor: RecordingExecutor;
  nowIso: () => string;
  env: () => Record<string, string | undefined>;
} {
  return {
    lease: { read: async () => lease } as unknown as ConductorDriverLeasePort,
    executor: new RecordingExecutor(),
    nowIso: () => NOW,
    env: () => ({ PATH: '/usr/bin' }),
  };
}

const installPayload = { action: 'install', root: ROOT, sha: SHA, source: SOURCE };

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

  it('install with apply and no authority is refused', async () => {
    const d = deps();
    expect(await manageReleaseFromPayload({ ...installPayload, apply: true }, d)).toEqual({
      outcome: 'refused',
      reason: 'authority-required',
    });
    expect(d.executor.runs).toEqual([]);
  });

  it('install with a live driver lease is refused', async () => {
    const d = deps(LIVE_LEASE);
    expect(await manageReleaseFromPayload({ ...installPayload, apply: true, authority: AUTHORITY }, d)).toEqual({
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

  it('the command result carries no path and no authority value', async () => {
    const d = deps();
    const results = [
      await manageReleaseFromPayload({ ...installPayload, keep: '3' }, d),
      await manageReleaseFromPayload({ ...installPayload, apply: true }, d),
      await manageReleaseFromPayload({ action: 'swap', root: ROOT, sha: SHA, apply: true, authority: AUTHORITY }, d),
      await manageReleaseFromPayload({ action: 'rollback', root: ROOT, apply: true, authority: AUTHORITY }, d),
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(ROOT);
      expect(text).not.toContain(SOURCE);
      expect(text).not.toContain(AUTHORITY);
      expect(text).not.toContain('nonexistent');
    }
    expect(results[2]).toEqual({ outcome: 'refused', reason: 'not-found' });
    expect(results[3]).toEqual({ outcome: 'refused', reason: 'not-found' });
  });
});
