// Lane CO17: one brief-author seat session per brief.
/**
 * Fact pack, one read-only seat session, `parseBriefAnswer`, `lintBrief`, then
 * only the dispatch text is frozen through `PrepareBriefPackagePort`. Every
 * failure is a typed refusal or an unknown outcome carrying ids and codes
 * only; the notes text is never passed on, written or returned. Pure
 * application code: no filesystem, no subprocess, no clock, no randomness.
 */

import { lintBrief, parseBriefAnswer } from '../../domain/brief-answer.js';
import type {
  AuthorBriefPort,
  AuthorBriefRefusalReason,
  AuthorBriefRequest,
  AuthorBriefResult,
} from '../ports/in/AuthorBriefPort.in-port.js';
import type { BuildFactPackFact, BuildFactPackPort } from '../ports/in/BuildFactPackPort.in-port.js';
import type { PrepareBriefPackagePort, PrepareBriefPackageRequest } from '../ports/in/PrepareBriefPackagePort.in-port.js';
import type { BriefAuthoringPort, BriefAuthorSessionRequest, BriefAuthorSessionResult } from '../ports/out/BriefAuthoringPort.out-port.js';

export interface AuthorBriefDependencies {
  readonly factPack: BuildFactPackPort;
  readonly briefAuthoring: BriefAuthoringPort;
  readonly prepareBriefPackage: PrepareBriefPackagePort;
}

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const FACT_KINDS: ReadonlySet<string> = new Set(['file-list', 'file-range', 'matching-lines']);

const INVALID_REQUEST: AuthorBriefResult = { outcome: 'refused', reason: 'invalid-request', detail: null };

const RETRY_INSTRUCTION = 'Begin your answer with the ===NOTES=== marker line and put no text before it.';

type SeatAttempt =
  | { readonly ok: true; readonly parsed: { dispatch: string; notes: string } }
  | { readonly ok: false; readonly result: AuthorBriefResult; readonly code: string; readonly retryable: boolean };

/** Attach the failed-attempt codes to a result that follows a retry. */
function withFailedAttempts(result: AuthorBriefResult, failedAttempts: readonly string[]): AuthorBriefResult {
  return { ...result, failedAttempts };
}

function refuse(reason: AuthorBriefRefusalReason, detail: string | null): AuthorBriefResult {
  return { outcome: 'refused', reason, detail };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type PrepareInput = Omit<PrepareBriefPackageRequest, 'proseMarkdown'>;

/** The request fields, each read exactly once, so a getter cannot answer twice. */
interface Snapshot {
  readonly workOrderId: string;
  readonly laneId: string;
  readonly prepare: PrepareInput;
  readonly repositoryPath: string;
  readonly commit: string;
  readonly facts: readonly BuildFactPackFact[];
  readonly model: string;
  readonly variant: string | undefined;
  readonly agent: string | undefined;
  readonly checkoutPath: string;
  readonly briefsDir: string;
}

/** Snapshot and validate a runtime request; null when it is not a valid request. Throws only on a hostile getter. */
function snapshotRequest(request: unknown): Snapshot | null {
  if (typeof request !== 'object' || request === null) {
    return null;
  }
  const { workOrderId, laneId, prepare, factPack, seat, checkoutPath, briefsDir } = request as Record<string, unknown>;
  if (!isNonEmptyString(workOrderId) || !isNonEmptyString(laneId)
    || !isNonEmptyString(checkoutPath) || !isNonEmptyString(briefsDir)
    || !isPlainObject(prepare) || !isPlainObject(factPack) || !isPlainObject(seat)) {
    return null;
  }
  const { repositoryPath, commit, facts } = factPack;
  const { model, variant, agent } = seat;
  if (!isNonEmptyString(repositoryPath) || typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)
    || !Array.isArray(facts) || !isNonEmptyString(model) || !isOptionalString(variant) || !isOptionalString(agent)) {
    return null;
  }
  const copied: BuildFactPackFact[] = [];
  for (let index = 0; index < facts.length; index += 1) {
    const fact: unknown = facts[index];
    if (!isPlainObject(fact) || typeof fact.kind !== 'string' || !FACT_KINDS.has(fact.kind)
      || typeof fact.label !== 'string') {
      return null;
    }
    copied.push(fact as unknown as BuildFactPackFact);
  }
  if (prepare.workOrderId !== workOrderId || prepare.laneId !== laneId || prepare.baseCommit !== commit) {
    return null;
  }
  return {
    workOrderId, laneId, repositoryPath, commit, facts: copied, model, variant, agent, checkoutPath, briefsDir,
    prepare: prepare as unknown as PrepareInput,
  };
}

export class AuthorBriefUseCase implements AuthorBriefPort {
  private readonly factPack: BuildFactPackPort;
  private readonly briefAuthoring: BriefAuthoringPort;
  private readonly prepareBriefPackage: PrepareBriefPackagePort;

  public constructor(dependencies: AuthorBriefDependencies) {
    this.factPack = dependencies.factPack;
    this.briefAuthoring = dependencies.briefAuthoring;
    this.prepareBriefPackage = dependencies.prepareBriefPackage;
  }

  public async authorBrief(request: AuthorBriefRequest): Promise<AuthorBriefResult> {
    let snapshot: Snapshot | null;
    try {
      snapshot = snapshotRequest(request);
    } catch {
      return INVALID_REQUEST;
    }
    if (snapshot === null) {
      return INVALID_REQUEST;
    }
    return this.run(snapshot);
  }

  /** One seat session and its typed mapping; every failure carries its code and whether it alone permits a retry. */
  private async askSeat(
    seat: (r: BriefAuthorSessionRequest) => Promise<BriefAuthorSessionResult>,
    request: Snapshot,
    sessionKey: string,
    prompt: string,
    retry: boolean,
  ): Promise<SeatAttempt> {
    const { workOrderId, laneId, commit } = request;
    let session: BriefAuthorSessionResult;
    try {
      session = await seat({
        sessionKey, workOrderId, laneId, baseCommit: commit,
        checkoutPath: request.checkoutPath, briefsDir: request.briefsDir,
        prompt, model: request.model,
        ...(request.variant !== undefined ? { variant: request.variant } : {}),
        ...(request.agent !== undefined ? { agent: request.agent } : {}),
        ...(retry ? { retry: true as const } : {}),
      });
    } catch {
      return { ok: false, result: { outcome: 'unknown', reason: 'seat-call-failed' }, code: 'seat-call-failed', retryable: false };
    }
    if (session.outcome !== 'answered') {
      return { ok: false, result: refuse('seat-unavailable', session.reason), code: session.reason, retryable: false };
    }
    if (typeof session.answer !== 'string' || session.answer.trim().length === 0) {
      return { ok: false, result: refuse('seat-unavailable', 'session-empty'), code: 'session-empty', retryable: false };
    }
    const parsed = parseBriefAnswer(session.answer);
    if (!parsed.ok) {
      return parsed.reason === 'secret-shaped'
        ? { ok: false, result: refuse('secret-shaped', null), code: 'secret-shaped', retryable: false }
        : {
            ok: false,
            result: refuse('parse-violation', parsed.reason),
            code: parsed.reason,
            retryable: parsed.reason === 'text-before-notes-marker',
          };
    }
    return { ok: true, parsed: { dispatch: parsed.dispatch, notes: parsed.notes } };
  }

  private async run(request: Snapshot): Promise<AuthorBriefResult> {
    const { workOrderId, laneId, commit } = request;

    let pack: Awaited<ReturnType<BuildFactPackPort['buildFactPack']>>;
    try {
      pack = await this.factPack.buildFactPack({
        laneId, repositoryPath: request.repositoryPath, commit, facts: request.facts,
      });
    } catch {
      return refuse('fact-pack-refused', 'invalid-request');
    }
    if (pack.outcome !== 'built') {
      return refuse('fact-pack-refused', pack.refusal.reason);
    }

    const sessionKey = `brief-author/${workOrderId}/${laneId}@${commit.slice(0, 12)}`;
    const authoring = this.briefAuthoring;
    if (authoring.authorBriefSession === undefined) {
      return refuse('seat-unavailable', 'session-not-supported');
    }
    const seat = authoring.authorBriefSession.bind(authoring);
    let attempt = await this.askSeat(seat, request, sessionKey, pack.prompt, false);
    let failedAttempts: readonly string[] = [];
    let answeredKey = sessionKey;
    if (!attempt.ok && attempt.retryable) {
      const first = attempt.code;
      const second = await this.askSeat(seat, request, `${sessionKey}/retry`, `${pack.prompt}\n${RETRY_INSTRUCTION}`, true);
      failedAttempts = second.ok ? [first] : [first, second.code];
      answeredKey = `${sessionKey}/retry`;
      attempt = second;
    }
    if (!attempt.ok) {
      return failedAttempts.length > 0 ? withFailedAttempts(attempt.result, failedAttempts) : attempt.result;
    }
    const parsed = attempt.parsed;
    const tag = (result: AuthorBriefResult): AuthorBriefResult =>
      failedAttempts.length > 0 ? withFailedAttempts(result, failedAttempts) : result;

    const lint = lintBrief(parsed.dispatch);
    if (!lint.ok) {
      return tag(refuse('lint-violation', lint.findings[0]?.rule ?? null));
    }

    // Only the dispatch text is frozen: the notes never leave `parsed`.
    let frozen: Awaited<ReturnType<PrepareBriefPackagePort['prepareBriefPackage']>>;
    try {
      frozen = await this.prepareBriefPackage.prepareBriefPackage({ ...request.prepare, proseMarkdown: parsed.dispatch });
    } catch {
      return tag({ outcome: 'unknown', reason: 'session-outcome-unknown' });
    }
    if (frozen.outcome !== 'prepared') {
      return tag(refuse('freeze-rejected', frozen.reasonClass ?? null));
    }
    return tag({
      outcome: 'authored',
      attemptId: frozen.prepared.attemptId,
      briefDigest: frozen.prepared.briefDigest,
      sessionKey: answeredKey,
    });
  }
}
