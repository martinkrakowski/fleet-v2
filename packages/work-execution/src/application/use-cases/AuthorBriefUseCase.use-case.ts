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
import type { BriefAuthoringPort, BriefAuthorSessionResult } from '../ports/out/BriefAuthoringPort.out-port.js';

export interface AuthorBriefDependencies {
  readonly factPack: BuildFactPackPort;
  readonly briefAuthoring: BriefAuthoringPort;
  readonly prepareBriefPackage: PrepareBriefPackagePort;
}

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const FACT_KINDS: ReadonlySet<string> = new Set(['file-list', 'file-range', 'matching-lines']);

const INVALID_REQUEST: AuthorBriefResult = { outcome: 'refused', reason: 'invalid-request', detail: null };

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
    let session: BriefAuthorSessionResult;
    try {
      session = await authoring.authorBriefSession({
        sessionKey, workOrderId, laneId, baseCommit: commit,
        checkoutPath: request.checkoutPath, briefsDir: request.briefsDir,
        prompt: pack.prompt, model: request.model,
        ...(request.variant !== undefined ? { variant: request.variant } : {}),
        ...(request.agent !== undefined ? { agent: request.agent } : {}),
      });
    } catch {
      return { outcome: 'unknown', reason: 'seat-call-failed' };
    }
    if (session.outcome !== 'answered') {
      return refuse('seat-unavailable', session.reason);
    }
    if (typeof session.answer !== 'string' || session.answer.trim().length === 0) {
      return refuse('seat-unavailable', 'session-empty');
    }

    const parsed = parseBriefAnswer(session.answer);
    if (!parsed.ok) {
      return parsed.reason === 'secret-shaped'
        ? refuse('secret-shaped', null)
        : refuse('parse-violation', parsed.reason);
    }
    const lint = lintBrief(parsed.dispatch);
    if (!lint.ok) {
      return refuse('lint-violation', lint.findings[0]?.rule ?? null);
    }

    // Only the dispatch text is frozen: the notes never leave `parsed`.
    let frozen: Awaited<ReturnType<PrepareBriefPackagePort['prepareBriefPackage']>>;
    try {
      frozen = await this.prepareBriefPackage.prepareBriefPackage({ ...request.prepare, proseMarkdown: parsed.dispatch });
    } catch {
      return { outcome: 'unknown', reason: 'session-outcome-unknown' };
    }
    if (frozen.outcome !== 'prepared') {
      return refuse('freeze-rejected', frozen.reasonClass ?? null);
    }
    return {
      outcome: 'authored',
      attemptId: frozen.prepared.attemptId,
      briefDigest: frozen.prepared.briefDigest,
      sessionKey,
    };
  }
}
