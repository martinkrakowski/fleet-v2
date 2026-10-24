import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectProfileRecord } from '../../domain/coordination-records.js';
import { ProjectProfileRepositoryAdapter } from './ProjectProfileRepositoryAdapter.adapter.js';

describe('ProjectProfileRepositoryAdapter cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-proj-profile-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves both profiles when two adapter instances concurrently save to the same stateDir', async () => {
    const adapterA = new ProjectProfileRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new ProjectProfileRepositoryAdapter({ stateDir: tempDir });

    const profile1: ProjectProfileRecord = {
      projectId: 'proj-1',
      displayName: 'Project One',
      repository: 'org/repo-1',
      designatedDispatcherHost: 'host-1',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: {
        filesystemScope: 'scoped-worktree',
        networkEgressRestricted: true,
      },
      revision: 0,
      updatedAtIso: '2026-10-15T10:00:00.000Z',
      status: 'active',
      defaultBranch: null,
      clones: {},
      gateProcedures: [],
      defaultAllowedPathPrefixes: [],
      lastProbe: null,
    };

    const profile2: ProjectProfileRecord = {
      projectId: 'proj-2',
      displayName: 'Project Two',
      repository: 'org/repo-2',
      designatedDispatcherHost: 'host-2',
      policyRevision: 'pol-2',
      maxConcurrentLanes: 4,
      runnerCapabilities: {
        filesystemScope: 'scoped-worktree',
        networkEgressRestricted: false,
      },
      revision: 0,
      updatedAtIso: '2026-10-15T10:01:00.000Z',
      status: 'active',
      defaultBranch: null,
      clones: {},
      gateProcedures: [],
      defaultAllowedPathPrefixes: [],
      lastProbe: null,
    };

    await Promise.all([adapterA.saveProfile(profile1), adapterB.saveProfile(profile2)]);

    const found1FromA = await adapterA.findProfileById('proj-1');
    const found2FromA = await adapterA.findProfileById('proj-2');
    const found1FromB = await adapterB.findProfileById('proj-1');
    const found2FromB = await adapterB.findProfileById('proj-2');

    expect(found1FromA?.projectId).toBe('proj-1');
    expect(found2FromA?.projectId).toBe('proj-2');
    expect(found1FromB?.projectId).toBe('proj-1');
    expect(found2FromB?.projectId).toBe('proj-2');
  });

  it('throws and preserves file content when saving to a corrupt file', async () => {
    const filePath = path.join(tempDir, 'project-profiles.json');
    const corruptContent = '{ not valid json';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new ProjectProfileRepositoryAdapter({ stateDir: tempDir });
    const profile: ProjectProfileRecord = {
      projectId: 'proj-corrupt',
      displayName: 'Project Corrupt',
      repository: 'org/repo-corrupt',
      designatedDispatcherHost: 'host-1',
      policyRevision: 'pol-1',
      maxConcurrentLanes: 2,
      runnerCapabilities: {
        filesystemScope: 'scoped-worktree',
        networkEgressRestricted: true,
      },
      revision: 0,
      updatedAtIso: '2026-10-15T10:00:00.000Z',
      status: 'active',
      defaultBranch: null,
      clones: {},
      gateProcedures: [],
      defaultAllowedPathPrefixes: [],
      lastProbe: null,
    };

    await expect(adapter.saveProfile(profile)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });
});
