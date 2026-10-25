// ProbeProjectUseCase tests (P3c): probe a registered project and record the
// receipt. Covers the happy path (gate check passes and the receipt records at
// the profile's revision), absent/null installation procedures, gate failures,
// record rejection, retired profiles, absent profiles, bad input, and the
// unconfigured throw.

import { describe, expect, it } from 'vitest';

import { ProbeProjectUseCase } from '../ProbeProjectUseCase.use-case.js';
import type {
  ProjectProfileReadPort,
  ProjectProfileView,
} from '../../ports/out/ProjectProfileReadPort.out-port.js';
import type {
  ProjectProbePort,
  ProjectProbeReport,
  ProjectProbeRequest,
} from '../../ports/out/ProjectProbePort.out-port.js';
import type {
  ProjectProbeRecordPort,
  ProjectProbeRecordRequest,
  ProjectProbeRecordResult,
} from '../../ports/out/ProjectProbeRecordPort.out-port.js';

function makeProfile(overrides: Partial<ProjectProfileView> = {}): ProjectProfileView {
  return {
    projectId: 'proj-a',
    status: 'active',
    repository: 'acme/repo',
    clones: { here: { path: '/srv/clone', worktreeRoot: '/srv/worktree' } },
    gateProcedures: ['verify-head', 'review'],
    revision: 7,
    ...overrides,
  };
}

function makeReport(overrides: Partial<ProjectProbeReport> = {}): ProjectProbeReport {
  return {
    probedAtIso: '2026-10-24T10:00:00.000Z',
    probedFrom: 'orchestrator',
    checks: [{ name: 'repo-answers', host: null, result: 'pass', detail: 'ok' }],
    defaultBranch: 'main',
    detectedScripts: [],
    ...overrides,
  };
}

class FakeProfileRead implements ProjectProfileReadPort {
  calls: string[] = [];

  constructor(private readonly profile: ProjectProfileView | null) {}

  async readProjectProfile(projectId: string): Promise<ProjectProfileView | null> {
    this.calls.push(projectId);
    return this.profile;
  }
}

class FakeProbe implements ProjectProbePort {
  calls: ProjectProbeRequest[] = [];

  constructor(private readonly report: ProjectProbeReport) {}

  async probe(request: ProjectProbeRequest): Promise<ProjectProbeReport> {
    this.calls.push(request);
    return this.report;
  }
}

class FakeProbeRecord implements ProjectProbeRecordPort {
  calls: ProjectProbeRecordRequest[] = [];

  constructor(private readonly result: ProjectProbeRecordResult) {}

  async recordProjectProbe(request: ProjectProbeRecordRequest): Promise<ProjectProbeRecordResult> {
    this.calls.push(request);
    return this.result;
  }
}

const GATE_CHECK = {
  name: 'gate-procedures-known',
  host: null,
};

describe('ProbeProjectUseCase', () => {
  it('records a probe at the profile revision with a passing gate check', async () => {
    const profile = makeProfile();
    const report = makeReport();
    const probe = new FakeProbe(report);
    const record = new FakeProbeRecord({ outcome: 'recorded' });
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(profile),
      probe,
      probeRecord: record,
      verificationProcedureNames: ['verify-head', 'review', 'lint'],
    });

    const result = await useCase.execute({ projectId: 'proj-a' });

    expect(result).toEqual({
      outcome: 'probed',
      projectId: 'proj-a',
      report: {
        ...report,
        checks: [
          ...report.checks,
          { ...GATE_CHECK, result: 'pass', detail: '2 procedures known' },
        ],
      },
      recorded: true,
    });

    expect(probe.calls).toEqual([
      {
        repository: 'acme/repo',
        clones: { here: { path: '/srv/clone', worktreeRoot: '/srv/worktree' } },
      },
    ]);
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]?.projectId).toBe('proj-a');
    expect(record.calls[0]?.expectedRevision).toBe(7);
    expect(record.calls[0]?.receipt.checks[record.calls[0].receipt.checks.length - 1]).toEqual({
      ...GATE_CHECK,
      result: 'pass',
      detail: '2 procedures known',
    });
  });

  it('fails the gate check naming the first missing procedure in sorted order', async () => {
    const profile = makeProfile({ gateProcedures: ['beta', 'alpha'] });
    const probe = new FakeProbe(makeReport());
    const record = new FakeProbeRecord({ outcome: 'recorded' });
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(profile),
      probe,
      probeRecord: record,
      verificationProcedureNames: ['gamma'],
    });

    const result = await useCase.execute({ projectId: 'proj-a' });

    expect(result).toMatchObject({
      outcome: 'probed',
      recorded: true,
      report: {
        checks: [
          { name: 'repo-answers', host: null, result: 'pass', detail: 'ok' },
          { ...GATE_CHECK, result: 'fail', detail: 'unknown gate procedure alpha' },
        ],
      },
    });
  });

  it('reports the unknown text when no installation procedures were supplied', async () => {
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(makeProfile()),
      probe: new FakeProbe(makeReport()),
      probeRecord: new FakeProbeRecord({ outcome: 'recorded' }),
    });

    const result = await useCase.execute({ projectId: 'proj-a' });

    expect(result).toMatchObject({
      outcome: 'probed',
      report: {
        checks: expect.arrayContaining([
          { ...GATE_CHECK, result: 'unknown', detail: 'no installation procedures were supplied' },
        ]),
      },
    });
  });

  it('reports the unknown text when no installation is loaded', async () => {
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(makeProfile()),
      probe: new FakeProbe(makeReport()),
      probeRecord: new FakeProbeRecord({ outcome: 'recorded' }),
      verificationProcedureNames: null,
    });

    const result = await useCase.execute({ projectId: 'proj-a' });

    expect(result).toMatchObject({
      outcome: 'probed',
      report: {
        checks: expect.arrayContaining([
          { ...GATE_CHECK, result: 'unknown', detail: 'no installation is loaded' },
        ]),
      },
    });
  });

  it('returns recorded false with the reason when the record is rejected', async () => {
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(makeProfile()),
      probe: new FakeProbe(makeReport()),
      probeRecord: new FakeProbeRecord({
        outcome: 'rejected',
        reason: 'x',
      }),
      verificationProcedureNames: ['verify-head', 'review'],
    });

    const result = await useCase.execute({ projectId: 'proj-a' });

    expect(result.outcome).toBe('probed');
    if (result.outcome !== 'probed') {
      throw new Error(`expected probed, got ${result.outcome}`);
    }
    expect(result.recorded).toBe(false);
    if (result.recorded) {
      throw new Error('expected recorded false');
    }
    expect(result.recordReason).toBe('x');
    expect(result.report.checks[result.report.checks.length - 1]).toEqual({
      ...GATE_CHECK,
      result: 'pass',
      detail: '2 procedures known',
    });
  });

  it('reads the profile once and uses the first read revision as expectedRevision', async () => {
    let nextRevision = 7;
    const readCalls: string[] = [];
    const profileRead: ProjectProfileReadPort = {
      readProjectProfile: async (projectId) => {
        readCalls.push(projectId);
        const revision = nextRevision;
        nextRevision += 1;
        return makeProfile({ revision });
      },
    };
    const record = new FakeProbeRecord({ outcome: 'recorded' });
    const useCase = new ProbeProjectUseCase({
      profileRead,
      probe: new FakeProbe(makeReport()),
      probeRecord: record,
      verificationProcedureNames: ['verify-head', 'review'],
    });

    const result = await useCase.execute({ projectId: 'proj-a' });

    expect(result.outcome).toBe('probed');
    expect(readCalls).toEqual(['proj-a']);
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]?.expectedRevision).toBe(7);
  });

  it('rejects a retired profile without probing', async () => {
    const probe = new FakeProbe(makeReport());
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(makeProfile({ status: 'retired' })),
      probe,
      probeRecord: new FakeProbeRecord({ outcome: 'recorded' }),
      verificationProcedureNames: ['verify-head'],
    });

    const result = await useCase.execute({ projectId: 'proj-a' });

    expect(result).toEqual({ outcome: 'rejected', reason: 'project proj-a is retired' });
    expect(probe.calls).toHaveLength(0);
  });

  it('returns not-found without probing when the profile is unknown', async () => {
    const probe = new FakeProbe(makeReport());
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(null),
      probe,
      probeRecord: new FakeProbeRecord({ outcome: 'recorded' }),
      verificationProcedureNames: ['verify-head'],
    });

    const result = await useCase.execute({ projectId: 'proj-a' });

    expect(result).toEqual({ outcome: 'not-found', projectId: 'proj-a' });
    expect(probe.calls).toHaveLength(0);
  });

  it('rejects a blank or non-string projectId', async () => {
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(makeProfile()),
      probe: new FakeProbe(makeReport()),
      probeRecord: new FakeProbeRecord({ outcome: 'recorded' }),
      verificationProcedureNames: [],
    });

    await expect(useCase.execute({ projectId: '   ' })).resolves.toEqual({
      outcome: 'rejected',
      reason: 'projectId is required',
    });
    await expect(useCase.execute({})).resolves.toEqual({
      outcome: 'rejected',
      reason: 'projectId is required',
    });
    await expect(useCase.execute({ projectId: 42 })).resolves.toEqual({
      outcome: 'rejected',
      reason: 'projectId is required',
    });
  });

  it('rejects a non-plain object request', async () => {
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(makeProfile()),
      probe: new FakeProbe(makeReport()),
      probeRecord: new FakeProbeRecord({ outcome: 'recorded' }),
      verificationProcedureNames: [],
    });

    await expect(useCase.execute([])).resolves.toEqual({
      outcome: 'rejected',
      reason: 'request must be an object',
    });
    await expect(useCase.execute(new Date())).resolves.toEqual({
      outcome: 'rejected',
      reason: 'request must be an object',
    });
  });

  it('throws Not implemented when constructed without dependencies', async () => {
    const useCase = new ProbeProjectUseCase();
    await expect(useCase.execute({ projectId: 'proj-a' })).rejects.toThrow(
      /^Not implemented: ProbeProjectUseCase$/,
    );
  });

  it('propagates a probe error instead of returning it', async () => {
    const probe: ProjectProbePort = {
      probe: async () => {
        throw new Error('probe exploded');
      },
    };
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(makeProfile()),
      probe,
      probeRecord: new FakeProbeRecord({ outcome: 'recorded' }),
      verificationProcedureNames: [],
    });

    await expect(useCase.execute({ projectId: 'proj-a' })).rejects.toThrow('probe exploded');
  });

  it('propagates a profile read error instead of returning it', async () => {
    const profileRead: ProjectProfileReadPort = {
      readProjectProfile: async () => {
        throw new Error('read exploded');
      },
    };
    const useCase = new ProbeProjectUseCase({
      profileRead,
      probe: new FakeProbe(makeReport()),
      probeRecord: new FakeProbeRecord({ outcome: 'recorded' }),
      verificationProcedureNames: [],
    });

    await expect(useCase.execute({ projectId: 'proj-a' })).rejects.toThrow('read exploded');
  });

  it('propagates a probe record error instead of returning it', async () => {
    const probeRecord: ProjectProbeRecordPort = {
      recordProjectProbe: async () => {
        throw new Error('record exploded');
      },
    };
    const useCase = new ProbeProjectUseCase({
      profileRead: new FakeProfileRead(makeProfile()),
      probe: new FakeProbe(makeReport()),
      probeRecord,
      verificationProcedureNames: [],
    });

    await expect(useCase.execute({ projectId: 'proj-a' })).rejects.toThrow('record exploded');
  });
});
