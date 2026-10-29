/**
 * Lane Q1a: the conductor end-to-end fixture exercised. Everything here is
 * skipped unless FLEET_E2E_SSH=1 (the one non-skipped test just notices a
 * lost fixture). With it set, the fixture drives a real ssh hop to localhost,
 * the recorded-host executor resolution, the fake opencode server and the v2
 * installation file.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isFleetInstallationV2, parseInstallation } from '@fleet/installation';
import { ExecutorForHost, SshExecutor } from '@fleet/work-execution';
import type { CommandExecutorPort } from '@fleet/work-execution';

import { resolveE2eDir, startE2eFixture } from './fixture.js';

/** The legacy executor must never be used: the record confirms an ssh host. */
class ThrowingExecutor implements CommandExecutorPort {
  async run(): Promise<never> {
    throw new Error('legacy executor used despite a recorded host');
  }
}

describe.skipIf(process.env.FLEET_E2E_SSH !== '1')(
  'the conductor end-to-end fixture',
  () => {
    it(
      'drives a real ssh hop, the recorded-host executor, the fake server and the installation',
      { timeout: 120000 },
      async () => {
        const fixture = await startE2eFixture();
        const originalHome = process.env.HOME;
        process.env.HOME = fixture.home;
        try {
          const hop = await new SshExecutor({ host: fixture.alias }).run([
            'sh',
            '-c',
            'echo e2e-hop',
          ]);
          expect(hop.exitCode).toBe(0);
          expect(hop.stdout.trim()).toBe('e2e-hop');

          const helper = new ExecutorForHost({
            hosts: fixture.hosts,
            legacyExecutor: new ThrowingExecutor(),
          });
          const resolved = helper.executorForRecordedHost({
            kind: 'opencode',
            remotePort: fixture.sshPort,
            host: 'fleet-e2e',
            hostName: 'lane-host',
            agent: null,
            model: null,
            variant: null,
          });
          expect(resolved.ok).toBe(true);
          if (!resolved.ok) return;
          const pwd = await resolved.executor.run(['pwd']);
          expect(pwd.exitCode).toBe(0);
          expect(pwd.stdout.trim().length).toBeGreaterThan(0);

          const info = await (await fetch(`${fixture.fakeOpencodeUrl}/api/info`)).json();
          expect(info).toEqual({ version: '2.0.28' });

          const raw = await fs.readFile(
            path.join(fixture.stateDir, 'installation', 'fleet.json'),
            'utf8',
          );
          const parsed = parseInstallation(JSON.parse(raw));
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          expect(isFleetInstallationV2(parsed.installation)).toBe(true);
          if (!isFleetInstallationV2(parsed.installation)) return;
          const laneRunnerHosts = Object.entries(parsed.installation.hosts).filter(
            ([, host]) => host.roles.includes('lane-runner'),
          );
          expect(laneRunnerHosts).toHaveLength(1);
          expect(laneRunnerHosts[0]?.[0]).toBe('lane-host');
        } finally {
          process.env.HOME = originalHome;
          await fixture.stop();
        }
      },
    );
  },
);

describe('the e2e fixture is importable', () => {
  it('exposes startE2eFixture and the ssh fixture script exists and is executable', async () => {
    expect(typeof startE2eFixture).toBe('function');
    const script = path.join(resolveE2eDir(), 'ssh-fixture.sh');
    const stat = await fs.stat(script);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
  });
});
