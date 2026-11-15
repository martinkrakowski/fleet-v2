/**
 * CO14 follow-up, item 4.3: a release grant is bound to the root it names.
 * A grant resolved for root R authorizes only an operation on root R; any
 * other root is refused with `release-grant-root-mismatch`, nothing is built
 * and `current` is unmoved. The root is part of the grant's coordinates at
 * resolve time and compared again at consume time, so a grant cannot be moved
 * to another root after it was issued.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ManageReleaseUseCase,
  ReleaseStoreAdapter,
  type ActionAuthorizationPort,
  type CommandExecutorPort,
  type CommandRunOptions,
  type CommandRunResult,
  type ConductorDriverLeasePort,
} from '@fleet/work-execution';
import type { CoordinationRequestRecord } from '../../../../../operator-coordination/src/domain/coordination-records.js';
import { CoordinationRequestRepositoryAdapter } from '../../../../../operator-coordination/src/infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import { RecordAuthorizationConsumptionUseCase } from '../../../../../operator-coordination/src/application/use-cases/RecordAuthorizationConsumptionUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../../../../../operator-coordination/src/application/use-cases/ResolveActionAuthorizationUseCase.use-case.js';

const NOW = '2026-11-10T10:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

let dirs: string[] = [];

afterEach(async () => {
  const pending = dirs;
  dirs = [];
  await Promise.all(pending.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A lease port that never reads a live lease and lets any acquire/renew/release through. */
const freeLease: ConductorDriverLeasePort = {
  read: async () => null,
  acquire: async (request: { readonly holderId: string; readonly observedFence: number; readonly leaseUntilIso: string }) => ({
    outcome: 'ok',
    lease: { holderId: request.holderId, fence: request.observedFence + 1, leaseUntilIso: request.leaseUntilIso },
  }),
  renew: async (request: { readonly holderId: string; readonly fence: number; readonly leaseUntilIso: string }) => ({
    outcome: 'ok',
    lease: { holderId: request.holderId, fence: request.fence, leaseUntilIso: request.leaseUntilIso },
  }),
  release: async (request: { readonly holderId: string; readonly fence: number; readonly nowIso: string }) => ({
    outcome: 'ok',
    lease: { holderId: request.holderId, fence: request.fence, leaseUntilIso: request.nowIso },
  }),
} as unknown as ConductorDriverLeasePort;

/** A build executor that never runs: the suites below must never reach a build. */
class NoBuildExecutor implements CommandExecutorPort {
  readonly ran = false;
  async run(_argv: readonly string[], _options?: CommandRunOptions): Promise<CommandRunResult> {
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  }
}

/** A recorded, approved owner grant for `release:install` at SHA_A, bound to `root`. */
function grantFor(root: string): CoordinationRequestRecord {
  return {
    id: 'req-owner',
    projectId: 'p',
    kind: 'action-decision',
    state: 'approved',
    actionScope: 'release:install',
    expectedHeadSha: SHA_A,
    proposalDigest: 'prop-1',
    policyRevision: 'pol-1',
    decisionRevision: 'dec-1',
    grantId: 'grant-owner',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: NOW,
    updatedAtIso: NOW,
    releaseRoot: root,
  } as CoordinationRequestRecord;
}

function releaseUseCase(grants: CoordinationRequestRepositoryAdapter): ManageReleaseUseCase {
  const authorization: ActionAuthorizationPort = {
    resolveActionAuthorization: async (request) => {
      const result = await new ResolveActionAuthorizationUseCase({ requestRepo: grants }).resolveActionAuthorization({
        projectId: request.projectId,
        actionScope: 'release:install',
        expectedHeadSha: request.expectedHeadSha,
        releaseRoot: request.releaseRoot,
      });
      return result.outcome === 'authorized'
        ? {
            outcome: 'granted',
            authorizationGrantId: result.grantId,
            ...(result.releaseRoot !== undefined ? { releaseRoot: result.releaseRoot } : {}),
          }
        : { outcome: 'blocked', reason: result.reason };
    },
    consumeActionAuthorization: async (request) => {
      const result = await new RecordAuthorizationConsumptionUseCase({ requestRepo: grants }).recordAuthorizationConsumption({
        consumptionId: `c-${request.actionId}`,
        grantId: request.authorizationGrantId,
        actionId: request.actionId,
        actionScope: 'release:install',
        attemptId: request.attemptId ?? request.actionId,
        expectedHeadSha: request.expectedHeadSha ?? SHA_A,
        releaseRoot: request.releaseRoot,
      });
      return result.outcome === 'consumed'
        ? { outcome: 'consumed', actionId: request.actionId }
        : { outcome: 'refused', reason: result.reason };
    },
  };
  return new ManageReleaseUseCase({
    store: new ReleaseStoreAdapter(),
    lease: freeLease,
    authorization,
    executor: new NoBuildExecutor(),
    nowIso: () => NOW,
    env: () => ({}),
  });
}

describe('release grant root binding (CO14 follow-up)', () => {
  let grants: CoordinationRequestRepositoryAdapter;
  let rootA: string;
  let rootB: string;

  beforeEach(async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'co14b-grant-'));
    dirs.push(stateDir);
    grants = new CoordinationRequestRepositoryAdapter({ stateDir });
    rootA = await mkdtemp(join(tmpdir(), 'co14b-root-a-'));
    rootB = await mkdtemp(join(tmpdir(), 'co14b-root-b-'));
    dirs.push(rootA, rootB);
  });

  it('a grant for one root cannot authorize another root', async () => {
    await grants.saveRequest(grantFor(rootA));
    const result = await releaseUseCase(grants).manageRelease({
      action: 'install',
      root: rootB,
      sha: SHA_A,
      source: rootB,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(result).toEqual({ outcome: 'refused', reason: 'release-grant-root-mismatch' });
    // Nothing built, current unmoved, grant not consumed.
    expect((await new ReleaseStoreAdapter().list({ root: rootB })).outcome).toBe('read');
    expect(await new ReleaseStoreAdapter().list({ root: rootB })).toMatchObject({ builds: [] });
    expect((await grants.findRequestByGrantId('grant-owner'))?.consumptions).toHaveLength(0);
  });

  it('a grant for the root it names authorizes that root, once', async () => {
    await grants.saveRequest(grantFor(rootA));
    // The target build already exists, so no build runs and the grant is
    // consumed by the repoint alone.
    const store = new ReleaseStoreAdapter();
    const staging = await store.prepare({ root: rootA, sha: SHA_A });
    expect(staging.outcome).toBe('prepared');
    if (staging.outcome !== 'prepared') return;
    const entry = join(staging.buildDir, 'apps', 'cli', 'dist');
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, 'bin.js'), '// built\n');
    const built = await store.markVerified({ root: rootA, sha: SHA_A, buildId: staging.buildId, builtAtIso: NOW });
    expect(built.outcome).toBe('ok');
    const result = await releaseUseCase(grants).manageRelease({
      action: 'install',
      root: rootA,
      sha: SHA_A,
      source: rootA,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(result.outcome).toBe('applied');
    expect((await grants.findRequestByGrantId('grant-owner'))?.consumptions).toHaveLength(1);
    expect(await store.list({ root: rootA })).toMatchObject({ outcome: 'read', current: SHA_A });
  });

  it('a consumed grant does not authorize a second release', async () => {
    await grants.saveRequest(grantFor(rootA));
    const store = new ReleaseStoreAdapter();
    for (const sha of [SHA_A, SHA_B]) {
      const staging = await store.prepare({ root: rootA, sha });
      if (staging.outcome !== 'prepared') throw new Error('prepare failed');
      const entry = join(staging.buildDir, 'apps', 'cli', 'dist');
      await mkdir(entry, { recursive: true });
      await writeFile(join(entry, 'bin.js'), '// built\n');
      const built = await store.markVerified({ root: rootA, sha, buildId: staging.buildId, builtAtIso: NOW });
      if (built.outcome !== 'ok') throw new Error('mark failed');
    }
    const useCase = releaseUseCase(grants);
    const first = await useCase.manageRelease({
      action: 'install',
      root: rootA,
      sha: SHA_A,
      source: rootA,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(first.outcome).toBe('applied');
    const second = await useCase.manageRelease({
      action: 'install',
      root: rootA,
      sha: SHA_A,
      source: rootA,
      keep: 5,
      apply: true,
      projectId: 'p',
    });
    expect(second).toEqual({ outcome: 'refused', reason: 'authority-refused' });
    expect((await grants.findRequestByGrantId('grant-owner'))?.consumptions).toHaveLength(1);
  });
});
