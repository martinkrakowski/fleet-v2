/**
 * TrainHealthAttentionAdapter implements TrainHealthAttentionPort by
 * delegating in-process to operator-coordination's record, clear and list
 * attention ports. Summaries are fixed text from ids and codes only. The
 * pass deadline is accepted on a command and never forwarded: the delegate
 * surface has no deadline field, and the caller bounds the await. The
 * adapter keeps no state and never throws.
 *
 * A raise answer's `previousRaisedAtIso` is read from that same delegate
 * answer, which the delegate produces inside its own locked read-modify-write:
 * the stored `lastRaisedAtIso` captured immediately before the overwrite, a
 * zoned ISO string exactly as stored and never re-formatted. The adapter makes
 * no second read of its own. It is null only when the outcome is `raised` (no
 * prior open or closed record). For `refreshed` and `reopened` the answer must
 * carry `previousRaisedAtIso` as a zoned ISO string — a prior record existed,
 * so there is a stored time — returned exactly as stored and never
 * re-formatted. On every success outcome the answer must
 * carry `previousRaisedAtIso` as an own data property: exactly `null` for
 * `raised`, and a zoned ISO string for `refreshed` and `reopened`; anything
 * else, including null on a refreshed or reopened answer, is a failed raise,
 * and the adapter never synthesizes a value.
 *
 * Project-scoped items use subject `{ kind: 'project', ref: projectId }`
 * because that store subject cannot carry owner/repo. A list keeps such an
 * item only when its fixed summary names this repository.
 */

import { containsSecretShape } from '@fleet/shared';

import type {
  ClearTrainHealthAttentionResult,
  ListOpenTrainHealthAttentionResult,
  OpenTrainHealthAttentionItem,
  RaiseTrainHealthAttentionResult,
  TrainHealthAttentionCommand,
  TrainHealthAttentionPort,
  TrainHealthAttentionRule,
} from '../../application/ports/out/TrainHealthAttentionPort.out-port.js';
import { TRAIN_HEALTH_ATTENTION_RULES } from '../../application/ports/out/TrainHealthAttentionPort.out-port.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { readExactPlainRecord } from '../../domain/plain-record-reads.js';
import { isPlainRecordObject } from '../../domain/record-schema-version.js';

/** The actor train-health items are raised and resolved as. */
export const TRAIN_HEALTH_ATTENTION_ACTOR = 'train-watchdog';

/** Supplier-side delegates; the composition root binds the real use cases. */
export interface TrainHealthAttentionDelegate {
  readonly recordAttentionItem?: (body: unknown, actor: string) => Promise<unknown>;
  readonly clearAttentionItem?: (request: unknown, via: string, actor: string) => Promise<unknown>;
  readonly listAttentionItems?: (request: {
    readonly projectId?: string;
    readonly state: 'open';
  }) => Promise<unknown>;
}

const CLEAR_VIA = 'machine';
const LIST_ITEM_CAP = 5000;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const PULL_REQUEST_SUFFIX_PATTERN = /^[1-9][0-9]{0,9}$/;

const PROJECT_SCOPED_RULES: readonly TrainHealthAttentionRule[] = [
  'tick-stale',
  'stalled-head',
  'watchdog-blind',
  'findings-truncated',
  'queue-too-large',
];

const PULL_REQUEST_RULES: readonly TrainHealthAttentionRule[] = ['stale-queue-entry', 'repeated-park'];

const RAISE_OUTCOMES = ['raised', 'refreshed', 'reopened'] as const;
const CLEAR_OUTCOMES = ['cleared', 'unchanged', 'not-found'] as const;

interface Repository {
  readonly owner: string;
  readonly repo: string;
}

interface AttentionIdentity {
  readonly kind: string;
  readonly subject: { readonly kind: string; readonly ref: string };
  readonly summary: string;
}

interface CommandFields {
  readonly projectId: string;
  readonly repository: Repository;
  readonly rule: TrainHealthAttentionRule;
}

interface Snapshot extends CommandFields, AttentionIdentity {}

interface ListQuery {
  readonly projectId: string;
  readonly repository: Repository;
}

type MappedAnswer<T extends string> =
  | { readonly outcome: T; readonly reasonCode: null }
  | { readonly outcome: 'refused'; readonly reasonCode: string };

type Unreadable = { readonly outcome: 'refused'; readonly reasonCode: 'unreadable' };

/** An own data property only: an accessor reads as undefined and never runs. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) {
    return undefined;
  }
  return descriptor.value;
}

function isSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    REPOSITORY_SEGMENT_PATTERN.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function snapshotRepository(raw: unknown): Repository | null {
  // Exact-key read: class instances and custom-prototype objects are refused,
  // and no extra own key is tolerated on a repository.
  const exact = readExactPlainRecord(raw, ['owner', 'repo']);
  if (exact === null) {
    return null;
  }
  const owner = exact.owner;
  const repo = exact.repo;
  if (isSegment(owner) && isSegment(repo)) {
    return { owner, repo };
  }
  return null;
}

function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value) && !containsSecretShape(value);
}

/** Any string is accepted. The value is never copied into a delegate call. */
function deadlineAccepted(value: unknown): value is string {
  return typeof value === 'string';
}

function isAttentionRule(value: unknown): value is TrainHealthAttentionRule {
  return typeof value === 'string' && (TRAIN_HEALTH_ATTENTION_RULES as readonly string[]).includes(value);
}

function isProjectScoped(rule: string): boolean {
  return (PROJECT_SCOPED_RULES as readonly string[]).includes(rule);
}

function isPullRequestRule(rule: string): boolean {
  return (PULL_REQUEST_RULES as readonly string[]).includes(rule);
}

function isSafePullRequest(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function repoLabel(repository: Repository): string {
  return `${repository.owner}/${repository.repo}`;
}

function attentionKind(rule: string): string {
  return `train-${rule}`;
}

function projectSummary(rule: string, repository: Repository): string {
  return `train-health:${rule} repo=${repoLabel(repository)}`;
}

function pullRequestSummary(rule: string, repository: Repository, pullRequest: number): string {
  return `train-health:${rule} repo=${repoLabel(repository)} pr=${pullRequest}`;
}

function projectIdentity(
  rule: string,
  projectId: string,
  repository: Repository,
  pullRequest: unknown,
): AttentionIdentity | null {
  if (pullRequest !== null) {
    return null;
  }
  return {
    kind: attentionKind(rule),
    subject: { kind: 'project', ref: projectId },
    summary: projectSummary(rule, repository),
  };
}

function pullRequestIdentity(rule: string, repository: Repository, pullRequest: unknown): AttentionIdentity | null {
  if (!isSafePullRequest(pullRequest)) {
    return null;
  }
  const label = repoLabel(repository);
  return {
    kind: attentionKind(rule),
    subject: { kind: 'pr', ref: `${label}#${pullRequest}` },
    summary: pullRequestSummary(rule, repository, pullRequest),
  };
}

/** Kind, subject and summary for one rule, or null when the pull request does not fit that rule. */
function identityOf(
  rule: string,
  projectId: string,
  repository: Repository,
  pullRequest: unknown,
): AttentionIdentity | null {
  if (isProjectScoped(rule)) {
    return projectIdentity(rule, projectId, repository, pullRequest);
  }
  if (isPullRequestRule(rule)) {
    return pullRequestIdentity(rule, repository, pullRequest);
  }
  return null;
}

function readCommandFields(raw: Record<string, unknown>): CommandFields | null {
  const projectId = ownValue(raw, 'projectId');
  if (!validProjectId(projectId)) {
    return null;
  }
  const repository = snapshotRepository(ownValue(raw, 'repository'));
  if (repository === null) {
    return null;
  }
  const deadlineIso = ownValue(raw, 'deadlineIso');
  if (!deadlineAccepted(deadlineIso)) {
    return null;
  }
  const rule = ownValue(raw, 'rule');
  if (!isAttentionRule(rule)) {
    return null;
  }
  return { projectId, repository, rule };
}

/**
 * Copy the command from its own data properties, or null when it is malformed.
 * Never throws and never runs an accessor. `deadlineIso` is required and then dropped.
 */
function snapshotCommand(raw: unknown): Snapshot | null {
  try {
    // Exact-key read: the command carries exactly these five own keys (a
    // project-scoped rule carries `pullRequest: null`), so a class instance, a
    // custom-prototype object or any extra key is refused.
    const exact = readExactPlainRecord(raw, ['projectId', 'repository', 'deadlineIso', 'rule', 'pullRequest']);
    if (exact === null) {
      return null;
    }
    const fields = readCommandFields(exact);
    if (fields === null) {
      return null;
    }
    const identity = identityOf(fields.rule, fields.projectId, fields.repository, exact.pullRequest);
    if (identity === null) {
      return null;
    }
    return { ...fields, ...identity };
  } catch {
    return null;
  }
}

function snapshotListQuery(raw: unknown): ListQuery | null {
  try {
    // Exact-key read: the query carries exactly these three own keys.
    const exact = readExactPlainRecord(raw, ['projectId', 'repository', 'deadlineIso']);
    if (exact === null) {
      return null;
    }
    const projectId = exact.projectId;
    if (!validProjectId(projectId)) {
      return null;
    }
    const repository = snapshotRepository(exact.repository);
    if (repository === null) {
      return null;
    }
    return { projectId, repository };
  } catch {
    return null;
  }
}

function refusedUnreadable(): Unreadable {
  return { outcome: 'refused', reasonCode: 'unreadable' };
}

function acceptsOutcome<T extends string>(accepted: readonly T[], outcome: string): outcome is T {
  return (accepted as readonly string[]).includes(outcome);
}

function refusedWithCode(code: unknown): { readonly outcome: 'refused'; readonly reasonCode: string } {
  if (typeof code !== 'string') {
    return refusedUnreadable();
  }
  return { outcome: 'refused', reasonCode: code };
}

/** Map one raise or clear answer. `accepted` is the success outcomes for that call. */
function mapAttentionAnswer<T extends string>(answer: unknown, accepted: readonly T[]): MappedAnswer<T> {
  try {
    // A plain record object, but not exact-key: a delegate answer may carry
    // additional own fields (e.g. a refusal `reason`). A class instance or a
    // custom-prototype object is refused as unreadable.
    if (!isPlainRecordObject(answer)) {
      return refusedUnreadable();
    }
    const outcome = ownValue(answer, 'outcome');
    if (typeof outcome === 'string' && acceptsOutcome(accepted, outcome)) {
      return { outcome, reasonCode: null };
    }
    if (outcome === 'refused') {
      return refusedWithCode(ownValue(answer, 'code'));
    }
    return refusedUnreadable();
  } catch {
    return refusedUnreadable();
  }
}

/**
 * The raise answer's `previousRaisedAtIso`, read under the delegate's lock as
 * part of the same answer that raised the item. Every success outcome must
 * carry it as an own data property: exactly `null` for `raised` (no prior
 * record), and a zoned ISO string for `refreshed` and `reopened` (a prior
 * record existed, so a stored time does), returned exactly as stored. A
 * missing, accessor-backed, wrong-typed or null field on a refreshed or
 * reopened answer is a failed raise, never synthesized. Never re-formatted,
 * never throws.
 */
function previousRaisedAtIsoOf(answer: unknown): { readonly ok: true; readonly value: string | null } | { readonly ok: false } {
  try {
    const value = ownValue(answer, 'previousRaisedAtIso');
    if (value === null) {
      return { ok: true, value: null };
    }
    if (isZonedIsoDateTime(value)) {
      return { ok: true, value };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Map one raise answer, adding `previousRaisedAtIso` from the same answer. */
function mapRaiseAnswer(answer: unknown): RaiseTrainHealthAttentionResult {
  const mapped = mapAttentionAnswer(answer, RAISE_OUTCOMES);
  if (mapped.outcome === 'refused') {
    return mapped;
  }
  const previous = previousRaisedAtIsoOf(answer);
  if (!previous.ok) {
    return refusedUnreadable();
  }
  if (mapped.outcome === 'raised') {
    // `raised` means no prior record: the contract requires exactly `null`,
    // never a timestamp masquerading as a first raise.
    if (previous.value !== null) {
      return refusedUnreadable();
    }
    return { ...mapped, previousRaisedAtIso: null };
  }
  // `refreshed` and `reopened` mean a prior open or closed record existed, so
  // the answer must carry its stored last-raise time; null is a failed raise.
  if (previous.value === null) {
    return refusedUnreadable();
  }
  return { ...mapped, previousRaisedAtIso: previous.value };
}

function raiseBody(command: Snapshot): {
  readonly projectId: string;
  readonly kind: string;
  readonly subject: AttentionIdentity['subject'];
  readonly workOrderId: null;
  readonly summary: string;
} {
  return {
    projectId: command.projectId,
    kind: command.kind,
    subject: command.subject,
    workOrderId: null,
    summary: command.summary,
  };
}

function clearRequest(command: Snapshot): {
  readonly action: 'resolve';
  readonly projectId: string;
  readonly kind: string;
  readonly subject: AttentionIdentity['subject'];
  readonly reason: 'resolved';
} {
  return {
    action: 'resolve',
    projectId: command.projectId,
    kind: command.kind,
    subject: command.subject,
    reason: 'resolved',
  };
}

function ruleFromKind(kind: unknown): TrainHealthAttentionRule | null {
  if (typeof kind !== 'string' || !kind.startsWith('train-')) {
    return null;
  }
  const rule = kind.slice('train-'.length);
  if (!isAttentionRule(rule)) {
    return null;
  }
  return rule;
}

/** `null` is a project-scoped item; `undefined` means the entry does not match. */
function projectPullRequest(
  rule: string,
  subject: unknown,
  projectId: string,
  repository: Repository,
  item: unknown,
): null | undefined {
  const subjectKind = ownValue(subject, 'kind');
  const ref = ownValue(subject, 'ref');
  if (subjectKind !== 'project' || ref !== projectId) {
    return undefined;
  }
  if (ownValue(item, 'summary') !== projectSummary(rule, repository)) {
    return undefined;
  }
  return null;
}

function prNumber(ref: string, repository: Repository): number | undefined {
  const prefix = `${repoLabel(repository)}#`;
  if (!ref.startsWith(prefix)) {
    return undefined;
  }
  const suffix = ref.slice(prefix.length);
  if (!PULL_REQUEST_SUFFIX_PATTERN.test(suffix)) {
    return undefined;
  }
  return Number(suffix);
}

function prPullRequest(subject: unknown, repository: Repository): number | undefined {
  const subjectKind = ownValue(subject, 'kind');
  const ref = ownValue(subject, 'ref');
  if (subjectKind !== 'pr' || typeof ref !== 'string') {
    return undefined;
  }
  return prNumber(ref, repository);
}

function pullRequestFor(
  rule: TrainHealthAttentionRule,
  subject: unknown,
  projectId: string,
  repository: Repository,
  item: unknown,
): number | null | undefined {
  if (isProjectScoped(rule)) {
    return projectPullRequest(rule, subject, projectId, repository, item);
  }
  if (isPullRequestRule(rule)) {
    return prPullRequest(subject, repository);
  }
  return undefined;
}

function screenedRule(item: unknown, projectId: string): TrainHealthAttentionRule | null {
  if (ownValue(item, 'projectId') !== projectId) {
    return null;
  }
  return ruleFromKind(ownValue(item, 'kind'));
}

/** One open item for this repository, or null when the entry is foreign or malformed. */
function openItemOf(entry: unknown, projectId: string, repository: Repository): OpenTrainHealthAttentionItem | null {
  try {
    // Plain record object, not exact-key: a list entry may carry additional
    // own fields; a class instance or custom prototype is malformed.
    if (!isPlainRecordObject(entry)) {
      return null;
    }
    const item = ownValue(entry, 'item');
    if (!isPlainRecordObject(item)) {
      return null;
    }
    const rule = screenedRule(item, projectId);
    if (rule === null) {
      return null;
    }
    const pullRequest = pullRequestFor(rule, ownValue(item, 'subject'), projectId, repository, item);
    if (pullRequest === undefined) {
      return null;
    }
    const lastRaisedAtIso = ownValue(item, 'lastRaisedAtIso');
    if (!isZonedIsoDateTime(lastRaisedAtIso)) {
      return null;
    }
    return { rule, pullRequest, lastRaisedAtIso };
  } catch {
    return null;
  }
}

/**
 * The capped element list of a real, dense array, or null for any stand-in:
 * a non-array, a subclassed or custom-prototype array, an array with an
 * accessor `length`, an oversized array, a sparse array (a hole) or an array
 * carrying an extra own enumerable property such as a getter planted beside
 * the indices. `Object.keys` lists own enumerable string keys without
 * reading any value, so comparing its count to the descriptor `length`
 * refuses a hole or a planted extra key before a single element is read.
 * The length is read from its own data descriptor, so no iterator, getter or
 * `length` property read ever runs.
 */
function boundedEntryList(value: unknown): readonly unknown[] | null {
  // `Array.isArray` follows a Proxy without running a trap.
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    lengthDescriptor.value > LIST_ITEM_CAP
  ) {
    return null;
  }
  if (Object.keys(value).length !== lengthDescriptor.value) {
    return null;
  }
  return value as readonly unknown[];
}

/** The own enumerable data-property element at `index`; undefined for a hole or an accessor. */
function ownEntryElement(array: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

function itemsFromAnswer(answer: unknown, projectId: string, repository: Repository): ListOpenTrainHealthAttentionResult {
  // Plain record object, not exact-key: the answer may carry additional own
  // fields; a class instance or custom prototype is unavailable.
  if (!isPlainRecordObject(answer)) {
    return { outcome: 'unavailable' };
  }
  const entries = boundedEntryList(ownValue(answer, 'items'));
  if (entries === null) {
    return { outcome: 'unavailable' };
  }
  const items: OpenTrainHealthAttentionItem[] = [];
  // Indexed descriptor reads, never `for...of`: no iterator is ever fetched,
  // and the dense-array check above refuses holes instead of skipping them.
  const entryCount = entries.length;
  for (let index = 0; index < entryCount; index += 1) {
    const parsed = openItemOf(ownEntryElement(entries, index), projectId, repository);
    if (parsed !== null) {
      items.push(parsed);
    }
  }
  return { outcome: 'found', items };
}

export class TrainHealthAttentionAdapter implements TrainHealthAttentionPort {
  constructor(private readonly delegate?: TrainHealthAttentionDelegate) {}

  async raiseTrainHealthAttention(raw: TrainHealthAttentionCommand): Promise<RaiseTrainHealthAttentionResult> {
    const command = snapshotCommand(raw);
    if (command === null) {
      return { outcome: 'refused', reasonCode: 'invalid-request' };
    }
    try {
      const recordAttentionItem = this.delegate?.recordAttentionItem;
      if (recordAttentionItem === undefined) {
        return { outcome: 'refused', reasonCode: 'not-configured' };
      }
      const answer = await recordAttentionItem(raiseBody(command), TRAIN_HEALTH_ATTENTION_ACTOR);
      return mapRaiseAnswer(answer);
    } catch {
      return refusedUnreadable();
    }
  }

  async clearTrainHealthAttention(raw: TrainHealthAttentionCommand): Promise<ClearTrainHealthAttentionResult> {
    const command = snapshotCommand(raw);
    if (command === null) {
      return { outcome: 'refused', reasonCode: 'invalid-request' };
    }
    try {
      const clearAttentionItem = this.delegate?.clearAttentionItem;
      if (clearAttentionItem === undefined) {
        return { outcome: 'refused', reasonCode: 'not-configured' };
      }
      const answer = await clearAttentionItem(clearRequest(command), CLEAR_VIA, TRAIN_HEALTH_ATTENTION_ACTOR);
      return mapAttentionAnswer(answer, CLEAR_OUTCOMES);
    } catch {
      return refusedUnreadable();
    }
  }

  async listOpenTrainHealthAttention(rawQuery: {
    readonly projectId: string;
    readonly repository: { readonly owner: string; readonly repo: string };
    readonly deadlineIso: string;
  }): Promise<ListOpenTrainHealthAttentionResult> {
    const query = snapshotListQuery(rawQuery);
    try {
      const listAttentionItems = this.delegate?.listAttentionItems;
      if (query === null || listAttentionItems === undefined) {
        return { outcome: 'unavailable' };
      }
      const answer = await listAttentionItems({ projectId: query.projectId, state: 'open' });
      return itemsFromAnswer(answer, query.projectId, query.repository);
    } catch {
      return { outcome: 'unavailable' };
    }
  }
}
