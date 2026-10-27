// Lane S1e: the operator surface for the seat plan. These tests prove the
// CLI wiring — `brief prepare --seatPlan/--seatPlanFromInstallation`,
// `attempt fix` passing unhealthy seat ids, and the read-only
// `attempt next-seat` — against the seat-plan domain helpers and a v2
// installation fixture with distinct model families.

import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from '../index.js';
import { createFleetCliRuntime } from '../composition.js';
import { seatPlanFromInstallation, unhealthySeatIdsOf } from '../seat-plan.js';
import {
  deriveInstallationModel,
  isFleetInstallationV2,
  type FleetInstallation,
  type FleetInstallationModel,
} from '@fleet/installation';
import { SeatPlan, type AttemptRecord } from '@fleet/work-execution';

function capturingIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) },
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// Fixture: a v2 installation with four seats, families distinct.
// ---------------------------------------------------------------------------

function makeInstallation(overrides: Partial<FleetInstallation> = {}): FleetInstallation {
  return {
    schemaVersion: 2,
    forge: { mode: 'none' },
    seats: [
      { id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3', agent: 'lane', roles: ['implementer'], costClass: 'paid' },
      { id: 'impl-b', tool: 'opencode', model: 'acme/argon-4', roles: ['implementer'], costClass: 'paid' },
      { id: 'impl-c', tool: 'opencode', model: 'acme/glm-5.3', variant: 'low', roles: ['implementer'], costClass: 'paid' },
      { id: 'rev-a', tool: 'opencode', model: 'acme/grok-4.7', roles: ['reviewer'], costClass: 'paid' },
    ],
    chains: {
      implementer: [{ seatId: 'impl-a' }],
      fix: [{ seatId: 'impl-b' }, { seatId: 'impl-c', triggers: ['429'] }],
      reviewer: [{ seatId: 'rev-a' }],
    },
    ...overrides,
  };
}

function installationModel(overrides: Partial<FleetInstallation> = {}): FleetInstallationModel {
  return deriveInstallationModel(makeInstallation(overrides)).model;
}

const FIRST_PASS = [{ id: 'impl-a', model: 'acme/mercury-3', tool: 'opencode', agent: 'lane' }];
const FIX = [
  { id: 'impl-b', model: 'acme/argon-4', tool: 'opencode' },
  { id: 'impl-c', model: 'acme/glm-5.3', tool: 'opencode', variant: 'low', on: ['rate-limited'] },
];
const REVIEW = [{ id: 'rev-a', model: 'acme/grok-4.7', tool: 'opencode' }];

function planOf(result: ReturnType<typeof seatPlanFromInstallation>) {
  if ('reason' in result) {
    throw new Error(`expected a plan, got reason: ${result.reason}`);
  }
  return result.plan;
}

// ---------------------------------------------------------------------------
// seat-plan.ts unit tests
// ---------------------------------------------------------------------------

describe('seatPlanFromInstallation', () => {
  it('builds the plan from the fixture chains', () => {
    const plan = planOf(seatPlanFromInstallation(installationModel()));
    expect(plan.version).toBe(1);
    expect(plan['first-pass']).toEqual(FIRST_PASS);
    expect(plan.fix).toEqual(FIX);
    expect(plan.review).toEqual(REVIEW);
  });

  it('fix equals the implementer chain when no fix chain exists', () => {
    const plan = planOf(
      seatPlanFromInstallation(installationModel({ chains: { implementer: [{ seatId: 'impl-a' }], reviewer: [{ seatId: 'rev-a' }] } })),
    );
    expect(plan.fix).toEqual(plan['first-pass']);
  });

  it('returns a reason when the installation has no implementer chain', () => {
    const result = seatPlanFromInstallation(
      installationModel({ chains: { reviewer: [{ seatId: 'rev-a' }] } }),
    );
    expect('reason' in result).toBe(true);
  });
});

describe('unhealthySeatIdsOf', () => {
  it('lists unhealthy seats in file order', () => {
    const model = installationModel({
      seats: [
        { id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3', agent: 'lane', roles: ['implementer'], costClass: 'paid' },
        { id: 'impl-b', tool: 'opencode', model: 'acme/argon-4', roles: ['implementer'], costClass: 'paid', health: 'unhealthy' },
      ],
    });
    expect(unhealthySeatIdsOf(model)).toEqual(['impl-b']);
  });

  it('returns [] for an undefined model', () => {
    expect(unhealthySeatIdsOf(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CLI tests
// ---------------------------------------------------------------------------

function briefArgs(extra: string[] = []): string[] {
  return [
    'brief',
    'prepare',
    '--workOrderId',
    'wo-s1e',
    '--projectId',
    'proj-s1e',
    '--taskId',
    'task-s1e',
    '--laneId',
    'lane-s1e',
    '--repository',
    'github.com/org/repo',
    '--baseCommit',
    'abc123',
    '--policyRevision',
    'pol-1',
    '--ownedPaths',
    'src/',
    '--seatTool',
    'opencode',
    '--independentReviewer',
    'reviewer-model',
    ...extra,
  ];
}

interface CapturedBriefRequest {
  modelAssignment?: { model?: string; variant?: string; fallbackModel?: string; seatTool?: string; agent?: string };
  seatPlan?: unknown;
}

interface StubPrepareBrief {
  prepareBriefPackage(req: CapturedBriefRequest): Promise<{ outcome: 'prepared'; prepared: unknown }>;
}

function stubPrepare(runtime: ReturnType<typeof createFleetCliRuntime>) {
  let captured: CapturedBriefRequest | undefined;
  const stub = runtime.execution.prepareBriefPackage as unknown as StubPrepareBrief;
  stub.prepareBriefPackage = async (req) => {
    captured = req;
    return {
      outcome: 'prepared',
      prepared: {
        attemptId: 'att-s1e',
        briefDigest: 'digest',
        prosePath: '.lane/brief.md',
        manifestPath: '.lane/brief-manifest.json',
        selectedKnowledgeVersions: [],
      },
    };
  };
  return { captured: () => captured };
}

describe('brief prepare seat-plan flags', () => {
  it('sends exactly today\'s request when neither seat-plan flag is given', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    const { captured } = stubPrepare(rt);
    const { io, stdout } = capturingIo();

    const exitCode = await runCli(briefArgs(['--model', 'acme/mercury-3']), io, rt);

    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    const req = captured();
    expect(req).toBeDefined();
    expect('seatPlan' in (req ?? {})).toBe(false);
    expect(req?.modelAssignment?.model).toBe('acme/mercury-3');
  });

  it('refuses both flags together (exit 2)', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    const { io, stdout, stderr } = capturingIo();

    const exitCode = await runCli(
      briefArgs(['--seatPlan', '{"version":1}', '--seatPlanFromInstallation']),
      io,
      rt,
    );

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("takes '--seatPlan' or '--seatPlanFromInstallation', not both");
    expect(stdout).toHaveLength(0);
  });

  it('rejects a JSON --seatPlan that is not a valid seat plan (exit 2), never a crash', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    const { io, stdout, stderr } = capturingIo();

    const exitCode = await runCli(briefArgs(['--seatPlan', '{"version":1}']), io, rt);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("'--seatPlan' is not a valid seat plan");
    expect(stderr.join('')).not.toContain('TypeError');
    expect(stdout).toHaveLength(0);
  });

  it('rejects a malformed JSON --seatPlan (exit 2)', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    const { io, stdout, stderr } = capturingIo();

    const exitCode = await runCli(briefArgs(['--seatPlan', 'not-json']), io, rt);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("requires a JSON object in '--seatPlan'");
    expect(stdout).toHaveLength(0);
  });

  it('--seatPlanFromInstallation needs a v2 installation (exit 2)', async () => {
    const rt = createFleetCliRuntime({});
    const { io, stdout, stderr } = capturingIo();

    const exitCode = await runCli(briefArgs(['--seatPlanFromInstallation']), io, rt);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("'--seatPlanFromInstallation' needs a v2 installation");
    expect(stdout).toHaveLength(0);
  });

  it('fills the model assignment from the first healthy first-pass seat', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    const { captured } = stubPrepare(rt);
    const { io } = capturingIo();

    const exitCode = await runCli(briefArgs(['--seatPlanFromInstallation']), io, rt);

    expect(exitCode).toBe(0);
    const req = captured();
    expect(req?.modelAssignment?.model).toBe('acme/mercury-3');
    expect(req?.modelAssignment?.seatTool).toBe('opencode');
    expect(req?.modelAssignment?.agent).toBe('lane');
    const plan = req?.seatPlan as { 'first-pass'?: { id: string }[] } | undefined;
    expect(plan?.['first-pass']?.[0]?.id).toBe('impl-a');
  });

  it('refuses when every first-pass seat is unhealthy (exit 2)', async () => {
    const rt = createFleetCliRuntime({
      installation: makeInstallation({
        seats: [
          { id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3', agent: 'lane', roles: ['implementer'], costClass: 'paid', health: 'unhealthy' },
          { id: 'impl-b', tool: 'opencode', model: 'acme/argon-4', roles: ['implementer'], costClass: 'paid' },
          { id: 'impl-c', tool: 'opencode', model: 'acme/glm-5.3', variant: 'low', roles: ['implementer'], costClass: 'paid' },
          { id: 'rev-a', tool: 'opencode', model: 'acme/grok-4.7', roles: ['reviewer'], costClass: 'paid' },
        ],
      }),
    });
    const { io, stdout, stderr } = capturingIo();

    const exitCode = await runCli(briefArgs(['--seatPlanFromInstallation']), io, rt);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain('Every first-pass seat of the seat plan is unhealthy');
    expect(stdout).toHaveLength(0);
  });
});

describe('attempt next-seat', () => {
  function makePrior(): AttemptRecord {
    return {
      id: 'att-s1e-prior',
      workOrderId: 'wo-s1e',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/lanes/s1e',
      baseCommit: 'abc123',
      state: 'ended',
      outcome: 'done',
      briefDigest: 'digest',
      briefPackagePath: '.lane/brief.md',
      sessionId: 'session-1',
      completionReceipt: null,
      artifacts: null,
      seatPlan: planOf(seatPlanFromInstallation(installationModel())),
      seatSelection: {
        role: 'first-pass',
        seatIndex: 0,
        seatId: 'impl-a',
        model: 'acme/mercury-3',
        tool: 'opencode',
        variant: null,
        agent: 'lane',
      },
      runner: {
        kind: 'opencode',
        remotePort: null,
        host: null,
        agent: 'lane',
        model: 'acme/mercury-3',
        variant: 'default',
      },
      stopReason: 'none',
      createdAtIso: '2026-10-27T08:00:00.000Z',
      updatedAtIso: '2026-10-27T08:00:00.000Z',
    };
  }

  it('prints the next fix seat and the review seat', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    await rt.execution.attemptRepository.saveAttempt(makePrior());

    const { io, stdout } = capturingIo();
    const fixCode = await runCli(['attempt', 'next-seat', '--attemptId', 'att-s1e-prior', '--role', 'fix'], io, rt);
    expect(fixCode).toBe(0);
    const fix = JSON.parse(stdout.join('')) as { outcome: string; seat: { id: string } };
    expect(fix.outcome).toBe('selected');
    expect(fix.seat.id).toBe('impl-b');

    const reviewIo = capturingIo();
    const reviewCode = await runCli(['attempt', 'next-seat', '--attemptId', 'att-s1e-prior', '--role', 'review'], reviewIo.io, rt);
    expect(reviewCode).toBe(0);
    const review = JSON.parse(reviewIo.stdout.join('')) as { outcome: string; seat: { id: string } };
    expect(review.outcome).toBe('selected');
    expect(review.seat.id).toBe('rev-a');
  });

  it('reports exhausted when the fix seat is unhealthy (exit 1)', async () => {
    const rt = createFleetCliRuntime({
      installation: makeInstallation({
        seats: [
          { id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3', agent: 'lane', roles: ['implementer'], costClass: 'paid' },
          { id: 'impl-b', tool: 'opencode', model: 'acme/argon-4', roles: ['implementer'], costClass: 'paid', health: 'unhealthy' },
          { id: 'impl-c', tool: 'opencode', model: 'acme/glm-5.3', variant: 'low', roles: ['implementer'], costClass: 'paid' },
          { id: 'rev-a', tool: 'opencode', model: 'acme/grok-4.7', roles: ['reviewer'], costClass: 'paid' },
        ],
      }),
    });
    await rt.execution.attemptRepository.saveAttempt(makePrior());

    const { io, stdout } = capturingIo();
    const exitCode = await runCli(['attempt', 'next-seat', '--attemptId', 'att-s1e-prior', '--role', 'fix'], io, rt);

    expect(exitCode).toBe(1);
    expect(stdout.join('')).toContain('impl-c: waits for rate-limited');
  });

  it('refuses an unknown attempt (exit 1) and a bad role (exit 2)', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });

    const unknownIo = capturingIo();
    const unknownCode = await runCli(['attempt', 'next-seat', '--attemptId', 'nope', '--role', 'fix'], unknownIo.io, rt);
    expect(unknownCode).toBe(1);
    expect(unknownIo.stdout.join('')).toContain('Attempt not found');

    const badRoleIo = capturingIo();
    const badRoleCode = await runCli(['attempt', 'next-seat', '--attemptId', 'att-s1e-prior', '--role', 'other'], badRoleIo.io, rt);
    expect(badRoleCode).toBe(2);
  });
});

describe('attempt fix', () => {
  function fixArgs(extra: string[] = []): string[] {
    return [
      'attempt',
      'fix',
      '--fixAttemptId',
      'att-s1e-fix',
      '--workOrderId',
      'wo-s1e',
      '--priorAttemptId',
      'att-s1e-prior',
      '--worktreePath',
      '/lanes/s1e',
      '--baseCommit',
      'abc123',
      '--numberedFixes',
      '["1. fix"]',
      ...extra,
    ];
  }

  function priorForFix(): AttemptRecord {
    const prior: AttemptRecord = {
      id: 'att-s1e-prior',
      workOrderId: 'wo-s1e',
      kind: 'initial',
      fixNumber: 0,
      priorAttemptId: null,
      worktreePath: '/lanes/s1e',
      baseCommit: 'abc123',
      state: 'ended',
      outcome: 'done',
      briefDigest: 'digest',
      briefPackagePath: '.lane/brief.md',
      sessionId: 'session-1',
      completionReceipt: null,
      artifacts: null,
      seatPlan: planOf(seatPlanFromInstallation(installationModel())),
      seatSelection: {
        role: 'first-pass',
        seatIndex: 0,
        seatId: 'impl-a',
        model: 'acme/mercury-3',
        tool: 'opencode',
        variant: null,
        agent: 'lane',
      },
      runner: {
        kind: 'opencode',
        remotePort: null,
        host: null,
        agent: 'lane',
        model: 'acme/mercury-3',
        variant: 'default',
      },
      stopReason: 'none',
      createdAtIso: '2026-10-27T08:00:00.000Z',
      updatedAtIso: '2026-10-27T08:00:00.000Z',
    };
    return prior;
  }

  function installationWithUnhealthyImplB(): FleetInstallation {
    return makeInstallation({
      seats: [
        { id: 'impl-a', tool: 'opencode', model: 'acme/mercury-3', agent: 'lane', roles: ['implementer'], costClass: 'paid' },
        { id: 'impl-b', tool: 'opencode', model: 'acme/argon-4', roles: ['implementer'], costClass: 'paid', health: 'unhealthy' },
        { id: 'impl-c', tool: 'opencode', model: 'acme/glm-5.3', variant: 'low', roles: ['implementer'], costClass: 'paid' },
        { id: 'rev-a', tool: 'opencode', model: 'acme/grok-4.7', roles: ['reviewer'], costClass: 'paid' },
      ],
    });
  }

  it('prepares the fix attempt on the next eligible fix seat', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    await rt.execution.attemptRepository.saveAttempt(priorForFix());

    const { io, stdout } = capturingIo();
    const exitCode = await runCli(fixArgs(), io, rt);

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.join('')) as { outcome: string; attempt: { seatSelection: { seatId: string } } };
    expect(result.outcome).toBe('prepared');
    expect(result.attempt.seatSelection.seatId).toBe('impl-b');
  });

  it('refuses when the installation marks the fix seat unhealthy (exit 1)', async () => {
    const rt = createFleetCliRuntime({ installation: installationWithUnhealthyImplB() });
    await rt.execution.attemptRepository.saveAttempt(priorForFix());

    const { io, stdout } = capturingIo();
    const exitCode = await runCli(fixArgs(), io, rt);

    expect(exitCode).toBe(1);
    expect(stdout.join('')).toContain('impl-c: waits for rate-limited');
  });

  it('adds --unhealthySeatIds to the installation\'s unhealthy list', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    await rt.execution.attemptRepository.saveAttempt(priorForFix());

    const { io, stdout } = capturingIo();
    const exitCode = await runCli(fixArgs(['--unhealthySeatIds', '["impl-b"]']), io, rt);

    expect(exitCode).toBe(1);
    expect(stdout.join('')).toContain('impl-c: waits for rate-limited');
  });

  it('a malformed --unhealthySeatIds is a usage error (exit 2)', async () => {
    const rt = createFleetCliRuntime({ installation: makeInstallation() });
    await rt.execution.attemptRepository.saveAttempt(priorForFix());

    const { io, stdout, stderr } = capturingIo();
    const exitCode = await runCli(fixArgs(['--unhealthySeatIds', 'bad']), io, rt);

    expect(exitCode).toBe(2);
    expect(stderr.join('')).toContain("'--unhealthySeatIds'");
    expect(stdout).toHaveLength(0);
  });
});

describe('seat plan fixture sanity', () => {
  it('the fixture is a v2 installation that derives a plan', () => {
    const installation = makeInstallation();
    expect(isFleetInstallationV2(installation)).toBe(true);
    const model = installationModel();
    expect(SeatPlan.create(planOf(seatPlanFromInstallation(model))).success).toBe(true);
  });
});
