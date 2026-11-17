/**
 * TrainHealthAttentionAdapter implements TrainHealthAttentionPort by
 * delegating in-process to operator-coordination's record, clear and list
 * attention ports. Summaries are fixed text from ids and codes only. The
 * pass deadline is accepted on a command and never forwarded: the delegate
 * surface has no deadline field, and the caller bounds the await. The
 * adapter keeps no state and never throws.
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  const owner = ownValue(raw, 'owner');
  const repo = ownValue(raw, 'repo');
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
    if (!isPlainObject(raw)) {
      return null;
    }
    const fields = readCommandFields(raw);
    if (fields === null) {
      return null;
    }
    const identity = identityOf(fields.rule, fields.projectId, fields.repository, ownValue(raw, 'pullRequest'));
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
    if (!isPlainObject(raw)) {
      return null;
    }
    const projectId = ownValue(raw, 'projectId');
    if (!validProjectId(projectId)) {
      return null;
    }
    const repository = snapshotRepository(ownValue(raw, 'repository'));
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
    if (!isPlainObject(answer)) {
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
    const item = ownValue(entry, 'item');
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

function itemsFromAnswer(answer: unknown, projectId: string, repository: Repository): ListOpenTrainHealthAttentionResult {
  const entries = ownValue(answer, 'items');
  if (!Array.isArray(entries)) {
    return { outcome: 'unavailable' };
  }
  if (entries.length > LIST_ITEM_CAP) {
    return { outcome: 'unavailable' };
  }
  const items: OpenTrainHealthAttentionItem[] = [];
  for (const entry of entries) {
    const parsed = openItemOf(entry, projectId, repository);
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
      return mapAttentionAnswer(answer, RAISE_OUTCOMES);
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
