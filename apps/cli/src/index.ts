/**
 * Fleet CLI driver: the operator-facing application boundary across the four
 * bounded contexts. Subcommands map one JSON payload (or `--kebab-case` flags)
 * onto one application port call and print the typed result to stdout as one
 * JSON document.
 *
 * Exit codes: 0 for completed operations, 1 for refusal-family results and
 * unexpected errors, 2 for usage errors. All I/O goes through the injected
 * `CliIo`, so package code never touches `console`.
 */

import { join, resolve } from 'node:path';

import type {
  BriefContextDecision,
  BriefModelAssignment,
  CommandCompletionReceipt,
  RunnerIsolationCapabilities,
} from '@fleet/work-execution';
import type {
  FindingDispositionRecord,
  ReviewReceiptRecord,
  VerificationReceiptRecord,
} from '@fleet/evidence-and-acceptance';
import {
  KNOWLEDGE_DISPOSITIONS,
  KNOWLEDGE_REUSE_OUTCOMES,
  type RecordContextSelectionItem,
} from '@fleet/brief-knowledge';
import { COORDINATION_KINDS } from '@fleet/operator-coordination';

import {
  assessmentIdForAttempt,
  createFleetCliRuntime,
  type FleetCliRuntime,
} from './composition.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Default process-stream I/O; used by `main` and any caller omitting `io`. */
const processIo: CliIo = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Signalled for argument-shape problems; reported as exit code 2. */
class CliUsageError extends Error {}

type Payload = Record<string, unknown>;

type CommandHandler = (payload: Payload, runtime: FleetCliRuntime) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Payload coercion helpers. Values arrive from `--json` (typed JSON) or from
// flags (strings); every helper normalizes without inventing data.
// ---------------------------------------------------------------------------

function str(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function optStr(payload: Payload, key: string): string | undefined {
  const value = str(payload, key);
  return value.trim() === '' ? undefined : value;
}

function strOrNull(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function num(payload: Payload, key: string, fallback: number): number {
  const value = payload[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optNum(payload: Payload, key: string): number | undefined {
  const value = payload[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function strArr(payload: Payload, key: string): string[] {
  const value = payload[key];
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return [];
}

/**
 * Pass one nested JSON object through to a typed request field. The receiving
 * use case validates the record; the driver only guarantees it is an object.
 */
function nested<T>(payload: Payload, key: string): T | undefined {
  const value = payload[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as T)
    : undefined;
}

/** A nested JSON object the request shape requires; a usage error when absent. */
function requiredNested<T>(payload: Payload, key: string, label: string): T {
  const value = nested<T>(payload, key);
  if (value === undefined) {
    throw new CliUsageError(`${label} requires a JSON object in '--${key}'`);
  }
  return value;
}

/** A closed enum value the request shape requires; a usage error when absent. */
function enumOf<T extends string>(payload: Payload, key: string, allowed: readonly T[], label: string): T {
  const value = str(payload, key);
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new CliUsageError(`${label} must be one of: ${allowed.join(', ')}`);
}

function nestedArr<T>(payload: Payload, key: string): T[] | undefined {
  const value = payload[key];
  return Array.isArray(value) ? (value as T[]) : undefined;
}

function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Parse remaining tokens into a payload: flags first, `--json` overlay last. */
function parseFlags(tokens: readonly string[]): Payload {
  const payload: Payload = {};
  let jsonPayload: Payload | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--json') {
      const raw = tokens[index + 1];
      if (raw === undefined) {
        throw new CliUsageError('--json requires a JSON payload argument');
      }
      index += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new CliUsageError(
          `--json payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new CliUsageError('--json payload must be a JSON object');
      }
      jsonPayload = parsed as Payload;
      continue;
    }
    if (!token.startsWith('--') || token === '--') {
      throw new CliUsageError(`Unexpected argument: ${token}`);
    }
    const body = token.slice(2);
    const separator = body.indexOf('=');
    const key = kebabToCamel(separator === -1 ? body : body.slice(0, separator));
    if (separator !== -1) {
      payload[key] = body.slice(separator + 1);
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith('--')) {
      payload[key] = true;
      continue;
    }
    payload[key] = next;
    index += 1;
  }
  if (jsonPayload !== undefined) {
    Object.assign(payload, jsonPayload);
  }
  return payload;
}

/**
 * Strip the global `--state-dir <path>` / `--state-dir=<path>` option from any
 * position so it never reaches group dispatch or `parseFlags`, falling back to
 * the `FLEET_STATE_DIR` environment value when the flag is omitted. Valid
 * paths are normalized with `path.resolve`; a missing, empty or malformed
 * value is a usage error.
 */
export function extractStateDirOption(
  argv: readonly string[],
  envStateDir?: string,
): { readonly stateDir?: string; readonly restArgv: readonly string[] } {
  let stateDir: string | undefined;
  const restArgv: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--state-dir') {
      const value = argv[index + 1];
      index += 1;
      if (
        value === undefined ||
        value.trim() === '' ||
        value.startsWith('--') ||
        value.includes('\0')
      ) {
        throw new CliUsageError('Invalid --state-dir value');
      }
      stateDir = resolve(value);
      continue;
    }
    if (token.startsWith('--state-dir=')) {
      const value = token.slice('--state-dir='.length);
      if (value.trim() === '' || value.startsWith('--') || value.includes('\0')) {
        throw new CliUsageError('Invalid --state-dir value');
      }
      stateDir = resolve(value);
      continue;
    }
    restArgv.push(token);
  }
  if (stateDir === undefined) {
    const fromEnv = envStateDir?.trim();
    if (fromEnv !== undefined && fromEnv !== '') {
      stateDir = resolve(fromEnv);
    }
  }
  return { stateDir, restArgv };
}

/** Strict isolation profile required of runners unless overridden per dispatch. */
const STRICT_RUNNER_CAPABILITIES: RunnerIsolationCapabilities = {
  filesystemScope: 'scoped-worktree',
  networkEgressRestricted: true,
  cpuAndMemoryLimited: true,
  processTreeTermination: true,
  authoritativeCompletion: true,
  artifactPersistence: true,
};

/** Result outcomes that report a refusal, gap or unknown and exit non-zero. */
const NON_ZERO_OUTCOMES: ReadonlySet<string> = new Set([
  'rejected',
  'refused',
  'blocked',
  'not-found',
  'unavailable',
  'delivery-gap',
  'delivery-failed',
  'stale',
  'no-free-slot',
  'busy-worktree',
  'still-running',
  'unknown',
]);

function exitCodeForResult(result: unknown): number {
  if (typeof result === 'object' && result !== null && 'outcome' in result) {
    const outcome = (result as { outcome: unknown }).outcome;
    if (typeof outcome === 'string' && NON_ZERO_OUTCOMES.has(outcome)) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Command table. Each handler builds one typed request from the payload; the
// use case owns every behavioural decision.
// ---------------------------------------------------------------------------

const COMMANDS: Readonly<Record<string, Readonly<Record<string, CommandHandler>>>> = {
  'work-order': {
    register: async (p, rt) =>
      rt.execution.registerWorkOrder.registerWorkOrder({
        workOrderId: str(p, 'workOrderId'),
        projectId: str(p, 'projectId'),
        taskId: str(p, 'taskId'),
        laneId: str(p, 'laneId'),
        repository: str(p, 'repository'),
        baseCommit: str(p, 'baseCommit'),
        ownedPaths: strArr(p, 'ownedPaths'),
        policyRevision: str(p, 'policyRevision'),
        prerequisiteWorkOrderIds: strArr(p, 'prerequisiteWorkOrderIds'),
        nowIso: optStr(p, 'nowIso'),
      }),
    inspect: async (p, rt) =>
      rt.execution.inspectWorkOrder.inspectWorkOrder({ workOrderId: str(p, 'workOrderId') }),
  },
  brief: {
    prepare: async (p, rt) =>
      rt.execution.prepareBriefPackage.prepareBriefPackage({
        workOrderId: str(p, 'workOrderId'),
        projectId: str(p, 'projectId'),
        taskId: str(p, 'taskId'),
        laneId: str(p, 'laneId'),
        repository: str(p, 'repository'),
        baseCommit: str(p, 'baseCommit'),
        policyRevision: str(p, 'policyRevision'),
        modelAssignment:
          nested<BriefModelAssignment>(p, 'modelAssignment') ?? {
            model: str(p, 'model'),
            variant: str(p, 'variant') || 'default',
            fallbackModel: str(p, 'fallbackModel'),
          },
        independentReviewer: str(p, 'independentReviewer'),
        ownedPaths: strArr(p, 'ownedPaths'),
        permissions: strArr(p, 'permissions'),
        acceptanceChecks: strArr(p, 'acceptanceChecks'),
        stepLimit: num(p, 'stepLimit', 200),
        timeLimitSeconds: num(p, 'timeLimitSeconds', 3600),
        resourceBounds: nested<Record<string, string>>(p, 'resourceBounds') ?? {},
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        ownerDecisionReferences: strArr(p, 'ownerDecisionReferences'),
        contextDecisions: nestedArr<BriefContextDecision>(p, 'contextDecisions') ?? [],
        attemptId: optStr(p, 'attemptId'),
        worktreePath: optStr(p, 'worktreePath'),
        handWrittenBriefPath: strOrNull(p, 'handWrittenBriefPath'),
      }),
  },
  capacity: {
    reserve: async (p, rt) =>
      rt.execution.reserveExecutionCapacity.reserveExecutionCapacity({
        reservationId: str(p, 'reservationId'),
        attemptId: str(p, 'attemptId'),
        workOrderId: str(p, 'workOrderId'),
        hostId: str(p, 'hostId'),
        worktreePath: str(p, 'worktreePath'),
        maxSlots: num(p, 'maxSlots', 1),
        nowIso: optStr(p, 'nowIso'),
      }),
  },
  attempt: {
    dispatch: async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const existing = await rt.execution.attemptRepository.findAttemptById(attemptId);
      const worktreePath = str(p, 'worktreePath');
      const requiredCapabilities: RunnerIsolationCapabilities = {
        ...STRICT_RUNNER_CAPABILITIES,
        ...(nested<Partial<RunnerIsolationCapabilities>>(p, 'requiredCapabilities') ?? {}),
      };
      return rt.execution.dispatchAttempt.dispatchAttempt({
        attemptId,
        workOrderId: str(p, 'workOrderId') || existing?.workOrderId || '',
        worktreePath,
        briefPackagePath:
          str(p, 'briefPackagePath') ||
          (worktreePath === '' ? '' : join(worktreePath, '.lane', 'brief.md')),
        briefDigest: str(p, 'briefDigest') || existing?.briefDigest || '',
        baseCommit: str(p, 'baseCommit') || existing?.baseCommit || '',
        stepLimit: num(p, 'stepLimit', 200),
        timeLimitSeconds: num(p, 'timeLimitSeconds', 3600),
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        requiredCapabilities,
        nowIso: optStr(p, 'nowIso'),
      });
    },
    reconcile: async (p, rt) =>
      rt.execution.reconcileAttempt.reconcileAttempt({
        attemptId: str(p, 'attemptId'),
        nowIso: optStr(p, 'nowIso'),
      }),
    stop: async (p, rt) =>
      rt.execution.stopAttempt.stopAttempt({
        attemptId: str(p, 'attemptId'),
        gracePeriodSeconds: optNum(p, 'gracePeriodSeconds'),
        nowIso: optStr(p, 'nowIso'),
      }),
    collect: async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      if (attempt === null) {
        return { outcome: 'refused', reason: `Attempt not found: ${attemptId}` };
      }
      const receipt =
        nested<CommandCompletionReceipt>(p, 'completionReceipt') ?? attempt.completionReceipt;
      if (receipt === null || receipt === undefined) {
        return {
          outcome: 'refused',
          reason: 'Attempt has no recorded completion receipt; reconcile it first',
        };
      }
      return rt.execution.collectAttemptArtifacts.collectAttemptArtifacts({
        attemptId,
        workOrderId: str(p, 'workOrderId') || attempt.workOrderId,
        worktreePath: str(p, 'worktreePath') || attempt.worktreePath,
        baseCommit: str(p, 'baseCommit') || attempt.baseCommit,
        expectedArtifacts: strArr(p, 'expectedArtifacts'),
        completionReceipt: receipt,
      });
    },
    fix: async (p, rt) =>
      rt.execution.prepareFixAttempt.prepareFixAttempt({
        fixAttemptId: str(p, 'fixAttemptId'),
        workOrderId: str(p, 'workOrderId'),
        priorAttemptId: str(p, 'priorAttemptId'),
        worktreePath: str(p, 'worktreePath'),
        baseCommit: str(p, 'baseCommit'),
        numberedFixes: strArr(p, 'numberedFixes'),
        nowIso: optStr(p, 'nowIso'),
      }),
    accept: async (p, rt) => {
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      return rt.execution.requestAttemptAcceptance.requestAttemptAcceptance({
        attemptId,
        candidateHeadSha: str(p, 'candidateHeadSha') || attempt?.artifacts?.headCommit || '',
        reviewerModel: str(p, 'reviewerModel'),
      });
    },
  },
  forge: {
    execute: async (p, rt) => {
      const kind = str(p, 'kind');
      if (kind !== 'push-and-open-pr' && kind !== 'merge-pr') {
        throw new CliUsageError("forge kind must be 'push-and-open-pr' or 'merge-pr'");
      }
      const attemptId = str(p, 'attemptId');
      const attempt = await rt.execution.attemptRepository.findAttemptById(attemptId);
      return rt.execution.executeAuthorizedForgeAction.executeAuthorizedForgeAction({
        actionId: str(p, 'actionId') || `forge-${attemptId}`,
        attemptId,
        workOrderId: str(p, 'workOrderId') || attempt?.workOrderId || '',
        kind,
        expectedHeadSha: str(p, 'expectedHeadSha') || attempt?.artifacts?.headCommit || '',
        authorizationGrantId: str(p, 'authorizationGrantId'),
      });
    },
  },
  evidence: {
    'request-verification': async (p, rt) =>
      rt.evidence.requestVerification.requestVerification({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        hostId: str(p, 'hostId'),
        requiredChecks: strArr(p, 'requiredChecks'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'record-verification': async (p, rt) =>
      rt.evidence.recordVerificationReceipt.recordVerificationReceipt({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        receipt: requiredNested<VerificationReceiptRecord>(p, 'receipt', 'evidence record-verification'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'request-review': async (p, rt) =>
      rt.evidence.requestIndependentReview.requestIndependentReview({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        implementerModel: str(p, 'implementerModel'),
        reviewerModel: str(p, 'reviewerModel'),
        diffSummary: optStr(p, 'diffSummary'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'record-review': async (p, rt) =>
      rt.evidence.recordReviewReceipt.recordReviewReceipt({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        receipt: requiredNested<ReviewReceiptRecord>(p, 'receipt', 'evidence record-review'),
        nowIso: optStr(p, 'nowIso'),
      }),
    disposition: async (p, rt) =>
      rt.evidence.recordFindingDisposition.recordFindingDisposition({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        disposition: requiredNested<FindingDispositionRecord>(p, 'disposition', 'evidence disposition'),
        nowIso: optStr(p, 'nowIso'),
      }),
    assess: async (p, rt) =>
      rt.evidence.assessHeadAcceptance.assessHeadAcceptance({
        assessmentId: str(p, 'assessmentId') || assessmentIdForAttempt(str(p, 'attemptId')),
        candidateHeadSha: str(p, 'candidateHeadSha'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      }),
    inspect: async (p, rt) =>
      rt.evidence.inspectAcceptanceEvidence.inspectAcceptanceEvidence({
        assessmentId: optStr(p, 'assessmentId'),
        candidateHeadSha: optStr(p, 'candidateHeadSha'),
      }),
  },
  knowledge: {
    'capture-notes': async (p, rt) =>
      rt.knowledge.captureCompletedAttemptNotes.captureCompletedAttemptNotes({
        projectId: str(p, 'projectId'),
        attemptId: str(p, 'attemptId'),
        workOrderId: str(p, 'workOrderId'),
        headCommitSha: str(p, 'headCommitSha'),
        notesMarkdown: strOrNull(p, 'notesMarkdown'),
        pathPrefixes: strArr(p, 'pathPrefixes'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'check-claim': async (p, rt) =>
      rt.knowledge.checkKnowledgeClaim.checkKnowledgeClaim({
        checkId: str(p, 'checkId'),
        entryId: str(p, 'entryId'),
        checkerId: str(p, 'checkerId'),
        procedureName: str(p, 'procedureName'),
        targetPath: optStr(p, 'targetPath'),
        nowIso: optStr(p, 'nowIso'),
      }),
    decide: async (p, rt) =>
      rt.knowledge.decideKnowledgeDisposition.decideKnowledgeDisposition({
        entryId: str(p, 'entryId'),
        disposition: enumOf(p, 'disposition', KNOWLEDGE_DISPOSITIONS, 'knowledge disposition'),
        checkerId: str(p, 'checkerId'),
        reason: str(p, 'reason'),
        nowIso: optStr(p, 'nowIso'),
      }),
    publish: async (p, rt) =>
      rt.knowledge.publishAcceptedKeeper.publishAcceptedKeeper({
        entryId: str(p, 'entryId'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'propose-context': async (p, rt) =>
      rt.knowledge.proposeBriefContext.proposeBriefContext({
        projectId: str(p, 'projectId'),
        laneId: str(p, 'laneId'),
        taskSummary: str(p, 'taskSummary'),
        pathPrefixes: strArr(p, 'pathPrefixes'),
        maxEntries: optNum(p, 'maxEntries'),
        maxTotalChars: optNum(p, 'maxTotalChars'),
      }),
    'select-context': async (p, rt) =>
      rt.knowledge.recordContextSelection.recordContextSelection({
        attemptId: str(p, 'attemptId'),
        selections: nestedArr<RecordContextSelectionItem>(p, 'selections') ?? [],
        nowIso: optStr(p, 'nowIso'),
      }),
    'record-reuse': async (p, rt) =>
      rt.knowledge.recordKnowledgeReuse.recordKnowledgeReuse({
        reuseId: str(p, 'reuseId'),
        entryId: str(p, 'entryId'),
        attemptId: str(p, 'attemptId'),
        outcome: enumOf(p, 'outcome', KNOWLEDGE_REUSE_OUTCOMES, 'knowledge reuse outcome'),
        evidenceRef: optStr(p, 'evidenceRef'),
        nowIso: optStr(p, 'nowIso'),
      }),
    supersede: async (p, rt) =>
      rt.knowledge.supersedeKnowledgeEntry.supersedeKnowledgeEntry({
        olderEntryId: str(p, 'olderEntryId'),
        newerEntryId: str(p, 'newerEntryId'),
        checkerId: str(p, 'checkerId'),
        reason: str(p, 'reason'),
        nowIso: optStr(p, 'nowIso'),
      }),
  },
  coordination: {
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
    'request-decision': async (p, rt) =>
      rt.coordination.requestScopedDecision.requestScopedDecision({
        requestId: str(p, 'requestId'),
        projectId: str(p, 'projectId'),
        kind: enumOf(p, 'kind', COORDINATION_KINDS, 'coordination kind'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: strOrNull(p, 'expectedHeadSha'),
        proposalDigest: str(p, 'proposalDigest'),
        policyRevision: str(p, 'policyRevision'),
        nowIso: optStr(p, 'nowIso'),
      }),
    'resolve-auth': async (p, rt) =>
      rt.coordination.resolveActionAuthorization.resolveActionAuthorization({
        projectId: str(p, 'projectId'),
        actionScope: str(p, 'actionScope'),
        expectedHeadSha: str(p, 'expectedHeadSha'),
        authorizationGrantId: optStr(p, 'authorizationGrantId'),
      }),
    'consume-auth': async (p, rt) =>
      rt.coordination.recordAuthorizationConsumption.recordAuthorizationConsumption({
        consumptionId: str(p, 'consumptionId'),
        grantId: str(p, 'grantId'),
        actionId: str(p, 'actionId'),
        actionKind: str(p, 'actionKind'),
        attemptId: str(p, 'attemptId'),
        expectedHeadSha: str(p, 'expectedHeadSha'),
        nowIso: optStr(p, 'nowIso'),
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
  },
};

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `fleet-v2 — Fleet CLI operator driver across the four bounded contexts.

Usage: fleet-v2 [--state-dir <path>] <command> <subcommand> [--json '<payload>'] [--flag value ...]

Global state option: --state-dir <path> (or the FLEET_STATE_DIR environment
variable) selects the directory that backs durable CLI state; it may appear
in any position, and every store is in-memory when neither is given.

Pass the full typed request as one JSON object with --json, or supply fields
as --kebab-case flags (arrays as comma-separated values). The typed result
prints to stdout as one JSON document.

Commands:
  work-order register|inspect
  brief prepare
  capacity reserve
  attempt dispatch|reconcile|stop|collect|fix|accept
  forge execute
  evidence request-verification|record-verification|request-review|record-review|disposition|assess|inspect
  knowledge capture-notes|check-claim|decide|publish|propose-context|select-context|record-reuse|supersede
  coordination register-profile|capabilities|request-decision|resolve-auth|consume-auth|publish-observation|attention|send-relay|ack-relay|outstanding
  help | --help

Exit codes: 0 completed, 1 refused/rejected/blocked/unknown result, 2 usage error.`;

function groupHelp(group: string): string {
  const subcommands = Object.keys(COMMANDS[group] ?? {}).sort();
  return `Usage: fleet-v2 ${group} <subcommand> [--json '<payload>'] [--flag value ...]\nSubcommands: ${subcommands.join(', ')}\nSee: fleet-v2 --help`;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo,
  runtime?: FleetCliRuntime,
): Promise<number> {
  try {
    const { stateDir, restArgv } = extractStateDirOption(argv, process.env.FLEET_STATE_DIR);
    if (restArgv.length === 0) {
      io.stderr(`${HELP_TEXT}\n`);
      return 2;
    }
    // An explicitly injected runtime stays authoritative; only a call without
    // one composes a fresh runtime bound to the resolved state directory.
    const activeRuntime = runtime ?? createFleetCliRuntime({ stateDir });
    const group = restArgv[0];
    if (group === 'help' || group === '--help' || group === '-h') {
      io.stdout(`${HELP_TEXT}\n`);
      return 0;
    }
    const subcommands = COMMANDS[group];
    if (subcommands === undefined) {
      io.stderr(`Unknown command: ${group}\nRun 'fleet-v2 --help' for the available commands.\n`);
      return 2;
    }
    let subcommand: string | null = null;
    let rest: readonly string[] = [];
    if (restArgv.length > 1 && !restArgv[1].startsWith('--')) {
      subcommand = restArgv[1];
      rest = restArgv.slice(2);
    } else {
      rest = restArgv.slice(1);
    }
    if (subcommand === null) {
      io.stderr(`${groupHelp(group)}\n`);
      return 2;
    }
    const handler = subcommands[subcommand];
    if (handler === undefined) {
      io.stderr(`Unknown ${group} subcommand: ${subcommand}\n${groupHelp(group)}\n`);
      return 2;
    }
    const payload = parseFlags(rest);
    const result = await handler(payload, activeRuntime);
    io.stdout(`${JSON.stringify(result)}\n`);
    return exitCodeForResult(result);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Process entry point. Runs the CLI against the real argument vector and
 * process streams and carries the exit code through `process.exitCode`.
 */
export function main(): void {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
