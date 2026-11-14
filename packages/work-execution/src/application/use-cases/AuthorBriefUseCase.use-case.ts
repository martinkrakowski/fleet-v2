// Lane CO17: one brief-author seat session per brief.
/**
 * Fact pack, one read-only seat session, `parseBriefAnswer`, `lintBrief`, then
 * only the dispatch text is frozen through `PrepareBriefPackagePort`. Every
 * failure is a typed refusal; the notes text is never passed on, written or
 * returned. Pure application code: no filesystem, no subprocess, no clock, no
 * randomness.
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
import { BRIEF_AUTHOR_SESSION_UNAVAILABLE } from '../ports/out/BriefAuthoringPort.out-port.js';
import type { BriefAuthoringPort, BriefAuthorSessionResult } from '../ports/out/BriefAuthoringPort.out-port.js';

export interface AuthorBriefDependencies {
  readonly factPack: BuildFactPackPort;
  readonly briefAuthoring: BriefAuthoringPort;
  readonly prepareBriefPackage: PrepareBriefPackagePort;
}

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const FACT_PACK_MAX_FACTS = 32;
const FACT_PACK_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'invalid-request',
  'fact-absent',
  'fact-unreadable',
  'fact-oversized',
  'pack-too-large',
  'secret-shaped',
]);

export type AuthorBriefFreezeRefusalDetail =
  | 'acceptance-spec-shell'
  | 'freeze-rejected'
  | 'freeze-outcome-unknown';

const MISSING = Symbol('missing');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Read an own data property: never invokes a getter, never reads a prototype field. */
function readOwnData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
    || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return MISSING;
  }
  return descriptor.value;
}

/** Snapshot an unknown object as a plain record of its own data properties, or null. */
function snapshotPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return null;
  }
  // Defined with `Object.defineProperty`, never by assignment: an own
  // `__proto__` key is stored as a plain data property instead of changing the
  // snapshot's prototype, so no later plain read can hit an inherited field.
  const out: Record<string, unknown> = {};
  // Every own property key, enumerable or not: `Object.keys` would skip a
  // non-enumerable own property such as a hidden `prepare.proseMarkdown`, and
  // the snapshot (and its smuggle check) would then miss it entirely.
  for (const key of Object.getOwnPropertyNames(value)) {
    const read = readOwnData(value, key);
    if (read === MISSING) {
      return null;
    }
    Object.defineProperty(out, key, {
      value: read, enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

type PrepareInput = Omit<PrepareBriefPackageRequest, 'proseMarkdown'>;

/** The request fields, each read exactly once from own data descriptors. */
interface Snapshot {
  readonly workOrderId: string;
  readonly laneId: string;
  readonly repositoryPath: string;
  readonly checkoutPath: string;
  readonly briefsDir: string;
  readonly commit: string;
  readonly facts: readonly BuildFactPackFact[];
  readonly model: string;
  readonly variant: string | undefined;
  readonly agent: string | undefined;
  readonly prepare: PrepareInput;
}

/**
 * Snapshot and validate a runtime request. Returns null when the request is
 * not valid; never throws, never reads a getter or a prototype field.
 */
function snapshotRequest(request: unknown): Snapshot | null {
  const record = snapshotPlainRecord(request);
  if (record === null) {
    return null;
  }
  const workOrderId = record.workOrderId;
  const laneId = record.laneId;
  const repositoryPath = record.repositoryPath;
  const checkoutPath = record.checkoutPath;
  const briefsDir = record.briefsDir;
  const commit = record.commit;
  const facts = record.facts;
  const model = record.model;
  const variant = record.variant;
  const agent = record.agent;
  const prepare = record.prepare;

  if (!isNonEmptyString(workOrderId) || !isSafeId(workOrderId)
    || !isNonEmptyString(laneId) || !isSafeId(laneId)
    || !isNonEmptyString(repositoryPath) || hasControlCharacter(repositoryPath)
    || !isNonEmptyString(checkoutPath) || hasControlCharacter(checkoutPath)
    || !isNonEmptyString(briefsDir) || hasControlCharacter(briefsDir)
    || typeof commit !== 'string' || !COMMIT_PATTERN.test(commit) || hasControlCharacter(commit)
    || !isNonEmptyString(model) || hasControlCharacter(model)) {
    return null;
  }

  if (variant !== undefined && (!isNonEmptyString(variant) || hasControlCharacter(variant))) {
    return null;
  }
  if (agent !== undefined && (!isNonEmptyString(agent) || hasControlCharacter(agent))) {
    return null;
  }

  if (!Array.isArray(facts)) {
    return null;
  }
  if (facts.length < 1 || facts.length > FACT_PACK_MAX_FACTS) {
    return null;
  }
  const copiedFacts: BuildFactPackFact[] = [];
  for (let index = 0; index < facts.length; index += 1) {
    // The element is read through its own data descriptor: an own accessor
    // index would otherwise invoke its getter instead of refusing.
    if (!Object.prototype.hasOwnProperty.call(facts, index)
      || readOwnData(facts as unknown as Record<string, unknown>, String(index)) === MISSING) {
      return null;
    }
    const element = readOwnData(facts as unknown as Record<string, unknown>, String(index));
    const fact = snapshotPlainRecord(element);
    if (fact === null) {
      return null;
    }
    copiedFacts.push(fact as unknown as BuildFactPackFact);
  }

  const prepareRecord = snapshotPlainRecord(prepare);
  if (prepareRecord === null) {
    return null;
  }
  // The prepare must not smuggle proseMarkdown: candidate notes never pass through here.
  if (prepareRecord.proseMarkdown !== undefined) {
    return null;
  }
  if (prepareRecord.workOrderId !== workOrderId
    || prepareRecord.laneId !== laneId
    || prepareRecord.baseCommit !== commit) {
    return null;
  }

  return {
    workOrderId: workOrderId as string,
    laneId: laneId as string,
    repositoryPath: repositoryPath as string,
    checkoutPath: checkoutPath as string,
    briefsDir: briefsDir as string,
    commit: commit as string,
    facts: copiedFacts,
    model: model as string,
    variant: variant === undefined ? undefined : (variant as string),
    agent: agent === undefined ? undefined : (agent as string),
    prepare: prepareRecord as PrepareInput,
  };
}

function mapFreezeRejectionDetail(frozen: unknown): 'acceptance-spec-shell' | 'freeze-rejected' {
  if (isPlainObject(frozen) && readOwnData(frozen, 'outcome') === 'rejected'
    && readOwnData(frozen, 'reasonClass') === 'acceptance-spec-shell') {
    return 'acceptance-spec-shell';
  }
  return 'freeze-rejected';
}

function refusal(reason: AuthorBriefRefusalReason, detail: string, findings?: readonly { rule: string; label: string }[]): AuthorBriefResult {
  return {
    outcome: 'refused',
    refusal: {
      reason,
      detail,
      ...(findings !== undefined ? { findings } : {}),
    },
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
      return refusal('invalid-request', 'request must be a plain object');
    }
    if (snapshot === null) {
      return refusal('invalid-request', 'request must be a plain object');
    }
    try {
      return await this.run(snapshot);
    } catch {
      return refusal('freeze-rejected', 'freeze-outcome-unknown');
    }
  }

  private async run(request: Snapshot): Promise<AuthorBriefResult> {
    const { workOrderId, laneId, commit } = request;

    const authoring = this.briefAuthoring;
    if (typeof authoring.authorBriefSession !== 'function') {
      return refusal('session-unavailable', 'session-command-missing');
    }

    let pack: Awaited<ReturnType<BuildFactPackPort['buildFactPack']>>;
    try {
      pack = await this.factPack.buildFactPack({
        laneId, repositoryPath: request.repositoryPath, commit, facts: request.facts,
      });
    } catch {
      return refusal('fact-pack-refused', 'fact-pack-failed');
    }
    if (!isPlainObject(pack)) {
      return refusal('fact-pack-refused', 'invalid-fact-pack-result');
    }
    if (pack.outcome === 'refused') {
      const rawReason = isPlainObject(pack.refusal) ? readOwnData(pack.refusal, 'reason') : MISSING;
      const reason = typeof rawReason === 'string' && FACT_PACK_REFUSAL_REASONS.has(rawReason)
        ? rawReason
        : 'fact-pack-refused';
      return refusal('fact-pack-refused', reason);
    }
    if (pack.outcome !== 'built' || typeof pack.prompt !== 'string' || pack.prompt.trim().length === 0) {
      return refusal('fact-pack-refused', 'empty-fact-pack-prompt');
    }

    const sessionKey = `brief-author/${workOrderId}/${laneId}@${commit.slice(0, 12)}`;
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
      return refusal('session-unavailable', 'session-failed');
    }
    if (!isPlainObject(session)) {
      return refusal('session-unavailable', 'session-failed');
    }
    if (session.outcome !== 'answered') {
      const reason = typeof session.reason === 'string'
        && (BRIEF_AUTHOR_SESSION_UNAVAILABLE as readonly string[]).includes(session.reason)
        ? session.reason
        : 'session-failed';
      return refusal('session-unavailable', reason);
    }
    if (typeof session.rawAnswer !== 'string' || typeof session.sessionKey !== 'string'
      || session.sessionKey.length === 0) {
      return refusal('session-unavailable', 'session-failed');
    }

    const parsed = parseBriefAnswer(session.rawAnswer);
    if (!parsed.ok) {
      return parsed.reason === 'secret-shaped'
        ? refusal('secret-shaped', 'secret-shaped')
        : refusal('answer-invalid', parsed.reason);
    }

    const lint = lintBrief(parsed.dispatch);
    if (!lint.ok) {
      const secret = lint.findings.some((finding) => finding.rule === 'secret-shaped');
      if (secret) {
        return refusal('secret-shaped', 'secret-shaped', lint.findings);
      }
      return refusal(
        'brief-lint-failed',
        lint.findings.map((finding) => finding.rule).join(', '),
        lint.findings,
      );
    }

    // Only the dispatch text is frozen: the notes never leave `parsed`.
    // If `prepareBriefPackage` throws after writing the brief, the outcome is
    // uncertain/unknown rather than `invalid-request` or a clean pre-write rejection.
    let frozen: Awaited<ReturnType<PrepareBriefPackagePort['prepareBriefPackage']>>;
    try {
      frozen = await this.prepareBriefPackage.prepareBriefPackage({
        ...request.prepare,
        proseMarkdown: parsed.dispatch,
      });
    } catch {
      return refusal('freeze-rejected', 'freeze-outcome-unknown');
    }
    if (!isPlainObject(frozen) || readOwnData(frozen, 'outcome') !== 'prepared'
      || !isPlainObject(readOwnData(frozen, 'prepared'))
      || frozen.outcome !== 'prepared') {
      return refusal('freeze-rejected', mapFreezeRejectionDetail(frozen));
    }

    return { outcome: 'authored', sessionKey: session.sessionKey, prepared: frozen.prepared };
  }
}
