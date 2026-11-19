/**
 * CO24e: a grant records the attempt it is bound to, and consumption refuses any other.
 * Everything runs over the real CoordinationRequestRepositoryAdapter persisting to a
 * temp directory, so a stored grant is written to and read back from disk.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GRANT_RECORD_VERSION } from '../../../domain/coordination-records.js';
import type { CoordinationRequestRecord } from '../../../domain/coordination-records.js';
import { CoordinationRequest } from '../../../domain/entities/CoordinationRequest.js';
import { CoordinationRequestRepositoryAdapter } from '../../../infrastructure/adapters/CoordinationRequestRepositoryAdapter.adapter.js';
import { DecisionTransportAdapter } from '../../../infrastructure/adapters/DecisionTransportAdapter.adapter.js';
import { IssuePolicyForgeGrantUseCase } from '../IssuePolicyForgeGrantUseCase.use-case.js';
import { RecordAuthorizationConsumptionUseCase } from '../RecordAuthorizationConsumptionUseCase.use-case.js';
import { RequestScopedDecisionUseCase } from '../RequestScopedDecisionUseCase.use-case.js';
import { ResolveActionAuthorizationUseCase } from '../ResolveActionAuthorizationUseCase.use-case.js';
import type { AttemptFactsRecord } from '../../ports/out/AttemptFactsReadPort.out-port.js';
import { createSignedDecisionFixture } from './signed-decision-fixture.js';

const HEAD = 'c'.repeat(40);
const SCOPE = 'forge:push-and-open-pr';

/** In-memory attempt-facts reader: whatever facts the test records, null for unknown attempts. */
class FakeAttemptFactsRead {
  private readonly facts: Map<string, AttemptFactsRecord>;
  constructor(entries: readonly AttemptFactsRecord[]) {
    this.facts = new Map(entries.map((entry) => [entry.attemptId, entry]));
  }
  findAttemptFactsById(attemptId: string): Promise<AttemptFactsRecord | null> {
    return Promise.resolve(this.facts.get(attemptId) ?? null);
  }
}

const attemptFacts = (...entries: readonly AttemptFactsRecord[]) => new FakeAttemptFactsRead(entries);

function ownerGrant(overrides: Record<string, unknown> = {}): CoordinationRequestRecord {
  return {
    id: 'req-owner',
    projectId: 'project-1',
    kind: 'action-decision',
    state: 'approved',
    actionScope: SCOPE,
    expectedHeadSha: HEAD,
    proposalDigest: 'prop-1',
    policyRevision: 'pol-1',
    decisionRevision: 'dec-1',
    grantId: 'grant-owner',
    consumptions: [],
    acknowledgements: [],
    deliveryStatus: 'delivered',
    deliveryGapReason: null,
    revision: 1,
    createdAtIso: '2026-11-06T10:00:00.000Z',
    updatedAtIso: '2026-11-06T10:00:00.000Z',
    ...overrides,
  } as CoordinationRequestRecord;
}

function consume(grantId: string, attemptId: string, actionId = 'action-1') {
  return {
    consumptionId: `c-${actionId}`,
    grantId,
    actionId,
    actionScope: SCOPE,
    attemptId,
    expectedHeadSha: HEAD,
  };
}

describe('grant attempt binding (CO24e)', () => {
  let dir: string;
  let repo: CoordinationRequestRepositoryAdapter;
  let signer: ReturnType<typeof createSignedDecisionFixture>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'co24e-oc-'));
    repo = new CoordinationRequestRepositoryAdapter({ stateDir: dir });
    // KEY0c1a: the seeded owner grants are paired with Ed25519-signed answers
    // recorded under an ephemeral test signer's key, next to the state dir.
    signer = createSignedDecisionFixture({ decisionsDir: join(dir, 'decisions') });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const consumer = () => new RecordAuthorizationConsumptionUseCase({ requestRepo: repo, ...signer.deps });
  const resolver = (facts = attemptFacts({ attemptId: 'att-A', projectId: 'project-1', collectedHeadSha: HEAD }, { attemptId: 'att-B', projectId: 'project-1', collectedHeadSha: HEAD })) =>
    new ResolveActionAuthorizationUseCase({ requestRepo: repo, ...signer.deps, attemptFactsRead: facts });

  describe('the stored record', () => {
    it('round-trips a version-2 owner grant with its attempt through the file', async () => {
      await repo.saveRequest(ownerGrant({ grantRecordVersion: 2, grantAttemptId: 'att-A' }));
      const reloaded = await new CoordinationRequestRepositoryAdapter({ stateDir: dir }).findRequestByGrantId('grant-owner');
      expect(reloaded?.grantRecordVersion).toBe(GRANT_RECORD_VERSION);
      expect(reloaded?.grantAttemptId).toBe('att-A');
    });

    it('still loads a legacy grant that has neither field, and rewrites it unchanged', async () => {
      await writeFile(join(dir, 'coordination-requests.json'), JSON.stringify([ownerGrant()]));
      const loaded = await repo.findRequestByGrantId('grant-owner');
      expect(loaded).not.toBeNull();
      expect(loaded).not.toHaveProperty('grantAttemptId');
      expect(loaded).not.toHaveProperty('grantRecordVersion');
      await repo.saveRequest({ ...ownerGrant(), revision: 2 });
      const text = await readFile(join(dir, 'coordination-requests.json'), 'utf8');
      expect(text).not.toContain('grantAttemptId');
    });

    it.each([
      ['an unknown version', { grantRecordVersion: 3, grantAttemptId: 'att-A' }],
      ['version 1', { grantRecordVersion: 1 }],
      ['a string version', { grantRecordVersion: '2', grantAttemptId: 'att-A' }],
      ['a numeric attempt', { grantRecordVersion: 2, grantAttemptId: 42 }],
      ['a null attempt', { grantRecordVersion: 2, grantAttemptId: null }],
      ['a blank attempt', { grantRecordVersion: 2, grantAttemptId: '  ' }],
      ['a control character in the attempt', { grantRecordVersion: 2, grantAttemptId: 'att\u0001A' }],
      ['a bidi character in the attempt', { grantRecordVersion: 2, grantAttemptId: 'att\u202EA' }],
      ['an over-long attempt', { grantRecordVersion: 2, grantAttemptId: 'a'.repeat(257) }],
      ['an attempt without a version', { grantAttemptId: 'att-A' }],
    ])('reads %s as unreadable, never as "no attempt"', async (_label, fields) => {
      expect(() => CoordinationRequest.fromRecord(ownerGrant(fields))).toThrow();
      await writeFile(join(dir, 'coordination-requests.json'), JSON.stringify([ownerGrant(fields)]));
      await expect(repo.findRequestByGrantId('grant-owner')).rejects.toThrow();
    });

    it('refuses a record whose attempt differs from its policy grant attempt', () => {
      expect(() =>
        CoordinationRequest.fromRecord(
          ownerGrant({
            actionScope: 'forge:merge-pr',
            decisionRevision: 'policy:autoMerge@309ab8c40bf2',
            policyGrant: { workOrderId: 'wo-1', attemptId: 'att-A', acceptanceReceiptId: 'r-1' },
            grantRecordVersion: 2,
            grantAttemptId: 'att-B',
          }),
        ),
      ).toThrow();
    });
  });

  describe('recording an owner decision and issuing a policy grant', () => {
    it('records the attempt on an owner decision requested with one', async () => {
      const result = await new RequestScopedDecisionUseCase({ requestRepo: repo }).requestScopedDecision({
        requestId: 'req-new',
        projectId: 'project-1',
        kind: 'action-decision',
        actionScope: SCOPE,
        expectedHeadSha: HEAD,
        proposalDigest: 'prop',
        policyRevision: 'pol-1',
        attemptId: 'att-A',
      });
      expect(result.outcome).toBe('requested');
      const stored = await repo.findRequestById('req-new');
      expect(stored?.grantRecordVersion).toBe(2);
      expect(stored?.grantAttemptId).toBe('att-A');
    });

    it('refuses a forge action decision requested without an attempt (CO24f)', async () => {
      const result = await new RequestScopedDecisionUseCase({ requestRepo: repo }).requestScopedDecision({
        requestId: 'req-new',
        projectId: 'project-1',
        kind: 'action-decision',
        actionScope: SCOPE,
        expectedHeadSha: HEAD,
        proposalDigest: 'prop',
        policyRevision: 'pol-1',
      });
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'a forge action decision requires an attemptId',
      });
      expect(await repo.findRequestById('req-new')).toBeNull();
    });

    it('still records a non-forge decision without an attempt', async () => {
      const result = await new RequestScopedDecisionUseCase({ requestRepo: repo }).requestScopedDecision({
        requestId: 'req-new',
        projectId: 'project-1',
        kind: 'action-decision',
        actionScope: 'deploy:staging',
        expectedHeadSha: HEAD,
        proposalDigest: 'prop',
        policyRevision: 'pol-1',
      });
      expect(result.outcome).toBe('requested');
      expect(await repo.findRequestById('req-new')).not.toHaveProperty('grantAttemptId');
    });

    it('rejects a blank or wrong-typed attempt on a decision request', async () => {
      const useCase = new RequestScopedDecisionUseCase({ requestRepo: repo });
      for (const attemptId of ['  ', 7 as unknown as string]) {
        const result = await useCase.requestScopedDecision({
          requestId: 'req-bad',
          projectId: 'project-1',
          kind: 'action-decision',
          actionScope: SCOPE,
          expectedHeadSha: HEAD,
          proposalDigest: 'prop',
          policyRevision: 'pol-1',
          attemptId,
        });
        expect(result.outcome).toBe('rejected');
      }
      expect(await repo.findRequestById('req-bad')).toBeNull();
    });

    it('rejects an attempt carrying a control or bidi character, recording nothing (CO24f)', async () => {
      const useCase = new RequestScopedDecisionUseCase({ requestRepo: repo });
      for (const attemptId of ['att\u0001A', 'att\u202EA', 'att\u200FA', 'att\ufeffA']) {
        const result = await useCase.requestScopedDecision({
          requestId: 'req-bad',
          projectId: 'project-1',
          kind: 'action-decision',
          actionScope: SCOPE,
          expectedHeadSha: HEAD,
          proposalDigest: 'prop',
          policyRevision: 'pol-1',
          attemptId,
        });
        expect(result).toEqual({
          outcome: 'rejected',
          reason: 'a decision request attemptId must not contain control or bidi characters',
        });
      }
      expect(await repo.findRequestById('req-bad')).toBeNull();
    });

    it('rejects an attempt longer than the record builder allows, recording nothing (CO24f)', async () => {
      const result = await new RequestScopedDecisionUseCase({ requestRepo: repo }).requestScopedDecision({
        requestId: 'req-bad',
        projectId: 'project-1',
        kind: 'action-decision',
        actionScope: SCOPE,
        expectedHeadSha: HEAD,
        proposalDigest: 'prop',
        policyRevision: 'pol-1',
        attemptId: 'a'.repeat(257),
      });
      expect(result).toEqual({
        outcome: 'rejected',
        reason: 'a decision request attemptId must be at most 256 characters',
      });
      expect(await repo.findRequestById('req-bad')).toBeNull();
    });

    it('records the attempt on a policy grant at issue', async () => {
      let n = 0;
      const issued = await new IssuePolicyForgeGrantUseCase({
        requestRepo: repo,
        clock: { nowIso: () => '2026-11-06T10:00:00.000Z' },
        ids: { newRequestId: () => `req-p-${++n}`, newGrantId: () => `grant-p-${n}` },
      }).issuePolicyForgeGrant({
        projectId: 'project-1',
        workOrderId: 'wo-1',
        attemptId: 'att-A',
        forgeKind: 'merge-pr',
        expectedHeadSha: HEAD,
        policyRevision: 'pol-1',
        acceptanceReceiptId: 'receipt-1',
        source: 'autoMerge',
        settingRevision: '309ab8c40bf2',
      });
      expect(issued.outcome).toBe('issued');
      const stored = await repo.findRequestByGrantId('grant-p-1');
      expect(stored?.grantRecordVersion).toBe(2);
      expect(stored?.grantAttemptId).toBe('att-A');
      expect(stored?.policyGrant?.attemptId).toBe('att-A');
    });
  });

  describe('resolving binds the first attempt', () => {
    const resolveFor = (attemptId?: string) => ({
      projectId: 'project-1',
      actionScope: SCOPE,
      expectedHeadSha: HEAD,
      ...(attemptId !== undefined ? { attemptId } : {}),
    });

    it('binds an unbound owner grant to the attempt that resolves it, durably', async () => {
      await repo.saveRequest(ownerGrant());
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      expect((await resolver().resolveActionAuthorization(resolveFor('att-A'))).outcome).toBe('authorized');
      const stored = await new CoordinationRequestRepositoryAdapter({ stateDir: dir }).findRequestByGrantId('grant-owner');
      expect(stored?.grantAttemptId).toBe('att-A');
      expect(stored?.grantRecordVersion).toBe(2);
      expect(stored?.revision).toBe(2);
    });

    it('blocks a later resolve for another attempt and leaves the binding unchanged', async () => {
      await repo.saveRequest(ownerGrant());
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      await resolver().resolveActionAuthorization(resolveFor('att-A'));
      expect(await resolver().resolveActionAuthorization(resolveFor('att-B'))).toEqual({
        outcome: 'blocked',
        reason: 'grant-attempt-mismatch',
      });
      expect((await repo.findRequestByGrantId('grant-owner'))?.grantAttemptId).toBe('att-A');
      expect((await resolver().resolveActionAuthorization(resolveFor('att-A'))).outcome).toBe('authorized');
    });

    it('refuses an unbound owner grant resolved without an attempt: no bind, no consume, grant survives (CO24g)', async () => {
      await repo.saveRequest(ownerGrant());
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      expect(await resolver().resolveActionAuthorization(resolveFor())).toEqual({
        outcome: 'blocked',
        reason: 'attempt-required',
      });
      const stored = await repo.findRequestByGrantId('grant-owner');
      expect(stored).not.toHaveProperty('grantAttemptId');
      expect(stored?.consumptions).toHaveLength(0);
      expect(stored?.revision).toBe(1);
      // The same grant still binds when resolved with the right attempt.
      expect((await resolver().resolveActionAuthorization(resolveFor('att-A'))).outcome).toBe('authorized');
      expect((await repo.findRequestByGrantId('grant-owner'))?.grantAttemptId).toBe('att-A');
    });

    it('refuses an already-bound owner grant resolved without an attempt too (CO24g)', async () => {
      const boundGrant = ownerGrant({ grantRecordVersion: 2, grantAttemptId: 'att-A' });
      await repo.saveRequest(boundGrant);
      await signer.writeApprovedAnswer(boundGrant);
      await signer.assertApprovedAnswerReadsBackApproved(boundGrant);
      expect(await resolver().resolveActionAuthorization(resolveFor())).toEqual({
        outcome: 'blocked',
        reason: 'attempt-required',
      });
      const stored = await repo.findRequestByGrantId('grant-owner');
      expect(stored?.grantAttemptId).toBe('att-A');
      expect(stored?.consumptions).toHaveLength(0);
    });

    it('resolves a policy grant by its id without an attempt, unaffected (CO24g)', async () => {
      await repo.saveRequest(
        ownerGrant({
          actionScope: 'forge:merge-pr',
          decisionRevision: 'policy:autoMerge@309ab8c40bf2',
          policyGrant: { workOrderId: 'wo-1', attemptId: 'att-A', acceptanceReceiptId: 'r-1' },
        }),
      );
      const result = await resolver().resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: 'forge:merge-pr',
        expectedHeadSha: HEAD,
        authorizationGrantId: 'grant-owner',
      });
      expect(result.outcome).toBe('authorized');
    });

    it('blocks a blank attempt and a version-2 grant that records none', async () => {
      await repo.saveRequest(ownerGrant());
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      expect(await resolver().resolveActionAuthorization(resolveFor('  '))).toEqual({
        outcome: 'blocked',
        reason: 'grant-attempt-invalid',
      });
      const unrecorded = ownerGrant({ revision: 2, grantRecordVersion: 2 });
      await repo.saveRequest(unrecorded);
      await signer.writeApprovedAnswer(unrecorded);
      await signer.assertApprovedAnswerReadsBackApproved(unrecorded);
      expect(await resolver().resolveActionAuthorization(resolveFor('att-A'))).toEqual({
        outcome: 'blocked',
        reason: 'grant-attempt-unrecorded',
      });
    });

    it('does not bind an attempt-less merge grant', async () => {
      await repo.saveRequest(
        ownerGrant({
          actionScope: 'forge:merge-pr',
          decisionRevision: 'policy:merge@309ab8c40bf2',
          mergeGrant: { repository: { owner: 'org', repo: 'repo' }, pullRequestNumber: 5 },
        }),
      );
      const result = await resolver().resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: 'forge:merge-pr',
        expectedHeadSha: HEAD,
        attemptId: 'att-A',
        authorizationGrantId: 'grant-owner',
        repository: { owner: 'org', repo: 'repo' },
        pullRequestNumber: 5,
      });
      expect(result.outcome).toBe('authorized');
      expect(await repo.findRequestByGrantId('grant-owner')).not.toHaveProperty('grantAttemptId');
    });

    it('refuses an unknown attempt without binding, and the legitimate resolve then binds (CO24f)', async () => {
      await repo.saveRequest(ownerGrant());
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      expect(await resolver().resolveActionAuthorization(resolveFor('nope'))).toEqual({
        outcome: 'blocked',
        reason: 'grant-attempt-unknown',
      });
      const unbound = await repo.findRequestByGrantId('grant-owner');
      expect(unbound).not.toHaveProperty('grantAttemptId');
      expect(unbound?.revision).toBe(1);
      expect((await resolver().resolveActionAuthorization(resolveFor('att-A'))).outcome).toBe('authorized');
      expect((await repo.findRequestByGrantId('grant-owner'))?.grantAttemptId).toBe('att-A');
    });

    it('refuses a foreign attempt and an attempt not collected at the expected head (CO24f)', async () => {
      await repo.saveRequest(ownerGrant());
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      const foreignFacts = attemptFacts({ attemptId: 'att-A', projectId: 'project-2', collectedHeadSha: HEAD });
      expect(await resolver(foreignFacts).resolveActionAuthorization(resolveFor('att-A'))).toEqual({
        outcome: 'blocked',
        reason: 'grant-attempt-foreign',
      });
      const uncollectedFacts = attemptFacts({ attemptId: 'att-A', projectId: 'project-1', collectedHeadSha: null });
      expect(await resolver(uncollectedFacts).resolveActionAuthorization(resolveFor('att-A'))).toEqual({
        outcome: 'blocked',
        reason: 'grant-attempt-uncollected',
      });
      const otherHeadFacts = attemptFacts({
        attemptId: 'att-A',
        projectId: 'project-1',
        collectedHeadSha: 'd'.repeat(40),
      });
      expect(await resolver(otherHeadFacts).resolveActionAuthorization(resolveFor('att-A'))).toEqual({
        outcome: 'blocked',
        reason: 'grant-attempt-head-mismatch',
      });
      expect(await repo.findRequestByGrantId('grant-owner')).not.toHaveProperty('grantAttemptId');
    });

    it('binds nothing when the attempt-facts port is not configured (CO24f fail-closed)', async () => {
      await repo.saveRequest(ownerGrant());
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      const result = await new ResolveActionAuthorizationUseCase({
        requestRepo: repo,
        ...signer.deps,
      }).resolveActionAuthorization(
        resolveFor('att-A'),
      );
      expect(result.outcome).toBe('blocked');
      expect(await repo.findRequestByGrantId('grant-owner')).not.toHaveProperty('grantAttemptId');
    });

    it('binds exactly one of two concurrent first resolves; the other sees the grant moved (CO24f)', async () => {
      await repo.saveRequest(ownerGrant());
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      // Two resolves racing to bind different attempts: both read the same
      // unbound revision, so exactly one write lands and the other loses the
      // same-revision race and is refused as moved-while-binding.
      const results = await Promise.all([
        resolver().resolveActionAuthorization(resolveFor('att-A')),
        resolver().resolveActionAuthorization(resolveFor('att-B')),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual(['authorized', 'blocked']);
      const blocked = results.find((result) => result.outcome === 'blocked');
      expect(blocked?.reason).toBe('grant grant-owner moved while it was being bound to an attempt');
      const stored = await new CoordinationRequestRepositoryAdapter({ stateDir: dir }).findRequestByGrantId('grant-owner');
      expect(stored?.revision).toBe(2);
      expect(['att-A', 'att-B']).toContain(stored?.grantAttemptId);
    });
  });

  describe('release grants are attempt-less by design (CO24g)', () => {
    const RELEASE_SCOPE = 'release:install';
    const ACTION_ID = `release-install-${HEAD}`;
    // RR1: a release grant's root is bound into its request id, so every
    // seeded release record here carries a root and a digest-bound id, and
    // the resolver/consumer are wired with the same digest.
    const RELEASE_ROOT = '/srv/fleet/releases';
    const RELEASE_NONCE = '0123456789abcdef0123456789abcdef';

    const digest = (payload: string) => createHash('sha256').update(payload).digest('hex');

    const releaseGrantId = (grant: { actionScope: string; projectId?: string; expectedHeadSha?: string; releaseRoot?: string }): string =>
      `release-grant-${digest(
        JSON.stringify({
          scope: grant.actionScope,
          projectId: grant.projectId ?? 'project-1',
          expectedHeadSha: grant.expectedHeadSha ?? HEAD,
          releaseRoot: grant.releaseRoot ?? RELEASE_ROOT,
          nonce: RELEASE_NONCE,
        }),
      )}`;

    const releaseGrant = (overrides: Record<string, unknown> = {}) => {
      const grant = { actionScope: RELEASE_SCOPE, ...overrides };
      // Only the three exact release scopes are digest-bound release grants
      // (RR1); an unknown `release:*` scope stays an ordinary owner grant
      // with no root, and a forge scope stays untouched.
      const isExactReleaseScope = ['release:install', 'release:swap', 'release:rollback'].includes(
        grant.actionScope as string,
      );
      return ownerGrant({
        ...(isExactReleaseScope ? { id: releaseGrantId(grant), releaseRoot: RELEASE_ROOT, releaseNonce: RELEASE_NONCE } : {}),
        actionScope: grant.actionScope,
        ...overrides,
      });
    };
    const resolveRelease = (attemptId?: string) => ({
      projectId: 'project-1',
      actionScope: RELEASE_SCOPE,
      expectedHeadSha: HEAD,
      releaseRoot: RELEASE_ROOT,
      ...(attemptId !== undefined ? { attemptId } : {}),
    });
    const releaseResolver = (facts = attemptFacts({ attemptId: 'att-A', projectId: 'project-1', collectedHeadSha: HEAD }, { attemptId: 'att-B', projectId: 'project-1', collectedHeadSha: HEAD })) =>
      new ResolveActionAuthorizationUseCase({ requestRepo: repo, ...signer.deps, attemptFactsRead: facts, computeDigest: digest });
    const releaseConsumer = () => new RecordAuthorizationConsumptionUseCase({ requestRepo: repo, ...signer.deps, computeDigest: digest });

    it('resolves a fresh release owner grant without an attempt, binding and consuming nothing', async () => {
      await repo.saveRequest(releaseGrant());
      await signer.writeApprovedAnswer(releaseGrant());
      await signer.assertApprovedAnswerReadsBackApproved(releaseGrant());
      expect(await releaseResolver().resolveActionAuthorization(resolveRelease())).toEqual({
        outcome: 'authorized',
        grantId: 'grant-owner',
        requestId: releaseGrant().id,
        expectedHeadSha: HEAD,
        policyRevision: 'pol-1',
        releaseRoot: RELEASE_ROOT,
      });
      const stored = await repo.findRequestByGrantId('grant-owner');
      expect(stored?.grantAttemptId).toBeUndefined();
      expect(stored?.consumptions).toHaveLength(0);
      expect(stored?.revision).toBe(1);
    });

    it('resolves the same grant with its deterministic action id and still never binds', async () => {
      await repo.saveRequest(releaseGrant());
      await signer.writeApprovedAnswer(releaseGrant());
      await signer.assertApprovedAnswerReadsBackApproved(releaseGrant());
      expect((await releaseResolver().resolveActionAuthorization(resolveRelease(ACTION_ID))).outcome).toBe('authorized');
      const stored = await repo.findRequestByGrantId('grant-owner');
      expect(stored?.grantAttemptId).toBeUndefined();
      expect(stored?.revision).toBe(1);
    });

    it('still refuses a release grant at another head or scope', async () => {
      await repo.saveRequest(releaseGrant());
      await signer.writeApprovedAnswer(releaseGrant());
      await signer.assertApprovedAnswerReadsBackApproved(releaseGrant());
      expect(
        await releaseResolver().resolveActionAuthorization({ ...resolveRelease(), expectedHeadSha: 'd'.repeat(40) }),
      ).toMatchObject({ outcome: 'blocked' });
      expect(
        await releaseResolver().resolveActionAuthorization({ ...resolveRelease(ACTION_ID), actionScope: 'release:swap' }),
      ).toMatchObject({ outcome: 'blocked' });
      expect((await repo.findRequestByGrantId('grant-owner'))?.consumptions).toHaveLength(0);
    });

    it('does not exempt an unknown release:* scope from the attempt-required default', async () => {
      const UNKNOWN_RELEASE_SCOPE = 'release:promote';
      const unknownScopeGrant = releaseGrant({ actionScope: UNKNOWN_RELEASE_SCOPE });
      await repo.saveRequest(unknownScopeGrant);
      await signer.writeApprovedAnswer(unknownScopeGrant);
      await signer.assertApprovedAnswerReadsBackApproved(unknownScopeGrant);
      expect(
        await resolver().resolveActionAuthorization({
          projectId: 'project-1',
          actionScope: UNKNOWN_RELEASE_SCOPE,
          expectedHeadSha: HEAD,
        }),
      ).toEqual({ outcome: 'blocked', reason: 'attempt-required' });
      const stored = await repo.findRequestByGrantId('grant-owner');
      expect(stored).not.toHaveProperty('grantAttemptId');
      expect(stored?.consumptions).toHaveLength(0);
      expect(stored?.revision).toBe(1);
    });

    it('does not exempt an unknown release:* scope from the recorded-attempt consumption check', async () => {
      const UNKNOWN_RELEASE_SCOPE = 'release:promote';
      const unknownScopeGrant = releaseGrant({ actionScope: UNKNOWN_RELEASE_SCOPE, grantRecordVersion: 2 });
      await repo.saveRequest(unknownScopeGrant);
      await signer.writeApprovedAnswer(unknownScopeGrant);
      await signer.assertApprovedAnswerReadsBackApproved(unknownScopeGrant);
      expect(
        await consumer().recordAuthorizationConsumption({
          consumptionId: `c-${ACTION_ID}`,
          grantId: 'grant-owner',
          actionId: ACTION_ID,
          actionScope: UNKNOWN_RELEASE_SCOPE,
          attemptId: ACTION_ID,
          expectedHeadSha: HEAD,
        }),
      ).toEqual({ outcome: 'refused', reason: 'grant-attempt-unrecorded' });
      expect((await repo.findRequestByGrantId('grant-owner'))?.consumptions).toHaveLength(0);
    });

    it('consumes a release grant once for its deterministic action id', async () => {
      const grant = releaseGrant();
      await repo.saveRequest(grant);
      await signer.writeApprovedAnswer(grant);
      await signer.assertApprovedAnswerReadsBackApproved(grant);
      const result = await releaseConsumer().recordAuthorizationConsumption({
        ...consume('grant-owner', ACTION_ID),
        actionScope: RELEASE_SCOPE,
        releaseRoot: RELEASE_ROOT,
      });
      expect(result.outcome).toBe('consumed');
      const stored = await repo.findRequestByGrantId('grant-owner');
      expect(stored?.consumptions[0]?.attemptId).toBe(ACTION_ID);
      expect(stored?.state).toBe('completed');
    });

    it('keeps refusing a version-2 forge owner grant that records no attempt at consumption', async () => {
      const forgeGrant = releaseGrant({ actionScope: SCOPE, grantRecordVersion: 2 });
      await repo.saveRequest(forgeGrant);
      await signer.writeApprovedAnswer(forgeGrant);
      await signer.assertApprovedAnswerReadsBackApproved(forgeGrant);
      expect(
        await consumer().recordAuthorizationConsumption({ ...consume('grant-owner', ACTION_ID) }),
      ).toEqual({ outcome: 'refused', reason: 'grant-attempt-unrecorded' });
      expect((await repo.findRequestByGrantId('grant-owner'))?.consumptions).toHaveLength(0);
    });

    it('refuses a release:swap grant bound to attempt A when resolved with attempt B', async () => {
      const boundGrant = releaseGrant({ actionScope: 'release:swap', grantRecordVersion: 2, grantAttemptId: 'att-A' });
      await repo.saveRequest(boundGrant);
      await signer.writeApprovedAnswer(boundGrant);
      await signer.assertApprovedAnswerReadsBackApproved(boundGrant);
      expect(await releaseResolver().resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: 'release:swap',
        expectedHeadSha: HEAD,
        releaseRoot: RELEASE_ROOT,
        attemptId: 'att-B',
      })).toEqual({ outcome: 'blocked', reason: 'grant-attempt-mismatch' });
    });

    it('refuses a release:swap grant bound to attempt A when resolved with no attempt', async () => {
      const boundGrant = releaseGrant({ actionScope: 'release:swap', grantRecordVersion: 2, grantAttemptId: 'att-A' });
      await repo.saveRequest(boundGrant);
      await signer.writeApprovedAnswer(boundGrant);
      await signer.assertApprovedAnswerReadsBackApproved(boundGrant);
      expect(await releaseResolver().resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: 'release:swap',
        expectedHeadSha: HEAD,
        releaseRoot: RELEASE_ROOT,
      })).toEqual({ outcome: 'blocked', reason: 'attempt-required' });
    });

    it('authorizes a release:swap grant bound to attempt A when resolved with attempt A', async () => {
      const boundGrant = releaseGrant({ actionScope: 'release:swap', grantRecordVersion: 2, grantAttemptId: 'att-A' });
      await repo.saveRequest(boundGrant);
      await signer.writeApprovedAnswer(boundGrant);
      await signer.assertApprovedAnswerReadsBackApproved(boundGrant);
      expect(await releaseResolver().resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: 'release:swap',
        expectedHeadSha: HEAD,
        releaseRoot: RELEASE_ROOT,
        attemptId: 'att-A',
      })).toEqual({
        outcome: 'authorized',
        grantId: 'grant-owner',
        requestId: releaseGrant({ actionScope: 'release:swap' }).id,
        expectedHeadSha: HEAD,
        policyRevision: 'pol-1',
        releaseRoot: RELEASE_ROOT,
      });
    });

    it('resolves an unbound release:swap grant without an attempt', async () => {
      const unboundGrant = releaseGrant({ actionScope: 'release:swap' });
      await repo.saveRequest(unboundGrant);
      await signer.writeApprovedAnswer(unboundGrant);
      await signer.assertApprovedAnswerReadsBackApproved(unboundGrant);
      expect(await releaseResolver().resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: 'release:swap',
        expectedHeadSha: HEAD,
        releaseRoot: RELEASE_ROOT,
      })).toEqual({
        outcome: 'authorized',
        grantId: 'grant-owner',
        requestId: releaseGrant({ actionScope: 'release:swap' }).id,
        expectedHeadSha: HEAD,
        policyRevision: 'pol-1',
        releaseRoot: RELEASE_ROOT,
      });
    });
  });

  describe('signed decision fixtures fail closed (KEY0c1a)', () => {
    const resolveAwaiting = async () => {
      await mkdir(join(dir, 'decisions'), { recursive: true });
      const awaiting: CoordinationRequestRecord = {
        ...ownerGrant(),
        state: 'awaiting-decision',
        decisionRevision: null,
        grantId: null,
      };
      await repo.saveRequest(awaiting);
      const decisionTransport = new DecisionTransportAdapter({
        ownerPublicKey: signer.ownerPublicKey,
        decisionsDir: join(dir, 'decisions'),
      });
      return { awaiting, decisionTransport };
    };

    it('refuses tampered signed decision fixtures', async () => {
      const { awaiting, decisionTransport } = await resolveAwaiting();
      // The answer is shaped like the fixture's but carries a signature no
      // owner could have made over these exact fields.
      await writeFile(
        join(dir, 'decisions', `${awaiting.id}.json`),
        JSON.stringify({
          state: 'approved',
          decisionRevision: 'dec-1',
          grantId: 'grant-owner',
          signature: Buffer.alloc(64).toString('base64'),
        }),
      );
      expect(await decisionTransport.readDecisionAnswer({
        requestId: awaiting.id,
        projectId: awaiting.projectId,
        actionScope: awaiting.actionScope,
        expectedHeadSha: awaiting.expectedHeadSha,
      })).toEqual({ state: 'awaiting-decision', decisionRevision: null, grantId: null });
      // KEY0c1a fix round: the resolver is invoked while the TAMPERED answer
      // is still in place — the valid answer is written only afterwards.
      expect(await new ResolveActionAuthorizationUseCase({
        requestRepo: repo,
        ...signer.deps,
      }).resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: SCOPE,
        expectedHeadSha: HEAD,
        attemptId: 'att-A',
      })).toEqual({
        outcome: 'blocked',
        reason: 'recorded request req-owner is awaiting-decision, which does not authorize an action',
      });
      // Only the valid signed answer authorizes the resolve. It is derived
      // from the granted record: a grantless approval authorizes nothing.
      await signer.writeApprovedAnswer(ownerGrant());
      await signer.assertApprovedAnswerReadsBackApproved(ownerGrant());
      expect(await resolver().resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: SCOPE,
        expectedHeadSha: HEAD,
        attemptId: 'att-A',
      })).toEqual({
        outcome: 'authorized',
        grantId: 'grant-owner',
        requestId: awaiting.id,
        expectedHeadSha: HEAD,
        policyRevision: 'pol-1',
      });
    });

    it('keeps awaiting-decision blocked when the answer file is absent', async () => {
      const { awaiting, decisionTransport } = await resolveAwaiting();
      expect(await decisionTransport.readDecisionAnswer({
        requestId: awaiting.id,
        projectId: awaiting.projectId,
        actionScope: awaiting.actionScope,
        expectedHeadSha: awaiting.expectedHeadSha,
      })).toEqual({ state: 'awaiting-decision', decisionRevision: null, grantId: null });
      expect(await new ResolveActionAuthorizationUseCase({
        requestRepo: repo,
        ...signer.deps,
      }).resolveActionAuthorization({
        projectId: 'project-1',
        actionScope: SCOPE,
        expectedHeadSha: HEAD,
        attemptId: 'att-A',
      })).toEqual({
        outcome: 'blocked',
        reason: 'recorded request req-owner is awaiting-decision, which does not authorize an action',
      });
    });
  });

  describe('consumption', () => {
    it('refuses an owner grant recorded for attempt A when consumed with B, recording nothing', async () => {
      const boundGrant = ownerGrant({ grantRecordVersion: 2, grantAttemptId: 'att-A' });
      await repo.saveRequest(boundGrant);
      await signer.writeApprovedAnswer(boundGrant);
      await signer.assertApprovedAnswerReadsBackApproved(boundGrant);
      expect(await consumer().recordAuthorizationConsumption(consume('grant-owner', 'att-B'))).toEqual({
        outcome: 'refused',
        reason: 'grant-attempt-mismatch',
      });
      const stored = await repo.findRequestByGrantId('grant-owner');
      expect(stored?.consumptions).toHaveLength(0);
      expect(stored?.state).toBe('approved');
      expect(stored?.revision).toBe(1);
    });

    it('consumes an owner grant for its own attempt and records that attempt', async () => {
      const boundGrant = ownerGrant({ grantRecordVersion: 2, grantAttemptId: 'att-A' });
      await repo.saveRequest(boundGrant);
      // KEY0c1a fix round: the consumed owner grant carries its signed answer
      // under the same signer the consumer reads, self-checked first.
      await signer.writeApprovedAnswer(boundGrant);
      await signer.assertApprovedAnswerReadsBackApproved(boundGrant);
      const result = await consumer().recordAuthorizationConsumption(consume('grant-owner', 'att-A'));
      expect(result.outcome).toBe('consumed');
      expect((await repo.findRequestByGrantId('grant-owner'))?.consumptions[0]?.attemptId).toBe('att-A');
    });

    it('refuses a version-2 grant that records no attempt', async () => {
      const unrecorded = ownerGrant({ grantRecordVersion: 2 });
      await repo.saveRequest(unrecorded);
      await signer.writeApprovedAnswer(unrecorded);
      await signer.assertApprovedAnswerReadsBackApproved(unrecorded);
      expect(await consumer().recordAuthorizationConsumption(consume('grant-owner', 'att-A'))).toEqual({
        outcome: 'refused',
        reason: 'grant-attempt-unrecorded',
      });
      expect((await repo.findRequestByGrantId('grant-owner'))?.consumptions).toHaveLength(0);
    });

    it('still consumes a legacy grant with no attempt, whatever attempt the composition validated (CO24d rule)', async () => {
      const legacyGrant = ownerGrant();
      await repo.saveRequest(legacyGrant);
      // KEY0c1a fix round: the consumed owner grant carries its signed answer
      // under the same signer the consumer reads, self-checked first.
      await signer.writeApprovedAnswer(legacyGrant);
      await signer.assertApprovedAnswerReadsBackApproved(legacyGrant);
      const result = await consumer().recordAuthorizationConsumption(consume('grant-owner', 'att-B'));
      expect(result.outcome).toBe('consumed');
    });

    it('still refuses a legacy policy grant for another attempt', async () => {
      await repo.saveRequest(
        ownerGrant({
          actionScope: 'forge:merge-pr',
          decisionRevision: 'policy:autoMerge@309ab8c40bf2',
          policyGrant: { workOrderId: 'wo-1', attemptId: 'att-A', acceptanceReceiptId: 'r-1' },
        }),
      );
      expect(
        await consumer().recordAuthorizationConsumption({ ...consume('grant-owner', 'att-B'), actionScope: 'forge:merge-pr' }),
      ).toEqual({ outcome: 'refused', reason: 'grant-attempt-mismatch' });
    });
  });
});

describe('KEY0c2 fix round: a refusalReason blocks in every answer state', () => {
  let dir: string;
  let repo: CoordinationRequestRepositoryAdapter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'co24e-oc-refusal-'));
    repo = new CoordinationRequestRepositoryAdapter({ stateDir: dir });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * An injected transport returning an approved answer whose binding fields
   * match the stored record, but which also carries a named refusal. Before
   * the fix round the use cases honoured such a refusal only when the answer
   * state was `awaiting-decision`, so this approved shape authorized.
   */
  const refusingTransport = () => ({
    async readDecisionAnswer() {
      return {
        state: 'approved' as const,
        decisionRevision: 'dec-1',
        grantId: 'grant-owner',
        refusalReason: 'owner-key-unpinned' as const,
      };
    },
  });

  it('resolve blocks an approved answer carrying owner-key-unpinned despite matching binding', async () => {
    await repo.saveRequest(ownerGrant());
    const result = await new ResolveActionAuthorizationUseCase({
      requestRepo: repo,
      decisionTransport: refusingTransport(),
    }).resolveActionAuthorization({ projectId: 'project-1', actionScope: SCOPE, expectedHeadSha: HEAD });
    expect(result).toEqual({ outcome: 'blocked', reason: 'owner-key-unpinned' });
  });

  it('consume refuses an approved answer carrying owner-key-unpinned despite matching binding and records nothing', async () => {
    await repo.saveRequest(ownerGrant());
    expect(
      await new RecordAuthorizationConsumptionUseCase({
        requestRepo: repo,
        decisionTransport: refusingTransport(),
      }).recordAuthorizationConsumption(consume('grant-owner', 'att-A')),
    ).toEqual({ outcome: 'refused', reason: 'owner-key-unpinned' });
    expect((await repo.findRequestByGrantId('grant-owner'))?.consumptions).toHaveLength(0);
  });
});
