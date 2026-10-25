/**
 * `fleet-v2 projects` (lane P6a): list, show, add, edit and retire project
 * profiles against a temp state directory and a v2 installation (hosts `orch`
 * and `runner-1`, verification procedure `verify`), plus the v1/absent
 * installation path where host and procedure name checks are not wired.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';

import { RegisterWorkOrderUseCase, WorkOrderRepositoryAdapter } from '@fleet/work-execution';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli, type CliIo } from '../index.js';
import type { ProjectsCliOptions } from '../projects.js';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

afterAll(() => {
  for (const directory of createdDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'fleet-projects-command-'));
  createdDirs.push(directory);
  return directory;
}

function mockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

/** A loader-valid v2 installation with hosts `orch` and `runner-1` and procedure `verify`. */
function v2Installation(): FleetInstallation {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      orch: {
        transport: 'local',
        worktreeRoot: '/srv/worktrees/orch',
        roles: ['orchestrator', 'verifier'],
      },
      'runner-1': {
        transport: 'ssh',
        sshAlias: 'r1',
        worktreeRoot: '/srv/worktrees/runner-1',
        roles: ['lane-runner'],
        runner: { kind: 'opencode', port: 4166 },
      },
    },
    verification: {
      procedures: {
        verify: { command: 'yarn', args: ['test'] },
      },
    },
  };
}

function makeV2Runtime(stateDir: string): FleetCliRuntime {
  return createFleetCliRuntime({
    stateDir,
    installation: v2Installation(),
  });
}

async function runProjects(
  argv: readonly string[],
  runtime: FleetCliRuntime,
  options?: ProjectsCliOptions,
): Promise<{ code: number; out: string; err: string }> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(
    ['projects', ...argv],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
  return { code, out: stdout.join(''), err: stderr.join('') };
}

const BASE_ADD_FLAGS: readonly string[] = [
  '--project-id',
  'alpha',
  '--display-name',
  'Alpha Service',
  '--repository',
  'https://example.com/alpha.git',
  '--dispatcher-host',
  'orch',
  '--policy-revision',
  'pol-1',
  '--max-lanes',
  '2',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fleet-v2 projects', () => {
  it('adds a project and lists it at rev 0', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    const added = await runProjects(
      [
        'add',
        ...BASE_ADD_FLAGS,
        '--default-branch',
        'main',
        '--clones',
        'runner-1=/srv/repos/alpha:/srv/worktrees/runner-1',
        '--gate-procedures',
        'verify',
        '--allowed-prefixes',
        'packages/a,packages/b',
        '--runner-capabilities',
        'isolated=true,mode=strict',
        '--yes',
      ],
      runtime,
    );
    expect(added.code).toBe(0);
    expect(added.err).toBe('');
    expect(added.out).toContain('register project alpha\n');
    expect(added.out).toContain('  displayName: Alpha Service\n');
    expect(added.out).toContain('  designatedDispatcherHost: orch\n');
    expect(added.out).toContain('registered project alpha (rev 0)\n');

    const listed = await runProjects(['list'], runtime);
    expect(listed.code).toBe(0);
    expect(listed.out).toBe('alpha  active  rev 0  https://example.com/alpha.git  probe none\n');
  });

  it('refuses add with an unknown dispatcher host on a v2 installation (exit 1)', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    const added = await runProjects(
      [
        'add',
        '--project-id',
        'alpha',
        '--display-name',
        'Alpha Service',
        '--repository',
        'https://example.com/alpha.git',
        '--dispatcher-host',
        'unknown-host',
        '--policy-revision',
        'pol-1',
        '--max-lanes',
        '2',
        '--yes',
      ],
      runtime,
    );
    expect(added.code).toBe(1);
    expect(added.err).toContain(
      'designatedDispatcherHost unknown-host is not a host in the installation',
    );
  });

  it('prints nothing changed and exits 1 when add is declined, leaving list empty', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    const added = await runProjects(['add', ...BASE_ADD_FLAGS], runtime, {
      confirm: async () => false,
    });
    expect(added.code).toBe(1);
    expect(added.out).toContain('nothing changed\n');

    const listed = await runProjects(['list'], runtime);
    expect(listed.code).toBe(0);
    expect(listed.out).toBe('');
  });

  it('edits only the given fields, prints the diff, replaces whole lists and advances to rev 1', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    await runProjects(
      [
        'add',
        ...BASE_ADD_FLAGS,
        '--allowed-prefixes',
        'packages/a,packages/b',
        '--yes',
      ],
      runtime,
    );

    const edited = await runProjects(['edit', 'alpha', '--max-lanes', '3'], runtime, {
      confirm: async () => true,
    });
    expect(edited.code).toBe(0);
    expect(edited.out).toBe(
      '- maxConcurrentLanes: 2\n+ maxConcurrentLanes: 3\nupdated project alpha (rev 1)\n',
    );

    const listedAfterFirstEdit = await runProjects(['list'], runtime);
    expect(listedAfterFirstEdit.out).toBe(
      'alpha  active  rev 1  https://example.com/alpha.git  probe none\n',
    );

    const listReplaced = await runProjects(
      ['edit', 'alpha', '--allowed-prefixes', 'apps/cli', '--yes'],
      runtime,
    );
    expect(listReplaced.code).toBe(0);
    expect(listReplaced.out).toContain(
      '- defaultAllowedPathPrefixes: packages/a, packages/b\n+ defaultAllowedPathPrefixes: apps/cli\n',
    );
    expect(listReplaced.out).toContain('updated project alpha (rev 2)\n');

    const shown = await runProjects(['show', 'alpha', '--json'], runtime);
    const parsed = JSON.parse(shown.out) as {
      outcome: string;
      profile: {
        maxConcurrentLanes: number;
        defaultAllowedPathPrefixes: string[];
        displayName: string;
        revision: number;
      };
    };
    expect(parsed.outcome).toBe('found');
    expect(parsed.profile.maxConcurrentLanes).toBe(3);
    expect(parsed.profile.defaultAllowedPathPrefixes).toEqual(['apps/cli']);
    expect(parsed.profile.displayName).toBe('Alpha Service');
    expect(parsed.profile.revision).toBe(2);
  });

  it('refuses edit with no field flags as a usage error (exit 2)', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    await runProjects(['add', ...BASE_ADD_FLAGS, '--yes'], runtime);

    const edited = await runProjects(['edit', 'alpha'], runtime);
    expect(edited.code).toBe(2);
    expect(edited.err).toContain('projects edit requires at least one field flag');
  });

  it('refuses edit with exit 1 when another write advances the revision before confirm resolves', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    await runProjects(['add', ...BASE_ADD_FLAGS, '--yes'], runtime);

    const edited = await runProjects(['edit', 'alpha', '--max-lanes', '5'], runtime, {
      confirm: async () => {
        const concurrent = await runtime.coordination.updateProjectProfile.updateProjectProfile({
          projectId: 'alpha',
          expectedRevision: 0,
          changes: { displayName: 'Concurrent Update' },
        });
        expect(concurrent.outcome).toBe('updated');
        return true;
      },
    });
    expect(edited.code).toBe(1);
    expect(edited.err).toContain('project alpha is at revision 1, not 0; read it again');
  });

  it('retires an active profile and refuses a second retire with exit 1', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    await runProjects(['add', ...BASE_ADD_FLAGS, '--yes'], runtime);

    const retired = await runProjects(['retire', 'alpha', '--yes'], runtime);
    expect(retired.code).toBe(0);
    expect(retired.out).toContain('retire project alpha at rev 0\n');
    expect(retired.out).toContain('retired project alpha\n');

    const listedRetired = await runProjects(['list', '--status', 'retired'], runtime);
    expect(listedRetired.code).toBe(0);
    expect(listedRetired.out).toBe(
      'alpha  retired  rev 1  https://example.com/alpha.git  probe none\n',
    );

    const listedActive = await runProjects(['list', '--status', 'active'], runtime);
    expect(listedActive.code).toBe(0);
    expect(listedActive.out).toBe('');

    const secondRetire = await runProjects(['retire', 'alpha', '--yes'], runtime);
    expect(secondRetire.code).toBe(1);
    expect(secondRetire.err).toContain('project alpha is already retired');
  });

  it('prints clones and last probe check lines in show and parses --json output', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    await runProjects(
      [
        'add',
        ...BASE_ADD_FLAGS,
        '--default-branch',
        'main',
        '--clones',
        'runner-1=/srv/repos/alpha:/srv/worktrees/runner-1',
        '--gate-procedures',
        'verify',
        '--allowed-prefixes',
        'packages/a',
        '--yes',
      ],
      runtime,
    );

    const probeRecorded = await runtime.coordination.recordProjectProbe.recordProjectProbe({
      projectId: 'alpha',
      expectedRevision: 0,
      receipt: {
        probedAtIso: '2026-10-25T04:00:00.000Z',
        probedFrom: 'orch',
        checks: [
          {
            name: 'repo-reachable',
            host: null,
            result: 'pass',
            detail: 'HEAD is main',
          },
          {
            name: 'clone-worktree',
            host: 'runner-1',
            result: 'fail',
            detail: 'missing /srv/repos/alpha',
          },
        ],
      },
    });
    expect(probeRecorded.outcome).toBe('recorded');

    const shown = await runProjects(['show', 'alpha'], runtime);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(
      'clone runner-1: /srv/repos/alpha (worktrees /srv/worktrees/runner-1)\n',
    );
    expect(shown.out).toContain(
      'lastProbe: probedAt 2026-10-25T04:00:00.000Z from orch\n',
    );
    expect(shown.out).toContain('  pass  repo-reachable  -  HEAD is main\n');
    expect(shown.out).toContain(
      '  fail  clone-worktree  runner-1  missing /srv/repos/alpha\n',
    );

    const listed = await runProjects(['list'], runtime);
    expect(listed.code).toBe(0);
    expect(listed.out).toBe('alpha  active  rev 1  https://example.com/alpha.git  probe fail\n');

    const listJson = await runProjects(['list', '--json'], runtime);
    expect(listJson.code).toBe(0);
    const parsedList = JSON.parse(listJson.out) as {
      outcome: string;
      profiles: Array<{ projectId: string; revision: number }>;
    };
    expect(parsedList.outcome).toBe('listed');
    expect(parsedList.profiles).toHaveLength(1);
    expect(parsedList.profiles[0]?.projectId).toBe('alpha');

    const showJson = await runProjects(['show', 'alpha', '--json'], runtime);
    expect(showJson.code).toBe(0);
    const parsedShow = JSON.parse(showJson.out) as {
      outcome: string;
      profile: { projectId: string; clones: Record<string, { path: string; worktreeRoot: string }> };
    };
    expect(parsedShow.outcome).toBe('found');
    expect(parsedShow.profile.clones['runner-1']).toEqual({
      path: '/srv/repos/alpha',
      worktreeRoot: '/srv/worktrees/runner-1',
    });
  });

  it('exits 2 from the parser on a --clones entry missing = or : and exits 1 from the entity on a relative path', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    const missingEquals = await runProjects(
      ['add', ...BASE_ADD_FLAGS, '--clones', 'runner-1/srv/repos/a:/srv/worktrees/a', '--yes'],
      runtime,
    );
    expect(missingEquals.code).toBe(2);
    expect(missingEquals.err).toContain("is missing '='");

    const missingColon = await runProjects(
      ['add', ...BASE_ADD_FLAGS, '--clones', 'runner-1=/srv/repos/a', '--yes'],
      runtime,
    );
    expect(missingColon.code).toBe(2);
    expect(missingColon.err).toContain("is missing ':'");

    const relativeClonePath = await runProjects(
      ['add', ...BASE_ADD_FLAGS, '--clones', 'runner-1=relative:/srv/worktrees/a', '--yes'],
      runtime,
    );
    expect(relativeClonePath.code).toBe(1);
    expect(relativeClonePath.err).toContain(
      'ProjectProfile clone runner-1 requires normalised absolute paths',
    );
  });

  it('registers a project without installation name checks when no installation file is present (v1/absent behaviour)', async () => {
    const stateDir = makeTempDir();
    const absentRuntime = createFleetCliRuntime({ stateDir });

    const added = await runProjects(
      [
        'add',
        '--project-id',
        'unlinked',
        '--display-name',
        'Unlinked Project',
        '--repository',
        'https://example.com/unlinked.git',
        '--dispatcher-host',
        'unlisted-host',
        '--policy-revision',
        'pol-1',
        '--max-lanes',
        '1',
        '--clones',
        'another-host=/srv/repos/unlinked:/srv/worktrees/unlinked',
        '--gate-procedures',
        'unlisted-procedure',
        '--yes',
      ],
      absentRuntime,
    );
    expect(added.code).toBe(0);
    expect(added.out).toContain('registered project unlinked (rev 0)\n');

    const v1Runtime = createFleetCliRuntime({
      stateDir: makeTempDir(),
      installation: { schemaVersion: 1 },
    });
    const addedV1 = await runProjects(
      [
        'add',
        '--project-id',
        'v1-proj',
        '--display-name',
        'V1 Project',
        '--repository',
        'https://example.com/v1.git',
        '--dispatcher-host',
        'unlisted-host',
        '--policy-revision',
        'pol-1',
        '--max-lanes',
        '1',
        '--yes',
      ],
      v1Runtime,
    );
    expect(addedV1.code).toBe(0);

    const previousInstallationFile = process.env.FLEET_INSTALLATION_FILE;
    process.env.FLEET_INSTALLATION_FILE = path.join(stateDir, 'missing-fleet.json');
    try {
      const noFileIo = mockIo();
      const noFileCode = await runCli(
        [
          '--state-dir',
          stateDir,
          'projects',
          'add',
          '--project-id',
          'no-file-proj',
          '--display-name',
          'No File Project',
          '--repository',
          'https://example.com/no-file.git',
          '--dispatcher-host',
          'unlisted-host',
          '--policy-revision',
          'pol-1',
          '--max-lanes',
          '1',
          '--yes',
        ],
        noFileIo.io,
      );
      expect(noFileCode).toBe(0);
    } finally {
      if (previousInstallationFile === undefined) {
        delete process.env.FLEET_INSTALLATION_FILE;
      } else {
        process.env.FLEET_INSTALLATION_FILE = previousInstallationFile;
      }
    }
  });

  it('prints help text for fleet-v2 --help and fleet-v2 projects --help', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);

    const rootHelpIo = mockIo();
    const rootCode = await runCli(['--help'], rootHelpIo.io, runtime);
    expect(rootCode).toBe(0);
    expect(rootHelpIo.stdout.join('')).toContain('projects list|show|probe|add|adopt|edit|retire');

    const projectsHelp = await runProjects(['--help'], runtime);
    expect(projectsHelp.code).toBe(0);
    expect(projectsHelp.out).toContain('Usage: fleet-v2 projects <subcommand> [flags]');
  });

  it('treats a blank project id as a usage error and help only as the first word', async () => {
    const runtime = makeV2Runtime(makeTempDir());
    const blank = await runProjects(['show', '   '], runtime);
    expect(blank.code).toBe(2);
    expect(blank.err).toContain('projects show requires a project id');
    const trailingHelp = await runProjects(['retire', 'alpha', 'help'], runtime);
    expect(trailingHelp.code).toBe(2);
  });
});

describe('fleet-v2 projects probe and adopt (P6b)', () => {
  it('probes and reports an unknown host-reachable check with exit 1 when the installation does not name the clone host', async () => {
    // Absent installation: add accepts hosts without installation name checks,
    // so the profile can reference a host the probing runtime cannot name.
    const stateDir = makeTempDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await runProjects(
      [
        'add',
        '--project-id',
        'probe-host',
        '--display-name',
        'Probe Host',
        '--repository',
        'file:///nonexistent',
        '--dispatcher-host',
        'unlisted-host',
        '--policy-revision',
        'pol-1',
        '--max-lanes',
        '1',
        '--clones',
        'missing-host=/srv/repos/probe-host:/srv/worktrees/probe-host',
        '--yes',
      ],
      runtime,
    );

    const probed = await runProjects(['probe', 'probe-host'], runtime);
    expect(probed.code).toBe(1);
    expect(probed.out).toContain(
      'unknown  host-reachable  missing-host  no v2 installation names lane hosts\n',
    );
  });

  it('probes an unknown project and exits 1', async () => {
    const runtime = makeV2Runtime(makeTempDir());
    const probed = await runProjects(['probe', 'unknown-project'], runtime);
    expect(probed.code).toBe(1);
    expect(probed.err).toContain('project unknown-project is not registered');
  });

  it('adopt with no id lists a project that has work orders but no profile', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);
    // Register the work order through a runtime composed without the guard: a
    // bare RegisterWorkOrderUseCase on the same state directory.
    const unguarded = new RegisterWorkOrderUseCase({
      workOrderRepo: new WorkOrderRepositoryAdapter({ stateDir }),
    });
    await unguarded.registerWorkOrder({
      workOrderId: 'wo-adopt-1',
      projectId: 'gamma',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'https://example.com/gamma.git',
      baseCommit: 'abc123',
      ownedPaths: ['packages/gamma'],
      policyRevision: 'pol-1',
    });

    const listed = await runProjects(['adopt'], runtime);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(
      'gamma  orders 1 (active 1)  repos https://example.com/gamma.git  last ',
    );
  });

  it('adopts a candidate with flags and refuses a second adopt', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);
    const unguarded = new RegisterWorkOrderUseCase({
      workOrderRepo: new WorkOrderRepositoryAdapter({ stateDir }),
    });
    await unguarded.registerWorkOrder({
      workOrderId: 'wo-adopt-2',
      projectId: 'delta',
      taskId: 'task-1',
      laneId: 'lane-1',
      repository: 'https://example.com/delta.git',
      baseCommit: 'abc123',
      ownedPaths: ['packages/delta'],
      policyRevision: 'pol-1',
    });

    const adopted = await runProjects(
      [
        'adopt',
        'delta',
        '--display-name',
        'Delta Service',
        '--dispatcher-host',
        'orch',
        '--policy-revision',
        'pol-1',
        '--max-lanes',
        '2',
        '--yes',
      ],
      runtime,
    );
    expect(adopted.code).toBe(0);
    expect(adopted.out).toContain('adopt project delta\n');
    expect(adopted.out).toContain('  displayName: Delta Service\n');
    expect(adopted.out).toContain('  repository: https://example.com/delta.git\n');
    expect(adopted.out).toContain('adopted project delta (rev 0)\n');

    const second = await runProjects(
      [
        'adopt',
        'delta',
        '--dispatcher-host',
        'orch',
        '--policy-revision',
        'pol-1',
        '--max-lanes',
        '2',
        '--yes',
      ],
      runtime,
    );
    expect(second.code).toBe(1);
    expect(second.err).toContain('project delta is already registered');
  });

  it('refuses adopt with exit 1 naming --repository when the candidate has two repositories', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);
    const unguarded = new RegisterWorkOrderUseCase({
      workOrderRepo: new WorkOrderRepositoryAdapter({ stateDir }),
    });
    const repos = ['https://example.com/a.git', 'https://example.com/b.git'];
    for (const [index, repo] of repos.entries()) {
      await unguarded.registerWorkOrder({
        workOrderId: `wo-two-repos-${index}`,
        projectId: 'two-repos',
        taskId: 'task-1',
        laneId: 'lane-1',
        repository: repo,
        baseCommit: 'abc123',
        ownedPaths: [`packages/two-repos/${index}`],
        policyRevision: 'pol-1',
      });
    }

    const adopted = await runProjects(
      [
        'adopt',
        'two-repos',
        '--dispatcher-host',
        'orch',
        '--policy-revision',
        'pol-1',
        '--max-lanes',
        '2',
        '--yes',
      ],
      runtime,
    );
    expect(adopted.code).toBe(1);
    expect(adopted.err).toContain('--repository is required');
  });

  it('refuses work-order register for a project without a profile with the guard reason', async () => {
    const runtime = makeV2Runtime(makeTempDir());
    const { io, stdout } = mockIo();
    const code = await runCli(
      [
        'work-order',
        'register',
        '--json',
        JSON.stringify({
          workOrderId: 'wo-no-profile',
          projectId: 'no-profile',
          taskId: 'task-1',
          laneId: 'lane-1',
          repository: 'https://example.com/no-profile.git',
          baseCommit: 'abc123',
          ownedPaths: ['packages/no-profile'],
          policyRevision: 'pol-1',
        }),
      ],
      io,
      runtime,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout.join('')) as { outcome: string; reason: string };
    expect(parsed.outcome).toBe('rejected');
    expect(parsed.reason).toContain('project no-profile has no profile');
  });

  it('registers the same work order after projects add creates the profile', async () => {
    const stateDir = makeTempDir();
    const runtime = makeV2Runtime(stateDir);
    await runProjects(['add', ...BASE_ADD_FLAGS, '--yes'], runtime);

    const { io, stdout } = mockIo();
    const code = await runCli(
      [
        'work-order',
        'register',
        '--json',
        JSON.stringify({
          workOrderId: 'wo-after-add',
          projectId: 'alpha',
          taskId: 'task-1',
          laneId: 'lane-1',
          repository: 'https://example.com/alpha.git',
          baseCommit: 'abc123',
          ownedPaths: ['packages/alpha'],
          policyRevision: 'pol-1',
        }),
      ],
      io,
      runtime,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as { outcome: string };
    expect(parsed.outcome).toBe('registered');
  });
});
