// Delegate adapter tests for P3c: ProjectProfileReadAdapter and
// ProjectProbeRecordAdapter map the coordination context's typed answers and
// throw when no delegate has been bound (composition-root wiring belongs to a
// later lane).

import { describe, expect, it } from 'vitest';

import { ProjectProfileReadAdapter } from '../ProjectProfileReadAdapter.adapter.js';
import { ProjectProbeRecordAdapter } from '../ProjectProbeRecordAdapter.adapter.js';
import type { ProjectProfileView } from '../../../application/ports/out/ProjectProfileReadPort.out-port.js';
import type { ProjectProbeRecordRequest } from '../../../application/ports/out/ProjectProbeRecordPort.out-port.js';

function makeProfile(overrides: Partial<ProjectProfileView> = {}): ProjectProfileView {
  return {
    projectId: 'proj-a',
    status: 'active',
    repository: 'acme/repo',
    clones: { here: { path: '/srv/clone', worktreeRoot: '/srv/worktree' } },
    gateProcedures: ['verify-head'],
    revision: 3,
    ...overrides,
  };
}

function makeRecordRequest(
  overrides: Partial<ProjectProbeRecordRequest> = {},
): ProjectProbeRecordRequest {
  return {
    projectId: 'proj-a',
    expectedRevision: 3,
    receipt: {
      probedAtIso: '2026-10-24T10:00:00.000Z',
      probedFrom: 'orchestrator',
      checks: [{ name: 'repo-answers', host: null, result: 'pass', detail: 'ok' }],
    },
    ...overrides,
  };
}

describe('ProjectProfileReadAdapter', () => {
  it('maps a found answer to a ProjectProfileView copying only the six fields', async () => {
    const profile = makeProfile();
    const answerProfile = { ...profile, displayName: 'Acme', policyRevision: 'p1' };
    const adapter = new ProjectProfileReadAdapter({
      inspect: async () => ({ outcome: 'found', profile: answerProfile }),
    });

    const result = await adapter.readProjectProfile('proj-a');
    expect(result).toEqual(profile);
    expect(result?.clones).not.toBe(answerProfile.clones);
  });

  it('maps a not-found answer to null', async () => {
    const adapter = new ProjectProfileReadAdapter({
      inspect: async () => ({ outcome: 'not-found', projectId: 'proj-a' }),
    });

    await expect(adapter.readProjectProfile('proj-a')).resolves.toBeNull();
  });

  it('maps a rejected answer to a thrown error carrying the reason', async () => {
    const adapter = new ProjectProfileReadAdapter({
      inspect: async () => ({ outcome: 'rejected', reason: 'not allowed' }),
    });

    await expect(adapter.readProjectProfile('proj-a')).rejects.toThrow('not allowed');
  });

  const malformedAnswers: ReadonlyArray<{ label: string; answer: unknown }> = [
    { label: 'unknown outcome', answer: { outcome: 'something-else' } },
    { label: 'null profile', answer: { outcome: 'found', profile: null } },
    {
      label: 'non-string projectId',
      answer: {
        outcome: 'found',
        profile: { projectId: 1, status: 'active', repository: 'r', clones: {}, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'mismatched projectId',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-b', status: 'active', repository: 'r', clones: {}, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'invalid status',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'weird', repository: 'r', clones: {}, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'non-string repository',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 7, clones: {}, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'clones as an array',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: [], gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'clones as null',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: null, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'malformed clone',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: { h: { path: 1, worktreeRoot: '/w' } }, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'clone with empty path',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: { h: { path: '', worktreeRoot: '/w' } }, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'clone with relative path',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: { h: { path: 'rel/path', worktreeRoot: '/w' } }, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'clone with empty worktreeRoot',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: { h: { path: '/p', worktreeRoot: '' } }, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'clone with relative worktreeRoot',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: { h: { path: '/p', worktreeRoot: 'rel/w' } }, gateProcedures: [], revision: 1 },
      },
    },
    {
      label: 'clone key __proto__',
      answer: {
        outcome: 'found',
        profile: {
          projectId: 'proj-a',
          status: 'active',
          repository: 'r',
          clones: { ['__proto__']: { path: '/p', worktreeRoot: '/w' } },
          gateProcedures: [],
          revision: 1,
        },
      },
    },
    {
      label: 'clone key host 1',
      answer: {
        outcome: 'found',
        profile: {
          projectId: 'proj-a',
          status: 'active',
          repository: 'r',
          clones: { 'host 1': { path: '/p', worktreeRoot: '/w' } },
          gateProcedures: [],
          revision: 1,
        },
      },
    },
    {
      label: 'non-array gateProcedures',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: {}, gateProcedures: 'nope', revision: 1 },
      },
    },
    {
      label: 'non-number revision',
      answer: {
        outcome: 'found',
        profile: { projectId: 'proj-a', status: 'active', repository: 'r', clones: {}, gateProcedures: [], revision: '1' },
      },
    },
  ];

  for (const { label, answer } of malformedAnswers) {
    it(`throws malformed for ${label}`, async () => {
      const adapter = new ProjectProfileReadAdapter({
        inspect: async () => answer,
      });

      await expect(adapter.readProjectProfile('proj-a')).rejects.toThrow(
        'ProjectProfileReadAdapter received a malformed profile for proj-a',
      );
    });
  }

  it('throws Not implemented when constructed without a delegate', async () => {
    const adapter = new ProjectProfileReadAdapter();

    await expect(adapter.readProjectProfile('proj-a')).rejects.toThrow(
      /^Not implemented: ProjectProfileReadAdapter$/,
    );
  });
});

describe('ProjectProbeRecordAdapter', () => {
  it('maps a recorded answer to recorded', async () => {
    const adapter = new ProjectProbeRecordAdapter({
      record: async () => ({ outcome: 'recorded' }),
    });

    await expect(adapter.recordProjectProbe(makeRecordRequest())).resolves.toEqual({
      outcome: 'recorded',
    });
  });

  it('maps a rejected answer to rejected with its reason', async () => {
    const adapter = new ProjectProbeRecordAdapter({
      record: async () => ({ outcome: 'rejected', reason: 'profile changed' }),
    });

    await expect(adapter.recordProjectProbe(makeRecordRequest())).resolves.toEqual({
      outcome: 'rejected',
      reason: 'profile changed',
    });
  });

  it('throws on any other answer', async () => {
    const adapter = new ProjectProbeRecordAdapter({
      record: async () => ({ outcome: 'weird' }),
    });

    await expect(adapter.recordProjectProbe(makeRecordRequest())).rejects.toThrow(
      /unexpected answer/,
    );
  });

  it('throws Not implemented when constructed without a delegate', async () => {
    const adapter = new ProjectProbeRecordAdapter();

    await expect(adapter.recordProjectProbe(makeRecordRequest())).rejects.toThrow(
      /^Not implemented: ProjectProbeRecordAdapter$/,
    );
  });
});

describe('delegate adapters refuse malformed answers at the boundary', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'refuses a profile revision of %s',
    async (revision) => {
      const adapter = new ProjectProfileReadAdapter({
        inspect: async () => ({
          outcome: 'found',
          profile: { projectId: 'p', status: 'active', repository: 'r', clones: {}, gateProcedures: [], revision },
        }),
      });
      await expect(adapter.readProjectProfile('p')).rejects.toThrow(
        'ProjectProfileReadAdapter received a malformed profile for p',
      );
    },
  );

  it.each([{ outcome: 'rejected' }, { outcome: 'rejected', reason: '' }, { outcome: 'rejected', reason: { x: 1 } }])(
    'refuses a rejection without a string reason: %j',
    async (answer) => {
      const adapter = new ProjectProbeRecordAdapter({ record: async () => answer });
      await expect(
        adapter.recordProjectProbe({
          projectId: 'p',
          expectedRevision: 0,
          receipt: { probedAtIso: '2026-10-24T00:00:00.000Z', probedFrom: 'orchestrator', checks: [] },
        }),
      ).rejects.toThrow('ProjectProbeRecordAdapter received a rejection without a reason');
    },
  );

  it.each([null, undefined, 'recorded', 42, true])(
    'refuses a primitive or null record answer: %s',
    async (answer) => {
      const adapter = new ProjectProbeRecordAdapter({ record: async () => answer });
      await expect(adapter.recordProjectProbe(makeRecordRequest())).rejects.toThrow(
        /unexpected answer/,
      );
    },
  );
});
