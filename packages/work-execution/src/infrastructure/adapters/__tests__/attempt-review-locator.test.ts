import { describe, expect, it } from 'vitest';

import type { AttemptRecord } from '../../../domain/execution-records.js';
import type { CommandRunOptions, CommandRunResult, CommandExecutorPort } from '../../../application/ports/out/CommandExecutorPort.out-port.js';
import { ExecutorForHost } from '../ExecutorForHost.helper.js';
import type { RunnerForAttemptHostSpec } from '../ConfirmRecordedHost.js';
import { AttemptReviewLocator, REVIEW_GIT_HARDENING } from '../AttemptReviewLocator.helper.js';

const WORKTREE = '/srv/fleet/worktrees/att-1';
const A40 = 'a'.repeat(40);
const B40 = 'b'.repeat(40);

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att-1',
    workOrderId: 'wo-rw2-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE,
    baseCommit: B40,
    state: 'collected',
    outcome: 'done',
    briefDigest: 'digest-1',
    briefPackagePath: null,
    sessionId: 'session-1',
    completionReceipt: null,
    artifacts: {
      headCommit: A40,
      commitsSinceBase: [],
      collectedArtifactPaths: [],
      notes: 'missing',
    },
    runner: null,
    createdAtIso: '2026-10-27T08:00:00.000Z',
    updatedAtIso: '2026-10-27T08:30:00.000Z',
    ...overrides,
  };
}

const hosts: Readonly<Record<string, RunnerForAttemptHostSpec>> = {
  'this-machine': {
    transport: 'local',
    roles: ['lane-runner'],
    runner: {
      kind: 'opencode',
      port: 46000,
      authFile: '/home/developer/.config/fleet/auth.json',
    },
  },
  'lane-host': {
    transport: 'ssh',
    sshAlias: 'lane-host.example',
    roles: ['lane-runner'],
    runner: { kind: 'opencode', port: 46000 },
  },
  'lane-host-auth': {
    transport: 'ssh',
    sshAlias: 'lane-host-auth.example',
    roles: ['lane-runner'],
    runner: { kind: 'opencode', port: 46000, authFile: '/srv/fleet/auth/lane-host-auth.json' },
  },
  'local-no-auth': {
    transport: 'local',
    roles: ['lane-runner'],
    runner: { kind: 'opencode', port: 46001 },
  },
  'agy-host': {
    transport: 'local',
    roles: ['lane-runner'],
    runner: { kind: 'agy' },
  },
};

/** A recording fake executor with a per-call outcome script. */
function fakeLegacyExecutor(
  respond: (index: number) => Partial<CommandRunResult>,
): { executor: CommandExecutorPort; calls: readonly string[][] } {
  const calls: string[][] = [];
  return {
    executor: {
      run: async (
        argv: readonly string[],
        _options?: CommandRunOptions,
      ): Promise<CommandRunResult> => {
        const index = calls.length;
        calls.push([...argv]);
        return {
          exitCode: 0,
          signal: null,
          stdout: 'abc…\n',
          stderr: '',
          ...respond(index),
        };
      },
    },
    calls,
  };
}

function makeLocator(options: {
  attempt: AttemptRecord | null;
  hosts?: Readonly<Record<string, RunnerForAttemptHostSpec>>;
  legacyExecutor?: CommandExecutorPort;
  legacyRoute?: { readonly remotePort?: number; readonly remoteHost?: string };
  gitTimeoutMs?: number;
}): AttemptReviewLocator {
  const legacyExecutor = options.legacyExecutor ?? fakeLegacyExecutor(() => ({})).executor;
  return new AttemptReviewLocator({
    findAttempt: async () => options.attempt,
    executorForHost: new ExecutorForHost({
      hosts: options.hosts ?? hosts,
      legacyExecutor,
    }),
    hosts: options.hosts ?? hosts,
    ...(options.legacyRoute !== undefined ? { legacyRoute: options.legacyRoute } : {}),
    ...(options.gitTimeoutMs !== undefined ? { gitTimeoutMs: options.gitTimeoutMs } : {}),
  });
}

describe('AttemptReviewLocator', () => {
  it('rejects an attempt that is not recorded', async () => {
    const locator = makeLocator({ attempt: null });
    await expect(locator.locate('att-unknown')).rejects.toThrow(/No attempt is recorded for/);
  });

  it('rejects an attempt whose worktree path is not absolute', async () => {
    const locator = makeLocator({
      attempt: makeAttempt({ worktreePath: 'relative/worktrees/att-1' }),
    });
    await expect(locator.locate('att-1')).rejects.toThrow(/no absolute worktree path/);
  });

  it('routes a recorded local v2 host through an installation route with its auth file', async () => {
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 46000,
          host: null,
          hostName: 'this-machine',
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
    });
    const location = await locator.locate('att-1');
    expect(location.worktreePath).toBe(WORKTREE);
    expect(location.baseCommit).toBe(B40);
    expect(location.route).toEqual({
      kind: 'installation',
      remotePort: 46000,
      remoteHost: '',
      authFile: '/home/developer/.config/fleet/auth.json',
    });
  });

  it('refuses a remote v2 host that declares no runner authFile for the review route', async () => {
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 46000,
          host: 'lane-host.example',
          hostName: 'lane-host',
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
    });
    const location = await locator.locate('att-1');
    expect(location.route).toEqual({
      kind: 'none',
      reason: 'Host lane-host declares no runner authFile for a remote review route',
      code: 'route-no-auth-file',
    });
  });

  it('routes a remote v2 host with an authFile through the installation route carrying it', async () => {
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 46000,
          host: 'lane-host-auth.example',
          hostName: 'lane-host-auth',
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
    });
    const location = await locator.locate('att-1');
    expect(location.route).toEqual({
      kind: 'installation',
      remotePort: 46000,
      remoteHost: 'lane-host-auth.example',
      authFile: '/srv/fleet/auth/lane-host-auth.json',
    });
  });

  it('keeps a local v2 host without an authFile on the installation route without one', async () => {
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 46001,
          host: null,
          hostName: 'local-no-auth',
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
    });
    const location = await locator.locate('att-1');
    expect(location.route).toEqual({
      kind: 'installation',
      remotePort: 46001,
      remoteHost: '',
    });
  });

  it('refuses a recorded host whose runner is not opencode', async () => {
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'agy',
          remotePort: null,
          host: null,
          hostName: 'agy-host',
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
    });
    const location = await locator.locate('att-1');
    expect(location.route.kind).toBe('none');
    if (location.route.kind === 'none') {
      expect(location.route.reason).toContain('not opencode');
      expect(location.route.code).toBe('route-not-opencode');
    }
  });

  it('refuses a recorded opencode host that declares no runner port with the route-no-port code', async () => {
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: null,
          host: null,
          hostName: 'local-no-port',
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
      hosts: {
        'local-no-port': {
          transport: 'local',
          roles: ['lane-runner'],
          runner: { kind: 'opencode' },
        },
      },
    });
    const location = await locator.locate('att-1');
    expect(location.route.kind).toBe('none');
    if (location.route.kind === 'none') {
      expect(location.route.reason).toContain('declares no runner port');
      expect(location.route.code).toBe('route-no-port');
    }
  });

  it('rejects a recorded host that was removed from the installation', async () => {
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 46000,
          host: 'lane-host.example',
          hostName: 'lane-host',
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
      hosts: { 'this-machine': hosts['this-machine'] },
    });
    await expect(locator.locate('att-1')).rejects.toThrow(
      /recorded host lane-host changed or was removed/,
    );
  });

  it('routes a legacy attempt through its recorded port and host, falling back to the legacy route', async () => {
    const legacyAttempt = makeAttempt({
      runner: {
        kind: 'opencode',
        remotePort: 4166,
        host: null,
        agent: null,
        model: 'example-provider/glm-5.3',
        variant: null,
      },
    });
    const withRunner = makeLocator({
      attempt: legacyAttempt,
      legacyRoute: { remotePort: 4096, remoteHost: 'legacy-host.example' },
    });
    expect((await withRunner.locate('att-1')).route).toEqual({
      kind: 'legacy',
      remotePort: 4166,
      remoteHost: 'legacy-host.example',
    });

    const withoutRunner = makeLocator({
      attempt: makeAttempt({ runner: null }),
      legacyRoute: { remotePort: 4096 },
    });
    expect((await withoutRunner.locate('att-1')).route).toEqual({
      kind: 'legacy',
      remotePort: 4096,
    });
  });

  it('readHead runs exactly the recorded-host git argv and trims, returning null on failures', async () => {
    const { executor, calls } = fakeLegacyExecutor(() => ({}));
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
      legacyExecutor: executor,
    });
    const location = await locator.locate('att-1');
    await expect(location.readHead()).resolves.toBe('abc…');
    expect(calls[0]).toEqual(['git', '-C', WORKTREE, ...REVIEW_GIT_HARDENING, 'rev-parse', 'HEAD']);
    expect(calls[0]?.length).toBe(9);

    const failing = fakeLegacyExecutor(() => ({ exitCode: 1 }));
    const failingLocator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
      legacyExecutor: failing.executor,
    });
    const failingLocation = await failingLocator.locate('att-1');
    await expect(failingLocation.readHead()).resolves.toBeNull();

    const throwingExecutor: CommandExecutorPort = {
      run: async () => {
        throw new Error('spawn failed');
      },
    };
    const throwingLocator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
      legacyExecutor: throwingExecutor,
    });
    const throwingLocation = await throwingLocator.locate('att-1');
    await expect(throwingLocation.readHead()).resolves.toBeNull();
  });

  it('readDiff refuses invalid shas without running anything and runs the exact argv for valid ones', async () => {
    const { executor, calls } = fakeLegacyExecutor(() => ({}));
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
      legacyExecutor: executor,
    });
    const location = await locator.locate('att-1');

    await expect(location.readDiff('main', 'abc1234')).resolves.toBeNull();
    await expect(location.readDiff('--output=/tmp/x', 'abc1234')).resolves.toBeNull();
    expect(calls).toHaveLength(0);

    await expect(location.readDiff(A40, B40)).resolves.toBe('abc…\n');
    expect(calls[0]).toEqual([
      'git',
      '-C',
      WORKTREE,
      ...REVIEW_GIT_HARDENING,
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      A40,
      B40,
      '--',
    ]);
  });

  it('readStatus returns an empty string for a clean tree, never null', async () => {
    const { executor, calls } = fakeLegacyExecutor(() => ({ stdout: '' }));
    const locator = makeLocator({
      attempt: makeAttempt({
        runner: {
          kind: 'opencode',
          remotePort: 4166,
          host: null,
          agent: null,
          model: 'example-provider/glm-5.3',
          variant: null,
        },
      }),
      legacyExecutor: executor,
    });
    const location = await locator.locate('att-1');
    await expect(location.readStatus()).resolves.toBe('');
    expect(calls[0]).toEqual(['git', '-C', WORKTREE, ...REVIEW_GIT_HARDENING, 'status', '--porcelain=v1']);
  });
});
