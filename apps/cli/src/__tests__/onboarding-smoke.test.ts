/**
 * Fleet-v2 onboarding smoke (lane P12): end-to-end with real git and a v2
 * installation whose only host is local. Builds a throwaway upstream
 * repository, registers project `demo`, probes it before and after the clone
 * exists, registers a work order once the profile is active, and proves a
 * retired profile refuses new work orders.
 *
 * No network is touched: the upstream is a local `file://` repository and the
 * probe's git commands run through a `LocalExecutor` on this host.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FleetInstallation } from '@fleet/installation';

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
  const directory = mkdtempSync(path.join(tmpdir(), 'fleet-onboarding-smoke-'));
  createdDirs.push(directory);
  return directory;
}

/** Run git with an argv array (never a shell string) and return trimmed stdout. */
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Build the throwaway upstream repository with a committed AGENTS.md, .gitignore and package.json. */
function initUpstream(dir: string): void {
  git('init', '--initial-branch=main', '-q', dir);
  writeFileSync(path.join(dir, 'AGENTS.md'), '# Demo project agent instructions\n');
  writeFileSync(path.join(dir, '.gitignore'), '.lane/\n');
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'demo-upstream', scripts: { test: 'x', build: 'y' } }, null, 2)}\n`,
  );
  git('-C', dir, 'add', '.');
  // Identity is scoped to the commit command only; never global config.
  git(
    '-C',
    dir,
    '-c',
    'user.name=Fleet Onboarding Smoke',
    '-c',
    'user.email=fleet@example.invalid',
    'commit',
    '-q',
    '-m',
    'init',
  );
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

/** A loader-valid v2 installation with one local host and procedure `verify`. */
function v2Installation(workspace: string): FleetInstallation {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    hosts: {
      'local-1': {
        transport: 'local',
        worktreeRoot: path.join(workspace, 'worktrees'),
        roles: ['orchestrator', 'lane-runner'],
      },
    },
    verification: {
      procedures: {
        verify: { command: 'yarn', args: ['test'] },
      },
    },
  };
}

async function runCliCommand(
  argv: readonly string[],
  runtime: FleetCliRuntime,
  options?: ProjectsCliOptions,
): Promise<{ code: number; out: string; err: string }> {
  const { io, stdout, stderr } = mockIo();
  const code = await runCli(argv, io, runtime, undefined, undefined, undefined, undefined, options);
  return { code, out: stdout.join(''), err: stderr.join('') };
}

/** Skip the whole suite only when git itself is unavailable. */
let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitAvailable = false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!gitAvailable)('fleet-v2 onboarding smoke (P12)', () => {
  it('registers a project, probes it against a real clone and refuses work orders after retirement', async () => {
    const workspace = makeTempDir();
    const upstream = path.join(workspace, 'upstream');
    const clone = path.join(workspace, 'clone');
    const worktrees = path.join(workspace, 'worktrees');
    const stateDir = path.join(workspace, 'state');
    const repositoryUrl = `file://${upstream}`;

    mkdirSync(upstream);
    initUpstream(upstream);
    const head = git('-C', upstream, 'rev-parse', 'HEAD');

    const runtime = createFleetCliRuntime({
      stateDir,
      installation: v2Installation(workspace),
    });

    // 1. A work order for a project without a profile is refused.
    const woBefore = await runCliCommand(
      [
        'work-order',
        'register',
        '--work-order-id',
        'wo-demo-1',
        '--project-id',
        'demo',
        '--task-id',
        'task-1',
        '--lane-id',
        'lane-1',
        '--repository',
        repositoryUrl,
        '--base-commit',
        head,
        '--owned-paths',
        'packages/demo',
        '--policy-revision',
        'pol-1',
      ],
      runtime,
    );
    expect(woBefore.code).toBe(1);
    expect(woBefore.out).toContain('has no profile');

    // 2. Register the project profile.
    const added = await runCliCommand(
      [
        'projects',
        'add',
        '--project-id',
        'demo',
        '--display-name',
        'Demo',
        '--repository',
        repositoryUrl,
        '--dispatcher-host',
        'local-1',
        '--policy-revision',
        'pol-1',
        '--max-lanes',
        '2',
        '--clones',
        `local-1=${clone}:${worktrees}`,
        '--gate-procedures',
        'verify',
        '--yes',
      ],
      runtime,
    );
    expect(added.code).toBe(0);

    // 3. Probe fails because the clone does not exist yet; the repository
    //    itself still answers.
    const failedProbe = await runCliCommand(['projects', 'probe', 'demo'], runtime);
    expect(failedProbe.code).toBe(1);
    expect(failedProbe.out).toContain('fail  clone-is-work-tree');
    expect(failedProbe.out).toContain('git clone');
    expect(failedProbe.out).toContain('pass  repository-answers');

    // 4. Create the clone and the worktree root.
    git('clone', '-q', repositoryUrl, clone);
    mkdirSync(worktrees, { recursive: true });

    // 5. Probe now passes: every check line is a pass, the last line says
    //    recorded, and show lists the recorded probe checks.
    const passedProbe = await runCliCommand(['projects', 'probe', 'demo'], runtime);
    expect(passedProbe.code).toBe(0);
    const probeLines = passedProbe.out.trimEnd().split('\n');
    expect(probeLines.length).toBeGreaterThan(0);
    for (const line of probeLines.slice(0, -1)) {
      expect(line.startsWith('pass')).toBe(true);
    }
    expect(probeLines[probeLines.length - 1]).toBe('recorded');

    const shown = await runCliCommand(['projects', 'show', 'demo'], runtime);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('lastProbe:');
    expect(shown.out).toContain('pass  clone-is-work-tree');

    // 6. With an active profile, the work order registers.
    const woAfter = await runCliCommand(
      [
        'work-order',
        'register',
        '--work-order-id',
        'wo-demo-1',
        '--project-id',
        'demo',
        '--task-id',
        'task-1',
        '--lane-id',
        'lane-1',
        '--repository',
        repositoryUrl,
        '--base-commit',
        head,
        '--owned-paths',
        'packages/demo',
        '--policy-revision',
        'pol-1',
      ],
      runtime,
    );
    expect(woAfter.code).toBe(0);

    // 7. Retire the project; a new work order under a different id is refused.
    const retired = await runCliCommand(['projects', 'retire', 'demo', '--yes'], runtime);
    expect(retired.code).toBe(0);

    const woRetired = await runCliCommand(
      [
        'work-order',
        'register',
        '--work-order-id',
        'wo-demo-2',
        '--project-id',
        'demo',
        '--task-id',
        'task-2',
        '--lane-id',
        'lane-2',
        '--repository',
        repositoryUrl,
        '--base-commit',
        head,
        '--owned-paths',
        'packages/demo',
        '--policy-revision',
        'pol-1',
      ],
      runtime,
    );
    expect(woRetired.code).toBe(1);
    expect(woRetired.out).toContain('is retired');
  });
});
