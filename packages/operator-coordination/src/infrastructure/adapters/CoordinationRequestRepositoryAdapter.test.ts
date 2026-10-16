import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '../../domain/coordination-records.js';
import { CoordinationRequestRepositoryAdapter } from './CoordinationRequestRepositoryAdapter.adapter.js';

describe('CoordinationRequestRepositoryAdapter cross-process safe persistence', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-coord-req-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves both requests when two adapter instances concurrently save to the same stateDir', async () => {
    const adapterA = new CoordinationRequestRepositoryAdapter({ stateDir: tempDir });
    const adapterB = new CoordinationRequestRepositoryAdapter({ stateDir: tempDir });

    const req1: CoordinationRequestRecord = {
      id: 'req-1',
      projectId: 'proj-1',
      kind: 'action-decision',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'commit-1',
      proposalDigest: 'prop-1',
      policyRevision: 'pol-1',
      decisionRevision: null,
      grantId: 'grant-1',
      state: 'proposed',
      deliveryStatus: 'pending',
      deliveryGapReason: null,
      revision: 1,
      consumptions: [],
      acknowledgements: [],
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    const req2: CoordinationRequestRecord = {
      id: 'req-2',
      projectId: 'proj-1',
      kind: 'action-decision',
      actionScope: 'forge:merge-pr',
      expectedHeadSha: 'commit-2',
      proposalDigest: 'prop-2',
      policyRevision: 'pol-1',
      decisionRevision: null,
      grantId: 'grant-2',
      state: 'proposed',
      deliveryStatus: 'pending',
      deliveryGapReason: null,
      revision: 1,
      consumptions: [],
      acknowledgements: [],
      createdAtIso: '2026-10-15T10:01:00.000Z',
      updatedAtIso: '2026-10-15T10:01:00.000Z',
    };

    await Promise.all([adapterA.saveRequest(req1), adapterB.saveRequest(req2)]);

    const found1FromA = await adapterA.findRequestById('req-1');
    const found2FromA = await adapterA.findRequestById('req-2');
    const found1FromB = await adapterB.findRequestById('req-1');
    const found2FromB = await adapterB.findRequestById('req-2');

    expect(found1FromA?.id).toBe('req-1');
    expect(found2FromA?.id).toBe('req-2');
    expect(found1FromB?.id).toBe('req-1');
    expect(found2FromB?.id).toBe('req-2');

    const grantFound = await adapterA.findRequestByGrantId('grant-2');
    expect(grantFound?.id).toBe('req-2');

    const allRequests = await adapterA.listRequests('proj-1');
    expect(allRequests.map((r) => r.id).sort()).toEqual(['req-1', 'req-2']);
  });

  it('throws and preserves file content when saving to a corrupt file', async () => {
    const filePath = path.join(tempDir, 'coordination-requests.json');
    const corruptContent = '{ not valid json';
    await fs.writeFile(filePath, corruptContent, 'utf8');

    const adapter = new CoordinationRequestRepositoryAdapter({ stateDir: tempDir });
    const req: CoordinationRequestRecord = {
      id: 'req-corrupt',
      projectId: 'proj-1',
      kind: 'action-decision',
      actionScope: 'forge:push-and-open-pr',
      expectedHeadSha: 'commit-1',
      proposalDigest: 'prop-1',
      policyRevision: 'pol-1',
      decisionRevision: null,
      grantId: 'grant-corrupt',
      state: 'proposed',
      deliveryStatus: 'pending',
      deliveryGapReason: null,
      revision: 1,
      consumptions: [],
      acknowledgements: [],
      createdAtIso: '2026-10-15T10:00:00.000Z',
      updatedAtIso: '2026-10-15T10:00:00.000Z',
    };

    await expect(adapter.saveRequest(req)).rejects.toThrow();

    const contentAfter = await fs.readFile(filePath, 'utf8');
    expect(contentAfter).toBe(corruptContent);
  });
});
