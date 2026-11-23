import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoordinationRequestRecord } from '@fleet/operator-coordination';
import { createFleetCliRuntime } from '../composition.js';
import {
  approvedAnswerFields,
  ephemeralOwnerKey,
  expectApprovedAnswerReadableThrough,
  writeSignedAnswer,
} from '../__tests__/signed-decision-fixture.js';

// AR3a: composeExecution wires `actionAuthorization.authorizeRelaunchApply`
// through the real coordination `ResolveActionAuthorizationUseCase`, so a
// signed, approved, digest-bound relaunch-apply grant resolves head-free and
// everything else fails closed.

const DIGEST = 'a'.repeat(64);
const GRANT_ID = 'grant-relaunch-1';
const REQUEST_ID = 'relaunch-request-1';

/** KEY0c1b: the ephemeral owner key the runtime under test pins. */
const ownerKey = ephemeralOwnerKey();

function relaunchRecord(overrides: Partial<CoordinationRequestRecord> = {}): CoordinationRequestRecord {
  return {
    id: REQUEST_ID,
    projectId: 'relaunch',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'relaunch:apply',
    expectedHeadSha: null,
    proposalDigest: DIGEST,
    policyRevision: 'pol-relaunch-1',
    decisionRevision: 'dec-relaunch-1',
    grantId: GRANT_ID,
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: new Date().toISOString(),
    updatedAtIso: new Date().toISOString(),
    ...overrides,
  };
}

describe('composition: actionAuthorization.authorizeRelaunchApply (AR3a)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-cli-ar3a-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function runtime() {
    return createFleetCliRuntime({
      stateDir: tempDir,
      ownerPublicKey: ownerKey.ownerPublicKey,
    });
  }

  async function seed(record: CoordinationRequestRecord): Promise<void> {
    const fleet = runtime();
    await fleet.coordination.coordinationRequestRepository.saveRequest(record);
    const fields = approvedAnswerFields(record);
    writeSignedAnswer(tempDir, fields, ownerKey);
    await expectApprovedAnswerReadableThrough(fleet.coordination.decisionTransport, fields);
    return;
  }

  it('authorizes a signed approved relaunch-apply grant through the real resolve use case', async () => {
    await seed(relaunchRecord());
    const fleet = runtime();
    const result = await fleet.execution.actionAuthorization.authorizeRelaunchApply?.({
      planDigest: DIGEST,
      grantId: GRANT_ID,
      nowIso: new Date().toISOString(),
    });
    expect(result).toEqual({ outcome: 'authorized', grantId: GRANT_ID });
  });

  it('blocks with grant-expired when the grant is older than seven days', async () => {
    const stale = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await seed(relaunchRecord({ createdAtIso: stale, updatedAtIso: stale }));
    const fleet = runtime();
    const result = await fleet.execution.actionAuthorization.authorizeRelaunchApply?.({
      planDigest: DIGEST,
      grantId: GRANT_ID,
      nowIso: new Date().toISOString(),
    });
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-expired' });
  });

  it('blocks with grant-digest-mismatch when the plan digest differs from the recorded one', async () => {
    await seed(relaunchRecord());
    const fleet = runtime();
    const result = await fleet.execution.actionAuthorization.authorizeRelaunchApply?.({
      planDigest: 'b'.repeat(64),
      grantId: GRANT_ID,
      nowIso: new Date().toISOString(),
    });
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-digest-mismatch' });
  });

  it('blocks with grant-missing when no recorded grant carries the id', async () => {
    const fleet = runtime();
    const result = await fleet.execution.actionAuthorization.authorizeRelaunchApply?.({
      planDigest: DIGEST,
      grantId: 'grant-never-recorded',
      nowIso: new Date().toISOString(),
    });
    expect(result).toEqual({ outcome: 'blocked', reason: 'grant-missing' });
  });

  it('blocks with decision-signature-invalid when the pinned answer is missing', async () => {
    // The record is approved but no signed answer was written: the stored
    // state alone is never authority (KEY0c3).
    const fleet = runtime();
    await fleet.coordination.coordinationRequestRepository.saveRequest(relaunchRecord());
    const result = await fleet.execution.actionAuthorization.authorizeRelaunchApply?.({
      planDigest: DIGEST,
      grantId: GRANT_ID,
      nowIso: new Date().toISOString(),
    });
    expect(result).toEqual({ outcome: 'blocked', reason: 'decision-signature-invalid' });
  });

  it('blocks with invalid-request when the adapter is handed a malformed plan digest', async () => {
    const fleet = runtime();
    const result = await fleet.execution.actionAuthorization.authorizeRelaunchApply?.({
      planDigest: 'not-a-digest',
      grantId: GRANT_ID,
      nowIso: new Date().toISOString(),
    });
    expect(result).toEqual({ outcome: 'blocked', reason: 'invalid-request' });
  });
});
