/** The `coordination` command group of the CLI driver; its entries moved verbatim from the command table. */

import { createHash, randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  COORDINATION_KINDS,
  RELEASE_GRANT_DIGEST_PREFIX,
  SHADOW_IMPORT_ACTION_SCOPE,
  SHADOW_IMPORT_DIGEST_PREFIX,
  isReleaseActionScope,
  isReleaseRootCoordinate,
  releaseGrantDigestPayload,
  shadowImportDigestPayload,
  buildPreSignShadowImportPlan,
  buildSignableDecisionFields,
  parseSignDecisionInput,
} from '@fleet/operator-coordination';
import { forgeActionScope } from '@fleet/work-execution';
import type { AttentionItemState, RequestScopedDecisionResult } from '@fleet/operator-coordination';
import {
  str,
  optStr,
  strOrNull,
  num,
  strArr,
  nested,
  enumOf,
  CliUsageError,
} from './payload.js';
import type { CommandHandler, Payload } from './payload.js';
import type { FleetCliRuntime } from '../composition.js';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** The SHA-256 hex digest a shadow import grant's request id is bound by. */
function sha256HexDigest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export const coordinationCommands: Readonly<Record<string, CommandHandler>> = {
    'register-profile': async (p, rt) =>
      rt.coordination.registerProjectProfile.registerProjectProfile({
        projectId: str(p, 'projectId'),
        displayName: str(p, 'displayName'),
        repository: str(p, 'repository'),
        designatedDispatcherHost: str(p, 'designatedDispatcherHost'),
        policyRevision: str(p, 'policyRevision'),
        maxConcurrentLanes: num(p, 'maxConcurrentLanes', 1),
        runnerCapabilities: nested<Record<string, boolean | string>>(p, 'runnerCapabilities') ?? {},
        nowIso: optStr(p, 'nowIso'),
      }),
    capabilities: async (p, rt) =>
      rt.coordination.inspectConfiguredCapabilities.inspectConfiguredCapabilities({
        projectId: str(p, 'projectId'),
        requiredCapabilities: strArr(p, 'requiredCapabilities'),
      }),
    'request-decision': async (p, rt) => {
      const actionScope = str(p, 'actionScope');
      if (actionScope === SHADOW_IMPORT_ACTION_SCOPE) {
        return shadowImportRequestDecision(p, rt);
      }
      // RR1: a release grant is requested by its exact root, normalized via
      // `realpath` exactly like `release.ts` and bound into the derived
      // `release-grant-<sha256>` request id.
      if (isReleaseActionScope(actionScope)) {
        return releaseRequestDecision(p, rt, actionScope);
      }
      // RR1: `--release-root` is only ever meaningful for a release scope; on
      // any other scope it is refused before anything is recorded, even when
      // empty or not a string.
      if (Object.hasOwn(p, 'releaseRoot')) {
        throw new CliUsageError('request-decision: --release-root is only allowed for release:* scopes');
      }
      return rt.coordination.requestScopedDecision.requestScopedDecision({
        requestId: str(p, 'requestId'),
        projectId: str(p, 'projectId'),
        kind: enumOf(p, 'kind', COORDINATION_KINDS, 'coordination kind'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: strOrNull(p, 'expectedHeadSha'),
        proposalDigest: str(p, 'proposalDigest'),
        policyRevision: str(p, 'policyRevision'),
        ...(optStr(p, 'attemptId') !== undefined ? { attemptId: str(p, 'attemptId') } : {}),
        nowIso: optStr(p, 'nowIso'),
      });
    },
    'resolve-auth': async (p, rt) => {
      const actionScope = str(p, 'actionScope');
      // RR1: the release root travels with the grant coordinates on a
      // resolve, so a grant for one root never authorizes another.
      const releaseRoot = optStr(p, 'releaseRoot');
      // The standing shadow import grant resolves head-free (cutover runbook):
      // it is bound by its digest-bound grant id, its exact repository and its
      // capped expiry, never by a commit, so no `--expected-head-sha` is taken
      // or required. Every other scope keeps main's exact head requirement.
      if (actionScope === SHADOW_IMPORT_ACTION_SCOPE) {
        return rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
          projectId: str(p, 'projectId'),
          actionScope,
          expectedHeadSha: optStr(p, 'expectedHeadSha') ?? '',
          authorizationGrantId: optStr(p, 'authorizationGrantId'),
          ...(optStr(p, 'repository') !== undefined ? { repository: optStr(p, 'repository') } : {}),
          ...(releaseRoot !== undefined ? { releaseRoot } : {}),
        });
      }
      return rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: str(p, 'projectId'),
        actionScope,
        expectedHeadSha: str(p, 'expectedHeadSha'),
        authorizationGrantId: optStr(p, 'authorizationGrantId'),
        ...(optStr(p, 'attemptId') !== undefined ? { attemptId: str(p, 'attemptId') } : {}),
        ...(releaseRoot !== undefined ? { releaseRoot } : {}),
      });
    },
    'consume-auth': async (p, rt) =>
      rt.coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
        consumptionId: str(p, 'consumptionId'),
        grantId: str(p, 'grantId'),
        actionId: str(p, 'actionId'),
        actionScope: str(p, 'actionScope') || (str(p, 'actionKind') ? forgeActionScope(str(p, 'actionKind')) : ''),
        attemptId: str(p, 'attemptId'),
        expectedHeadSha: str(p, 'expectedHeadSha'),
        nowIso: optStr(p, 'nowIso'),
        ...(optStr(p, 'releaseRoot') !== undefined ? { releaseRoot: optStr(p, 'releaseRoot') } : {}),
      }),
    'publish-observation': async (p, rt) =>
      rt.coordination.publishProjectObservation.publishProjectObservation({
        observationId: str(p, 'observationId'),
        projectId: str(p, 'projectId'),
        eventKind: str(p, 'eventKind'),
        sourceAttemptId: strOrNull(p, 'sourceAttemptId'),
        payloadSummary: str(p, 'payloadSummary'),
        nowIso: optStr(p, 'nowIso'),
      }),
    attention: async (p, rt) =>
      rt.coordination.readProjectAttention.readProjectAttention({
        projectId: str(p, 'projectId'),
      }),
    'attention-items': async (p, rt) =>
      // A supplied filter is passed through as given, even empty, so the use case can refuse it (an empty list);
      // only an absent flag means "no filter".
      rt.coordination.listAttentionItems.listAttentionItems({
        ...(Object.hasOwn(p, 'projectId') ? { projectId: str(p, 'projectId') } : {}),
        ...(Object.hasOwn(p, 'state') ? { state: str(p, 'state') as AttentionItemState } : {}),
        ...(Object.hasOwn(p, 'kind') ? { kind: str(p, 'kind') } : {}),
        ...(Object.hasOwn(p, 'workOrderId') ? { workOrderId: str(p, 'workOrderId') } : {}),
      }),
    'attention-dismiss': async (p, rt) => {
      const revisionRaw = optStr(p, 'expectedRevision');
      const revision = revisionRaw !== undefined && /^\d{1,15}$/.test(revisionRaw) ? Number(revisionRaw) : NaN;
      if (!Number.isSafeInteger(revision)) {
        throw new CliUsageError(
          "attention-dismiss requires '--expectedRevision <n>' with an integer value",
        );
      }
      return rt.coordination.clearAttentionItem.clearAttentionItem(
        {
          action: 'dismiss',
          itemId: str(p, 'itemId'),
          expectedRevision: revision,
        },
        'cli',
        'cli',
      );
    },
    'send-relay': async (p, rt) =>
      rt.coordination.sendFleetRelay.sendFleetRelay({
        requestId: str(p, 'requestId'),
        projectId: str(p, 'projectId'),
        recipientId: str(p, 'recipientId'),
        summary: str(p, 'summary'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'ack-relay': async (p, rt) =>
      rt.coordination.recordRelayAcknowledgement.recordRelayAcknowledgement({
        acknowledgementId: str(p, 'acknowledgementId'),
        requestId: str(p, 'requestId'),
        recipientId: str(p, 'recipientId'),
        responseSummary: str(p, 'responseSummary'),
        provenance: str(p, 'provenance'),
        nowIso: optStr(p, 'nowIso'),
      }),
    outstanding: async (p, rt) =>
      rt.coordination.inspectOutstandingCoordination.inspectOutstandingCoordination({
        projectId: optStr(p, 'projectId'),
      }),
    'revoke-grant': async (p, rt) =>
      rt.coordination.requestScopedDecision.revokeOwnerGrant({
        grantId: optStr(p, 'grantId') ?? str(p, 'grant-id'),
      }),
    'sign-decision': async (p, rt) => {
      if (p['preSign'] === true || p['preSign'] === 'true') {
        return preSignShadowImportDecision(p, rt);
      }
      const requestId = str(p, 'request');
      const answer = optStr(p, 'answer');
      const grantId = optStr(p, 'grantId');
      const decisionRevision = optStr(p, 'decisionRevision');
      const keyPath = optStr(p, 'key');
      const yes = p.yes === true || p.yes === 'true';
      // Input validation happens before any key is read or any file is
      // touched: an invalid flag is a usage error even without --yes.
      const parsed = parseSignDecisionInput({
        requestId,
        ...(answer !== undefined ? { answer } : {}),
        ...(grantId !== undefined ? { grantId } : {}),
        ...(decisionRevision !== undefined ? { decisionRevision } : {}),
      });
      if (!parsed.ok) {
        throw new CliUsageError('sign-decision: invalid or unsafe sign-decision input');
      }
      const record = await rt.coordination.coordinationRequestRepository.findRequestById(
        parsed.input.requestId,
      );
      if (record === null) {
        return { outcome: 'refused', reason: 'request-not-found' };
      }
      const built = buildSignableDecisionFields(record, parsed.input);
      if (!built.ok) {
        return { outcome: 'refused', reason: built.code };
      }
      const scope = record.actionScope;
      const head = record.expectedHeadSha;
      const project = record.projectId;
      const repository = record.shadowImportGrant?.repository ?? record.mergeGrant?.repository;
      const releaseRoot = record.releaseRoot;
      const expiresAtIso = record.shadowImportGrant?.expiresAtIso;
      if (!yes) {
        // Preview only: no key is read, no decision file is written.
        return {
          outcome: 'preview',
          requestId: parsed.input.requestId,
          scope,
          head,
          project,
          ...(repository !== undefined ? { repository } : {}),
          ...(releaseRoot !== undefined ? { releaseRoot } : {}),
          ...(expiresAtIso !== undefined ? { expiresAtIso } : {}),
        };
      }
      if (keyPath === undefined) {
        throw new CliUsageError("sign-decision: --key is required with --yes");
      }
      const written = await rt.coordination.decisionTransport.signAndWriteDecisionAnswer({
        fields: built.fields,
        keyPath,
      });
      if (!written.ok) {
        return { outcome: 'refused', reason: written.code };
      }
      return {
        outcome: 'signed',
        requestId: built.fields.requestId,
        answer: parsed.input.answer,
        grantId: built.fields.grantId,
        decisionRevision: built.fields.decisionRevision,
        scope,
        head,
        project,
        ...(repository !== undefined ? { repository } : {}),
        ...(releaseRoot !== undefined ? { releaseRoot } : {}),
        ...(expiresAtIso !== undefined ? { expiresAtIso } : {}),
      };
    },
};

/**
 * The standing shadow import grant's request-decision entry. The request id
 * is the digest of the grant's exact coordinates ({ scope, owner, repo,
 * expiresAtIso }), so the CLI derives it from `--repository` and
 * `--expires-at-iso` instead of taking it from the owner's hand: a hand-typed
 * id that does not match the derived one is refused, never silently recorded
 * under a digest it does not carry.
 */
function shadowImportRequestDecision(
  p: Payload,
  rt: FleetCliRuntime,
): Promise<RequestScopedDecisionResult> {
  const repositoryRaw = str(p, 'repository').trim();
  const expiresAtIso = optStr(p, 'expiresAtIso');
  const segments = repositoryRaw.split('/');
  if (
    repositoryRaw === '' ||
    segments.length !== 2 ||
    !REPOSITORY_SEGMENT_PATTERN.test(segments[0]!) ||
    !REPOSITORY_SEGMENT_PATTERN.test(segments[1]!)
  ) {
    throw new CliUsageError(
      'request-decision: --repository must be owner/repo for merge:import-shadow',
    );
  }
  if (expiresAtIso === undefined) {
    throw new CliUsageError(
      'request-decision: --expires-at-iso is required for merge:import-shadow',
    );
  }
  const shadowImportGrant = { repository: { owner: segments[0]!, repo: segments[1]! }, expiresAtIso };
  const payload = shadowImportDigestPayload(shadowImportGrant);
  if (!payload.ok) {
    throw new CliUsageError('request-decision: invalid shadow import grant coordinates');
  }
  const requestId = `${SHADOW_IMPORT_DIGEST_PREFIX}${sha256HexDigest(payload.value)}`;
  const supplied = optStr(p, 'requestId');
  if (supplied !== undefined && supplied !== requestId) {
    // The id is a non-secret digest handle, so refusing without echoing the
    // supplied value keeps no secret and still tells the owner what to do.
    throw new CliUsageError(
      "request-decision: the hand-typed '--requestId' does not match the id derived from the grant's coordinates",
    );
  }
  return rt.coordination.requestScopedDecision.requestScopedDecision({
    requestId,
    projectId: str(p, 'projectId'),
    kind: enumOf(p, 'kind', COORDINATION_KINDS, 'coordination kind'),
    actionScope: SHADOW_IMPORT_ACTION_SCOPE,
    expectedHeadSha: null,
    proposalDigest: str(p, 'proposalDigest'),
    policyRevision: str(p, 'policyRevision'),
    ...(optStr(p, 'attemptId') !== undefined ? { attemptId: str(p, 'attemptId') } : {}),
    shadowImportGrant,
  });
}

/**
 * A release grant's request-decision entry (RR1). The request id is the digest
 * of the grant's exact coordinates ({ scope, projectId, expectedHeadSha,
 * releaseRoot, nonce }), so the CLI derives it from `--release-root` and the
 * other flags — plus a fresh per-request nonce — instead of taking it from the operator's hand: a hand-typed
 * `--request-id` that does not match the derived one is refused, never
 * silently recorded under a digest it does not carry. `--release-root` is
 * required, must be a bounded absolute path without `..`, and is normalized
 * through `realpath` (resolving symlinks) exactly like `release.ts`, so the
 * grant is bound to the same canonical root `release install --root` resolves
 * to. A path that cannot be resolved on disk is a usage error that never
 * echoes the path.
 */
async function releaseRequestDecision(
  p: Payload,
  rt: FleetCliRuntime,
  actionScope: string,
): Promise<RequestScopedDecisionResult> {
  const releaseRoot = optStr(p, 'releaseRoot');
  if (releaseRoot === undefined) {
    throw new CliUsageError('request-decision: --release-root is required for release:* scopes');
  }
  if (!isReleaseRootCoordinate(releaseRoot)) {
    throw new CliUsageError(
      "request-decision: --release-root must be a bounded absolute path without '..'",
    );
  }
  let normalizedRoot: string;
  try {
    normalizedRoot = await realpath(releaseRoot);
  } catch {
    throw new CliUsageError('request-decision: --release-root must resolve to an existing directory');
  }
  // The root is the directory a release installs from or swaps: an existing
  // regular file (or any other non-directory) is a usage error, refused before
  // it can be bound into a grant. The message never echoes the path.
  if (!(await stat(normalizedRoot)).isDirectory()) {
    throw new CliUsageError('request-decision: --release-root must resolve to an existing directory');
  }
  const expectedHeadSha = strOrNull(p, 'expectedHeadSha');
  // A fresh per-request nonce (16 random bytes as hex), so the same
  // coordinates can be requested again after a use, a rollback or a denial.
  const nonce = randomBytes(16).toString('hex');
  const payload = releaseGrantDigestPayload({
    actionScope,
    projectId: str(p, 'projectId'),
    expectedHeadSha,
    releaseRoot: normalizedRoot,
    nonce,
  });
  if (!payload.ok) {
    throw new CliUsageError('request-decision: invalid release grant coordinates');
  }
  const requestId = `${RELEASE_GRANT_DIGEST_PREFIX}${sha256HexDigest(payload.value)}`;
  const supplied = optStr(p, 'requestId');
  if (supplied !== undefined && supplied !== requestId) {
    // The id is a non-secret digest handle, so refusing without echoing the
    // supplied value keeps no secret and still tells the operator what to do.
    throw new CliUsageError(
      "request-decision: the hand-typed '--requestId' does not match the id derived from the grant's coordinates",
    );
  }
  return rt.coordination.requestScopedDecision.requestScopedDecision({
    requestId,
    projectId: str(p, 'projectId'),
    kind: enumOf(p, 'kind', COORDINATION_KINDS, 'coordination kind'),
    actionScope,
    expectedHeadSha,
    proposalDigest: str(p, 'proposalDigest'),
    policyRevision: str(p, 'policyRevision'),
    ...(optStr(p, 'attemptId') !== undefined ? { attemptId: str(p, 'attemptId') } : {}),
    nowIso: optStr(p, 'nowIso'),
    releaseRoot: normalizedRoot,
    releaseNonce: nonce,
  });
}

/**
 * KEY1c: the `sign-decision --pre-sign` entry for a standing
 * `merge:import-shadow` grant. The owner pre-signs the grant's answer file
 * from its coordinates BEFORE `request-decision` records the awaiting
 * request, so arming does not need a manual answer-recording step. The
 * request id and the deterministic grant id are derived from the coordinates'
 * digest exactly like `shadowImportRequestDecision` does; the answer is
 * written through the same KEY1a writer (`signAndWriteDecisionAnswer`), so
 * the key read, the pinned-key check, the atomic write and the self-verify
 * are never re-implemented here.
 *
 * Refusals, in order: a non-shadow scope, a malformed flag or a missing
 * `--key` is a usage error (exit 2) before any key is read or any file is
 * written; an already-recorded request id refuses
 * `shadow-request-already-recorded`; a missing `--state-dir` refuses
 * `state-dir-required`; a missing `--yes` prints the non-secret coordinates
 * and refuses without reading the key. All coordinates printed are
 * non-secret handles.
 */
async function preSignShadowImportDecision(
  p: Payload,
  rt: FleetCliRuntime,
): Promise<unknown> {
  const actionScope = str(p, 'actionScope');
  if (actionScope !== SHADOW_IMPORT_ACTION_SCOPE) {
    throw new CliUsageError('sign-decision: --pre-sign only supports --action-scope merge:import-shadow');
  }
  const repositoryRaw = optStr(p, 'repository')?.trim() ?? '';
  const segments = repositoryRaw.split('/');
  if (
    repositoryRaw === '' ||
    segments.length !== 2 ||
    !REPOSITORY_SEGMENT_PATTERN.test(segments[0]!) ||
    !REPOSITORY_SEGMENT_PATTERN.test(segments[1]!)
  ) {
    throw new CliUsageError('sign-decision: --repository must be owner/repo for merge:import-shadow');
  }
  const projectId = optStr(p, 'projectId') ?? optStr(p, 'project');
  if (projectId === undefined) {
    throw new CliUsageError('sign-decision: --project (or --project-id) is required for --pre-sign');
  }
  const expiresAtIso = optStr(p, 'expiresAtIso') ?? optStr(p, 'expiresAt');
  if (expiresAtIso === undefined) {
    throw new CliUsageError('sign-decision: --expires-at (or --expires-at-iso) is required for --pre-sign');
  }
  const keyPath = optStr(p, 'key');
  if (keyPath === undefined) {
    throw new CliUsageError('sign-decision: --key is required for --pre-sign');
  }
  // `--now-iso` is ignored for --pre-sign: the plan's moment is always the
  // trusted clock, never a caller-supplied one.
  const plan = buildPreSignShadowImportPlan({
    actionScope,
    repository: { owner: segments[0]!, repo: segments[1]! },
    expiresAtIso,
    nowIso: new Date().toISOString(),
    projectId,
    ...(optStr(p, 'decisionRevision') !== undefined
      ? { decisionRevision: optStr(p, 'decisionRevision') }
      : {}),
  });
  if (!plan.ok) {
    // A malformed repository or expiry is a usage error (exit 2); every other
    // domain refusal is a typed refusal (exit 1) — still before any key is
    // read or any file is written.
    if (
      plan.code === 'shadow-import-grant-invalid-repository' ||
      plan.code === 'shadow-import-grant-invalid-expiry' ||
      plan.code === 'shadow-import-grant-not-object' ||
      plan.code === 'shadow-import-grant-unexpected-key' ||
      plan.code === 'shadow-import-grant-invalid-input'
    ) {
      throw new CliUsageError('sign-decision: invalid shadow import grant coordinates for --pre-sign');
    }
    return { outcome: 'refused', reason: plan.code };
  }
  const digestHex = sha256HexDigest(plan.value.digestPayload);
  const requestId = `${SHADOW_IMPORT_DIGEST_PREFIX}${digestHex}`;
  const grantId = `shadow-import-grant-${digestHex.slice(0, 16)}`;
  const decisionRevision = plan.value.decisionRevision;
  const coordinates = {
    requestId,
    projectId: plan.value.projectId,
    actionScope,
    repository: { owner: plan.value.repository.owner, repo: plan.value.repository.repo },
    expiresAtIso: plan.value.expiresAtIso,
    grantId,
    decisionRevision,
  };
  // An already-recorded request (awaiting or decided) refuses before any key
  // is read or any file is written: an awaiting record never gains a grantId,
  // and re-signing a live grant blocks it with `decision-signature-invalid`.
  const existing = await rt.coordination.coordinationRequestRepository.findRequestById(requestId);
  if (existing !== null) {
    return { outcome: 'refused', reason: 'shadow-request-already-recorded', ...coordinates };
  }
  const decisionsDir = rt.coordination.decisionTransport.decisionsDirectory;
  if (decisionsDir === undefined || decisionsDir.trim().length === 0) {
    return { outcome: 'refused', reason: 'state-dir-required', ...coordinates };
  }
  const answerPath = join(decisionsDir, `${requestId}.json`);
  const yes = p['yes'] === true || p['yes'] === 'true';
  if (!yes) {
    // Coordinates only: no key is read, no decision file is written.
    return { outcome: 'refused', reason: 'yes-required', ...coordinates, answerPath };
  }
  const written = await rt.coordination.decisionTransport.signAndWriteDecisionAnswer({
    fields: {
      requestId,
      projectId: plan.value.projectId,
      actionScope,
      expectedHeadSha: null,
      decisionRevision,
      grantId,
      state: 'approved',
    },
    keyPath,
  });
  if (!written.ok) {
    return { outcome: 'refused', reason: written.code };
  }
  return { outcome: 'signed', ...coordinates, answerPath };
}
