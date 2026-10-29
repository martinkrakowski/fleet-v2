import { describe, expect, it } from 'vitest';

import type { RunIndependentReviewRequest } from '../../../application/ports/out/IndependentReviewPort.out-port.js';
import type { CliReviewSpawn } from '../CliReviewTransport.adapter.js';
import { IndependentReviewAdapter } from '../IndependentReviewAdapter.adapter.js';
import type { OcmReviewTransportSpawn } from '../OcmReviewTransport.adapter.js';
import {
  createReviewTransportRouter,
  hasReviewerSeat,
  reviewerChainSeatIds,
  type ReviewLocation,
  type ReviewRunnerRoute,
  type ReviewTransportChains,
  type ReviewTransportSeat,
} from '../ReviewTransportRouter.js';

const IMPLEMENTER_SEAT: ReviewTransportSeat = {
  id: 'implementer',
  tool: 'opencode',
  model: 'example-provider/glm-5.3',
  roles: ['implementer'],
};

const REVIEWER_SEAT: ReviewTransportSeat = {
  id: 'reviewer',
  tool: 'opencode',
  model: 'example-provider/grok-4.7',
  agent: 'example-agent',
  roles: ['reviewer'],
};

const HIGH_RISK_SEAT: ReviewTransportSeat = {
  id: 'high-risk-reviewer',
  tool: 'opencode',
  model: 'example-provider/gemini-3.8-pro',
  roles: ['high-risk-reviewer'],
};

const SEATS: readonly ReviewTransportSeat[] = [IMPLEMENTER_SEAT, REVIEWER_SEAT, HIGH_RISK_SEAT];

const CHAINS: ReviewTransportChains = {
  reviewer: [{ seatId: 'reviewer' }],
  'high-risk-reviewer': [{ seatId: 'high-risk-reviewer' }],
};

function fixtureLocation(route: ReviewRunnerRoute, headSha: string): ReviewLocation {
  return {
    worktreePath: '/srv/fleet/worktrees/att-1',
    baseCommit: 'base-sha',
    route,
    readHead: async () => headSha,
    readStatus: async () => '',
    readDiff: async () => '',
  };
}

const BASE_REQUEST: RunIndependentReviewRequest = {
  attemptId: 'att-1',
  candidateHeadSha: 'sha-candidate-head',
  implementerModel: IMPLEMENTER_SEAT.model,
  reviewerModel: REVIEWER_SEAT.model,
};

const PASS_FIXTURE =
  '{"type":"step_start","part":{"type":"step-start"}}\n' +
  '{"type":"text","part":{"type":"text","text":"VERDICT: PASS\\n"}}';

describe('ReviewTransportRouter', () => {
  describe('reviewerChainSeatIds and hasReviewerSeat', () => {
    it('reviewerChainSeatIds keeps order and drops duplicates', () => {
      const chains: ReviewTransportChains = {
        reviewer: [{ seatId: 'a' }, { seatId: 'b' }, { seatId: 'a' }],
        'high-risk-reviewer': [{ seatId: 'b' }, { seatId: 'c' }],
      };
      expect(reviewerChainSeatIds(chains)).toEqual(['a', 'b', 'c']);
    });

    it('hasReviewerSeat is false without seats, chains, or known ids', () => {
      expect(hasReviewerSeat()).toBe(false);
      expect(hasReviewerSeat([], CHAINS)).toBe(false);
      expect(hasReviewerSeat(SEATS)).toBe(false);
      expect(hasReviewerSeat(SEATS, { reviewer: [{ seatId: 'ghost' }] })).toBe(false);
    });

    it('hasReviewerSeat is true when a chain names a configured seat', () => {
      expect(hasReviewerSeat(SEATS, CHAINS)).toBe(true);
    });
  });

  it('refuses when no seat serves the model and does not locate', async () => {
    const locateCalls: string[] = [];
    const router = createReviewTransportRouter({
      seats: SEATS,
      chains: CHAINS,
      locate: async (attemptId) => {
        locateCalls.push(attemptId);
        return fixtureLocation(
          { kind: 'installation', remotePort: 46000, remoteHost: '' },
          BASE_REQUEST.candidateHeadSha,
        );
      },
      ocmRunBin: '/bundled/bin/ocm-run',
    });

    await expect(
      router({ ...BASE_REQUEST, reviewerModel: 'example-provider/no-such-model' }),
    ).rejects.toThrow(/No reviewer seat in the installation serves model/);
    expect(locateCalls).toEqual([]);
  });

  it('refuses a model served only by a seat outside the reviewer chains', async () => {
    const locateCalls: string[] = [];
    const router = createReviewTransportRouter({
      seats: SEATS,
      chains: CHAINS,
      locate: async (attemptId) => {
        locateCalls.push(attemptId);
        return fixtureLocation(
          { kind: 'installation', remotePort: 46000, remoteHost: '' },
          BASE_REQUEST.candidateHeadSha,
        );
      },
      ocmRunBin: '/bundled/bin/ocm-run',
    });

    await expect(router({ ...BASE_REQUEST, reviewerModel: IMPLEMENTER_SEAT.model })).rejects.toThrow(
      /No reviewer seat in the installation serves model/,
    );
    expect(locateCalls).toEqual([]);
  });

  it('refuses several chain seats sharing the model as ambiguous', async () => {
    const duplicateSeats: readonly ReviewTransportSeat[] = [
      { ...REVIEWER_SEAT, model: 'example-provider/shared' },
      { ...HIGH_RISK_SEAT, model: 'example-provider/shared' },
    ];
    const router = createReviewTransportRouter({
      seats: duplicateSeats,
      chains: CHAINS,
      locate: async () =>
        fixtureLocation(
          { kind: 'installation', remotePort: 46000, remoteHost: '' },
          BASE_REQUEST.candidateHeadSha,
        ),
      ocmRunBin: '/bundled/bin/ocm-run',
    });

    await expect(router({ ...BASE_REQUEST, reviewerModel: 'example-provider/shared' })).rejects.toThrow(
      /refused as ambiguous/,
    );
  });

  it('refuses a reviewer-chain seat that also holds the implementer role', async () => {
    const implementerReviewerSeat: ReviewTransportSeat = {
      ...REVIEWER_SEAT,
      roles: ['reviewer', 'implementer'],
    };
    const router = createReviewTransportRouter({
      seats: [implementerReviewerSeat],
      chains: { reviewer: [{ seatId: 'reviewer' }] },
      locate: async () =>
        fixtureLocation(
          { kind: 'installation', remotePort: 46000, remoteHost: '' },
          BASE_REQUEST.candidateHeadSha,
        ),
      ocmRunBin: '/bundled/bin/ocm-run',
    });

    await expect(router(BASE_REQUEST)).rejects.toThrow(/also holds the implementer role/);
  });

  it('refuses a seat whose tool has no transport and does not spawn', async () => {
    // CT-4a gave `agy` a CLI review transport; an unknown tool stands in for
    // the "no transport" refusal this test pins.
    const unknownSeat: ReviewTransportSeat = {
      id: 'reviewer',
      tool: 'example-unknown-tool',
      model: REVIEWER_SEAT.model,
      roles: ['reviewer'],
    };
    let spawnCalled = false;
    const fakeSpawn: OcmReviewTransportSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const router = createReviewTransportRouter({
      seats: [unknownSeat],
      chains: { reviewer: [{ seatId: 'reviewer' }] },
      locate: async () =>
        fixtureLocation(
          { kind: 'installation', remotePort: 46000, remoteHost: '' },
          BASE_REQUEST.candidateHeadSha,
        ),
      ocmRunBin: '/bundled/bin/ocm-run',
      ocmSpawn: fakeSpawn,
    });

    await expect(router(BASE_REQUEST)).rejects.toThrow(/which has no review transport/);
    expect(spawnCalled).toBe(false);
  });

  it('dispatches opencode over an installation local route with the expected argv and env', async () => {
    const recorded: Array<{
      file: string;
      args: readonly string[];
      env: Record<string, string>;
    }> = [];
    const fakeSpawn: OcmReviewTransportSpawn = async (file, args, env) => {
      recorded.push({ file, args, env });
      return { exitCode: 0, stdout: PASS_FIXTURE, stderr: '' };
    };

    const router = createReviewTransportRouter({
      seats: SEATS,
      chains: CHAINS,
      locate: async () =>
        fixtureLocation(
          {
            kind: 'installation',
            remotePort: 46000,
            remoteHost: '',
            authFile: '/home/operator/.config/fleet/auth.json',
          },
          BASE_REQUEST.candidateHeadSha,
        ),
      ocmRunBin: '/bundled/bin/ocm-run',
      ocmSpawn: fakeSpawn,
      makeNonce: () => 'a'.repeat(32),
    });

    const result = await router(BASE_REQUEST);

    expect(recorded).toHaveLength(1);
    const { file, args, env } = recorded[0];
    expect(file).toBe('/bundled/bin/ocm-run');
    expect(args.slice(0, -1)).toEqual([
      '--dir',
      '/srv/fleet/worktrees/att-1',
      '--agent',
      'example-agent',
      '-m',
      'example-provider/grok-4.7',
      '--format',
      'json',
    ]);
    expect(args[args.length - 1]).toMatch(/^Independent read-only code review/);
    expect(env.OCM_REMOTE_PORT).toBe('46000');
    expect(env.OCM_HOST).toBe('');
    expect(env.OPENCODE_AUTH_FILE).toBe('/home/operator/.config/fleet/auth.json');

    expect(result.result).toBe('pass');
    expect(result.readOnlyVerified).toBe(true);
  });

  it('installation ssh route uses the configured host even when process.env.OCM_HOST leaks', async () => {
    const savedOcmHost = process.env.OCM_HOST;
    process.env.OCM_HOST = 'leak.example';
    try {
      let capturedEnv: Record<string, string> = {};
      const fakeSpawn: OcmReviewTransportSpawn = async (_file, _args, env) => {
        capturedEnv = env;
        return { exitCode: 0, stdout: PASS_FIXTURE, stderr: '' };
      };
      const router = createReviewTransportRouter({
        seats: SEATS,
        chains: CHAINS,
        locate: async () =>
          fixtureLocation(
            {
              kind: 'installation',
              remotePort: 46000,
              remoteHost: 'lane-host.example',
              authFile: '/home/operator/.config/fleet/auth.json',
            },
            BASE_REQUEST.candidateHeadSha,
          ),
        ocmRunBin: '/bundled/bin/ocm-run',
        ocmSpawn: fakeSpawn,
      });

      await router(BASE_REQUEST);

      expect(capturedEnv.OCM_HOST).toBe('lane-host.example');
    } finally {
      if (savedOcmHost !== undefined) {
        process.env.OCM_HOST = savedOcmHost;
      } else {
        delete process.env.OCM_HOST;
      }
    }
  });

  it('defaults --agent to reviewer when the seat has no agent', async () => {
    let capturedArgs: readonly string[] = [];
    const fakeSpawn: OcmReviewTransportSpawn = async (_file, args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: PASS_FIXTURE, stderr: '' };
    };
    const router = createReviewTransportRouter({
      seats: SEATS,
      chains: CHAINS,
      locate: async () =>
        fixtureLocation(
          { kind: 'installation', remotePort: 46000, remoteHost: '' },
          BASE_REQUEST.candidateHeadSha,
        ),
      ocmRunBin: '/bundled/bin/ocm-run',
      ocmSpawn: fakeSpawn,
    });

    await router({ ...BASE_REQUEST, reviewerModel: HIGH_RISK_SEAT.model });

    const agentIndex = capturedArgs.indexOf('--agent');
    expect(capturedArgs[agentIndex + 1]).toBe('reviewer');
  });

  it('route kind none rejects with its reason and does not spawn', async () => {
    let spawnCalled = false;
    const fakeSpawn: OcmReviewTransportSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const router = createReviewTransportRouter({
      seats: SEATS,
      chains: CHAINS,
      locate: async () =>
        fixtureLocation(
          { kind: 'none', reason: 'attempt ran on an agy host' },
          BASE_REQUEST.candidateHeadSha,
        ),
      ocmRunBin: '/bundled/bin/ocm-run',
      ocmSpawn: fakeSpawn,
    });

    await expect(router(BASE_REQUEST)).rejects.toThrow(/attempt ran on an agy host/);
    expect(spawnCalled).toBe(false);
  });

  it('legacy route without a port refuses and does not spawn', async () => {
    let spawnCalled = false;
    const fakeSpawn: OcmReviewTransportSpawn = async () => {
      spawnCalled = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const router = createReviewTransportRouter({
      seats: SEATS,
      chains: CHAINS,
      locate: async () => fixtureLocation({ kind: 'legacy' }, BASE_REQUEST.candidateHeadSha),
      ocmRunBin: '/bundled/bin/ocm-run',
      ocmSpawn: fakeSpawn,
    });

    await expect(router(BASE_REQUEST)).rejects.toThrow(/No runner port is configured/);
    expect(spawnCalled).toBe(false);
  });

  it('through IndependentReviewAdapter: same-family refusal happens before locating; unknown model is unavailable', async () => {
    const locateCalls: string[] = [];
    const router = createReviewTransportRouter({
      seats: SEATS,
      chains: CHAINS,
      locate: async (attemptId) => {
        locateCalls.push(attemptId);
        return fixtureLocation(
          { kind: 'installation', remotePort: 46000, remoteHost: '' },
          BASE_REQUEST.candidateHeadSha,
        );
      },
      ocmRunBin: '/bundled/bin/ocm-run',
    });
    const adapter = new IndependentReviewAdapter({ runReview: router });

    const sameFamily = await adapter.runIndependentReview({
      attemptId: BASE_REQUEST.attemptId,
      candidateHeadSha: BASE_REQUEST.candidateHeadSha,
      implementerModel: IMPLEMENTER_SEAT.model,
      reviewerModel: 'other-provider/glm-5.3-flash',
    });
    expect(sameFamily.outcome).toBe('unavailable');
    const sameFamilyReason = sameFamily.outcome === 'unavailable' ? sameFamily.reason : '';
    expect(sameFamilyReason).toMatch(/share the same underlying model/);
    expect(sameFamilyReason).not.toMatch(/No reviewer seat/);
    expect(locateCalls).toEqual([]);

    const unknownModel = await adapter.runIndependentReview({
      attemptId: BASE_REQUEST.attemptId,
      candidateHeadSha: BASE_REQUEST.candidateHeadSha,
      implementerModel: IMPLEMENTER_SEAT.model,
      reviewerModel: 'example-provider/unknown-model',
    });
    expect(unknownModel.outcome).toBe('unavailable');
    if (unknownModel.outcome === 'unavailable') {
      expect(unknownModel.reason).toContain('No reviewer seat');
    }
  });

  describe('CLI review transport routing (RW4)', () => {
    const CLI_REVIEWER_SEAT: ReviewTransportSeat = {
      id: 'cli-reviewer',
      tool: 'grok',
      model: 'grok-4.7',
      roles: ['reviewer'],
    };

    const CLI_CHAINS: ReviewTransportChains = {
      reviewer: [{ seatId: 'cli-reviewer' }],
    };

    const CLI_REQUEST: RunIndependentReviewRequest = {
      attemptId: 'att-cli',
      candidateHeadSha: 'sha-candidate-head',
      implementerModel: IMPLEMENTER_SEAT.model,
      reviewerModel: 'grok-4.7',
    };

    function cliLocation(route: ReviewRunnerRoute): ReviewLocation {
      return {
        worktreePath: '/srv/fleet/worktrees/att-cli',
        baseCommit: 'base-sha',
        route,
        readHead: async () => CLI_REQUEST.candidateHeadSha,
        readStatus: async () => '',
        readDiff: async () => 'diff --git a/a.txt b/a.txt\n-old\n+new\n',
      };
    }

    const CLI_STDOUT = 'FINDING: minor a.txt:1 wording\nVERDICT: PASS\n';

    it('routes a grok seat to the CLI transport and a none route does not block it', async () => {
      const recorded: Array<{ file: string; args: readonly string[] }> = [];
      const cliSpawn: CliReviewSpawn = async (file, args) => {
        recorded.push({ file, args });
        // grok runs with `--output-format json`; the reply text lives in `text`
        // (the fixture feeds the same two-line verdict as before this lane).
        return { exitCode: 0, signal: null, stdout: JSON.stringify({ text: CLI_STDOUT }), stderr: '' };
      };
      let ocmCalled = false;
      const ocmSpawn: OcmReviewTransportSpawn = async () => {
        ocmCalled = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      };

      const router = createReviewTransportRouter({
        seats: [CLI_REVIEWER_SEAT],
        chains: CLI_CHAINS,
        locate: async () => cliLocation({ kind: 'none', reason: 'agy host' }),
        ocmRunBin: '/bundled/bin/ocm-run',
        cliSpawn,
        ocmSpawn,
        makeNonce: () => 'a'.repeat(32),
      });

      const result = await router(CLI_REQUEST);

      expect(recorded).toHaveLength(1);
      expect(recorded[0].file).toBe('grok');
      expect(recorded[0].args).toEqual([
        '--prompt-file',
        expect.stringMatching(/^\/.*\/prompt\.md$/),
        '-m',
        'grok-4.7',
        '--permission-mode',
        'plan',
        '--disable-web-search',
        '--output-format',
        'json',
      ]);
      expect(ocmCalled).toBe(false);
      expect(result.result).toBe('pass');
      expect(result.readOnlyVerified).toBe(true);
    });

    it('rejects a CLI seat that sets a variant and spawns nothing', async () => {
      const seat = { ...CLI_REVIEWER_SEAT, variant: 'fast' };
      let cliCalled = false;
      let ocmCalled = false;
      const router = createReviewTransportRouter({
        seats: [seat],
        chains: CLI_CHAINS,
        locate: async () => cliLocation({ kind: 'none', reason: 'agy host' }),
        ocmRunBin: '/bundled/bin/ocm-run',
        cliSpawn: async () => {
          cliCalled = true;
          return { exitCode: 0, signal: null, stdout: CLI_STDOUT, stderr: '' };
        },
        ocmSpawn: async () => {
          ocmCalled = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });

      await expect(router(CLI_REQUEST)).rejects.toThrow(/does not support/);
      expect(cliCalled).toBe(false);
      expect(ocmCalled).toBe(false);
    });

    it('routes an agy seat through the CLI review transport with the agy template (CT-4a)', async () => {
      const agySeat: ReviewTransportSeat = {
        id: 'reviewer',
        tool: 'agy',
        model: 'grok-4.7',
        roles: ['reviewer'],
      };
      let cliCalled = false;
      let ocmCalled = false;
      const router = createReviewTransportRouter({
        seats: [agySeat],
        chains: { reviewer: [{ seatId: 'reviewer' }] },
        locate: async () => cliLocation({ kind: 'installation', remotePort: 46000, remoteHost: '' }),
        ocmRunBin: '/bundled/bin/ocm-run',
        cliSpawn: async (file) => {
          cliCalled = true;
          expect(file).toBe('agy');
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ response: CLI_STDOUT }),
            stderr: '',
          };
        },
        ocmSpawn: async () => {
          ocmCalled = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });

      const result = await router(CLI_REQUEST);

      expect(cliCalled).toBe(true);
      expect(ocmCalled).toBe(false);
      expect(result.result).toBe('pass');
    });
  });
});
