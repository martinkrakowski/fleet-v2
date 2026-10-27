// @generated entity stub — refined for lane WB3a-1.
/**
 * OwnerItem is a pure domain aggregate for one entry on the owner's to-do on
 * the work board (plan §3.3): a merge, secret, decision, backup or other
 * item with typed refs, OwnerQuestion-shaped blocks and an optional plain-text
 * subject. It is its own aggregate — never a CoordinationKind — and grants
 * nothing. Validation and transitions return a result
 * (`{ success: true, value } | { success: false, error, code }`), never
 * throw, and never echo an input value; secret-shaped text is refused.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { plainArrayCopy, readPlainObject, readPlainObjectWithOptional } from '../record-input.js';
import {
  OWNER_ITEM_GATING_KINDS,
  OWNER_ITEM_OWNER_CLOSABLE_KINDS,
  OwnerItemKind,
} from '../value-objects/OwnerItemKind.vo.js';
import type { OwnerItemKindValue } from '../value-objects/OwnerItemKind.vo.js';
import {
  OWNER_ITEM_DECISION_ID_PATTERN,
  OWNER_ITEM_LANE_ID_PATTERN,
  OWNER_ITEM_LIMITS,
  OWNER_ITEM_PLAN_ID_PATTERN,
  OWNER_ITEM_PROJECT_ID_PATTERN,
  OWNER_ITEM_RESOLUTION_KINDS,
  OWNER_ITEM_RESOLUTIONS_BY_KIND,
  OWNER_ITEM_STATES,
  OWNER_ITEM_WITHDRAW_REASONS,
} from '../owner-item-records.js';
import type {
  OwnerItemBlockRecord,
  OwnerItemDoneVia,
  OwnerItemHistoryEntryRecord,
  OwnerItemRecord,
  OwnerItemRefRecord,
  OwnerItemResolutionKind,
  OwnerItemResolutionRecord,
  OwnerItemState,
  OwnerItemWithdrawalRecord,
  OwnerItemWithdrawReason,
} from '../owner-item-records.js';

export type OwnerItemRefusalCode = 'invalid' | 'kind' | 'state' | 'source' | 'no-choice' | 'clock';
export type OwnerItemResult =
  | { readonly success: true; readonly value: OwnerItem }
  | { readonly success: false; readonly error: Error; readonly code: OwnerItemRefusalCode };

const RECORD_KEYS: readonly string[] = [
  'version',
  'itemId',
  'projectId',
  'kind',
  'subject',
  'refs',
  'blocks',
  'createdAtIso',
  'createdBy',
  'state',
  'resolution',
  'withdrawal',
  'history',
];

const OPEN_KEYS: readonly string[] = ['itemId', 'projectId', 'kind', 'subject', 'refs', 'blocks', 'createdBy'];

const REF_ALLOWED_KEYS: readonly string[] = [
  'kind',
  'repository',
  'number',
  'planId',
  'laneId',
  'id',
  'decisionId',
];

const RESOLUTION_ALLOWED_KEYS: readonly string[] = [
  'kind',
  'observedAtIso',
  'questionId',
  'answeredAtIso',
  'planRevision',
  'atIso',
  'via',
  'by',
];

const PR_NUMBER_PATTERN = /^[1-9][0-9]*$/;

function fail(message: string): OwnerItemResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

function unreadableInputResult(): OwnerItemResult {
  return { success: false, error: new Error('OwnerItem input could not be read'), code: 'invalid' };
}

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

function idFieldError(field: string, value: unknown): string | null {
  if (typeof value !== 'string') {
    return `OwnerItem ${field} must be a non-empty id of at most 256 bytes`;
  }
  if (isSecretShaped(value)) {
    return `OwnerItem ${field} contains a secret-shaped value and was refused`;
  }
  if (value.trim() === '') {
    return `OwnerItem ${field} must be a non-empty id of at most 256 bytes`;
  }
  if (new TextEncoder().encode(value).byteLength > OWNER_ITEM_LIMITS.idBytes) {
    return `OwnerItem ${field} must be a non-empty id of at most 256 bytes`;
  }
  for (const char of value) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return `OwnerItem ${field} must be a non-empty id of at most 256 bytes`;
    }
  }
  return null;
}

function subjectErrorValue(subject: unknown, kind: OwnerItemKindValue): string | null {
  if (kind === 'other' && (subject === null || subject === undefined)) {
    return 'OwnerItem other requires a subject';
  }
  if (subject === null) {
    return null;
  }
  if (typeof subject !== 'string') {
    return 'OwnerItem subject must be single-line plain text of at most 120 characters';
  }
  if (isSecretShaped(subject)) {
    return 'OwnerItem subject contains a secret-shaped value and was refused';
  }
  if (subject.trim() === '' || [...subject].length > OWNER_ITEM_LIMITS.subjectChars) {
    return 'OwnerItem subject must be single-line plain text of at most 120 characters';
  }
  for (const char of subject) {
    const codePoint = char.codePointAt(0) as number;
    if (
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return 'OwnerItem subject must be single-line plain text of at most 120 characters';
    }
  }
  return null;
}

function projectIdErrorValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'OwnerItem projectId is not a project id';
  }
  if (isSecretShaped(value)) {
    return 'OwnerItem projectId contains a secret-shaped value and was refused';
  }
  if (!OWNER_ITEM_PROJECT_ID_PATTERN.test(value)) {
    return 'OwnerItem projectId is not a project id';
  }
  return null;
}

function repositoryError(repository: string): string | null {
  if (new TextEncoder().encode(repository).byteLength > OWNER_ITEM_LIMITS.repositoryBytes) {
    return 'invalid';
  }
  const parts = repository.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return 'invalid';
  }
  for (const char of repository) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return 'invalid';
    }
  }
  return null;
}

function timestampErrorValue(value: string): string | null {
  if (typeof value !== 'string') {
    return 'invalid';
  }
  const time = Date.parse(value);
  if (Number.isNaN(time) || time < -8.64e15 || time > 8.64e15) {
    return 'invalid';
  }
  return null;
}

function blockRefError(kind: string, ref: unknown, index: number): string | null {
  const message = `OwnerItem blocks[${index}] ref is not a ${kind} reference`;
  if (typeof ref !== 'string') {
    return message;
  }
  if (isSecretShaped(ref)) {
    return `OwnerItem blocks[${index}] ref contains a secret-shaped value and was refused`;
  }
  if (kind === 'lane') {
    const parts = ref.split('/');
    if (parts.length === 2) {
      if (!OWNER_ITEM_PLAN_ID_PATTERN.test(parts[0]) || !OWNER_ITEM_LANE_ID_PATTERN.test(parts[1])) {
        return message;
      }
    } else if (parts.length === 3) {
      if (
        !OWNER_ITEM_PROJECT_ID_PATTERN.test(parts[0]) ||
        !OWNER_ITEM_PLAN_ID_PATTERN.test(parts[1]) ||
        !OWNER_ITEM_LANE_ID_PATTERN.test(parts[2])
      ) {
        return message;
      }
    } else {
      return message;
    }
    return null;
  }
  if (kind === 'pr') {
    const hash = ref.lastIndexOf('#');
    if (hash <= 0 || hash === ref.length - 1) {
      return message;
    }
    if (repositoryError(ref.slice(0, hash)) !== null) {
      return message;
    }
    if (!PR_NUMBER_PATTERN.test(ref.slice(hash + 1))) {
      return message;
    }
    return null;
  }
  if (kind === 'plan') {
    if (!OWNER_ITEM_PLAN_ID_PATTERN.test(ref)) {
      return message;
    }
    return null;
  }
  if (idFieldError('ref', ref) !== null) {
    return message;
  }
  return null;
}

function blocksErrorValue(blocks: unknown): string | null {
  if (!Array.isArray(blocks) || blocks.length > OWNER_ITEM_LIMITS.blocks) {
    return 'OwnerItem blocks must be at most 16 distinct { kind, ref } entries';
  }
  const seen = new Set<string>();
  for (let index = 0; index < blocks.length; index += 1) {
    const parsed = readPlainObject(blocks[index], ['kind', 'ref']);
    if (parsed === null) {
      return 'OwnerItem blocks must be at most 16 distinct { kind, ref } entries';
    }
    const kind = parsed.kind;
    if (kind !== 'plan' && kind !== 'pr' && kind !== 'lane' && kind !== 'work-order') {
      return 'OwnerItem blocks must be at most 16 distinct { kind, ref } entries';
    }
    const refError = blockRefError(kind, parsed.ref, index);
    if (refError !== null) {
      return refError;
    }
    seen.add(kind + '\u0000' + String(parsed.ref));
    if (seen.size !== index + 1) {
      return 'OwnerItem blocks must be at most 16 distinct { kind, ref } entries';
    }
  }
  return null;
}

function refsErrorValue(refs: unknown): string | null {
  if (!Array.isArray(refs) || refs.length > OWNER_ITEM_LIMITS.refs) {
    return 'OwnerItem refs must be at most 16 distinct typed references';
  }
  const seen = new Set<string>();
  for (let index = 0; index < refs.length; index += 1) {
    const parsed = readPlainObjectWithOptional(refs[index], ['kind'], REF_ALLOWED_KEYS);
    if (parsed === null) {
      return 'OwnerItem refs must be at most 16 distinct typed references';
    }
    const kind = parsed.kind;
    if (kind !== 'pr' && kind !== 'lane' && kind !== 'work-order' && kind !== 'question' && kind !== 'plan-decision' && kind !== 'run') {
      return 'OwnerItem refs must be at most 16 distinct typed references';
    }
    for (const key of Object.keys(parsed)) {
      const value = parsed[key];
      if (typeof value === 'string' && isSecretShaped(value)) {
        return `OwnerItem refs[${index}] contains a secret-shaped value and was refused`;
      }
    }
    const notRef = `OwnerItem refs[${index}] is not a ${kind} reference`;
    if (kind === 'pr') {
      if (Object.keys(parsed).length !== 3 || typeof parsed.repository !== 'string' || repositoryError(parsed.repository) !== null || typeof parsed.number !== 'number' || !Number.isSafeInteger(parsed.number) || parsed.number < 1) {
        return notRef;
      }
      seen.add(JSON.stringify(['pr', parsed.repository, parsed.number]));
    } else if (kind === 'lane') {
      if (Object.keys(parsed).length !== 3 || typeof parsed.planId !== 'string' || !OWNER_ITEM_PLAN_ID_PATTERN.test(parsed.planId) || typeof parsed.laneId !== 'string' || !OWNER_ITEM_LANE_ID_PATTERN.test(parsed.laneId)) {
        return notRef;
      }
      seen.add(JSON.stringify(['lane', parsed.planId, parsed.laneId]));
    } else if (kind === 'plan-decision') {
      if (Object.keys(parsed).length !== 3 || typeof parsed.planId !== 'string' || !OWNER_ITEM_PLAN_ID_PATTERN.test(parsed.planId) || typeof parsed.decisionId !== 'string' || !OWNER_ITEM_DECISION_ID_PATTERN.test(parsed.decisionId)) {
        return notRef;
      }
      seen.add(JSON.stringify(['plan-decision', parsed.planId, parsed.decisionId]));
    } else {
      if (Object.keys(parsed).length !== 2 || typeof parsed.id !== 'string' || idFieldError('id', parsed.id) !== null) {
        return notRef;
      }
      seen.add(JSON.stringify([kind, parsed.id]));
    }
    if (seen.size !== index + 1) {
      return 'OwnerItem refs must be at most 16 distinct typed references';
    }
  }
  return null;
}

function kindRefsErrorValue(kind: OwnerItemKindValue, refs: unknown): string | null {
  const list = refs as OwnerItemRefRecord[];
  if (kind === 'merge') {
    const prCount = list.filter((ref) => ref.kind === 'pr').length;
    if (prCount !== 1) {
      return 'OwnerItem merge requires exactly one pr ref';
    }
  }
  if (kind === 'decision') {
    const questionCount = list.filter((ref) => ref.kind === 'question').length;
    const planDecisionCount = list.filter((ref) => ref.kind === 'plan-decision').length;
    if (questionCount + planDecisionCount < 1 || questionCount > 1 || planDecisionCount > 1) {
      return 'OwnerItem decision requires one question or plan-decision ref and at most one of each';
    }
  }
  return null;
}

function resolutionErrorValue(resolution: unknown, kind: OwnerItemKindValue): string | null {
  const parsed = readPlainObjectWithOptional(resolution, ['kind'], RESOLUTION_ALLOWED_KEYS);
  if (parsed === null) {
    return 'invalid';
  }
  const resKind = parsed.kind;
  if (typeof resKind !== 'string' || !OWNER_ITEM_RESOLUTION_KINDS.includes(resKind as OwnerItemResolutionKind)) {
    return 'invalid';
  }
  if (!OWNER_ITEM_RESOLUTIONS_BY_KIND[kind].includes(resKind as OwnerItemResolutionKind)) {
    return 'invalid';
  }
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (typeof value === 'string' && isSecretShaped(value)) {
      return 'invalid';
    }
  }
  if (resKind === 'merged' || resKind === 'pr-closed') {
    if (Object.keys(parsed).length !== 2 || typeof parsed.observedAtIso !== 'string' || timestampErrorValue(parsed.observedAtIso) !== null) {
      return 'invalid';
    }
  } else if (resKind === 'answered') {
    if (Object.keys(parsed).length !== 3 || typeof parsed.questionId !== 'string' || idFieldError('questionId', parsed.questionId) !== null || typeof parsed.answeredAtIso !== 'string' || timestampErrorValue(parsed.answeredAtIso) !== null) {
      return 'invalid';
    }
  } else if (resKind === 'plan-decided' || resKind === 'decision-removed') {
    if (Object.keys(parsed).length !== 3 || typeof parsed.planRevision !== 'number' || !Number.isSafeInteger(parsed.planRevision) || parsed.planRevision < 1 || typeof parsed.atIso !== 'string' || timestampErrorValue(parsed.atIso) !== null) {
      return 'invalid';
    }
  } else if (Object.keys(parsed).length !== 4 || (parsed.via !== 'cli' && parsed.via !== 'web') || typeof parsed.by !== 'string' || idFieldError('by', parsed.by) !== null || typeof parsed.atIso !== 'string' || timestampErrorValue(parsed.atIso) !== null) {
    return 'invalid';
  }
  return null;
}

function withdrawalErrorValue(withdrawal: unknown): string | null {
  const parsed = readPlainObject(withdrawal, ['reason', 'by', 'atIso']);
  if (parsed === null) {
    return 'invalid';
  }
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (typeof value === 'string' && isSecretShaped(value)) {
      return 'invalid';
    }
  }
  if (parsed.reason !== 'no-longer-needed' && parsed.reason !== 'duplicate' && parsed.reason !== 'superseded') {
    return 'invalid';
  }
  if (typeof parsed.by !== 'string' || idFieldError('by', parsed.by) !== null) {
    return 'invalid';
  }
  if (typeof parsed.atIso !== 'string' || timestampErrorValue(parsed.atIso) !== null) {
    return 'invalid';
  }
  return null;
}

function historyErrorValue(
  history: unknown,
  createdAtIso: string,
  state: OwnerItemState,
  resolution: unknown,
  withdrawal: unknown,
): string | null {
  if (!Array.isArray(history) || history.length < 1 || history.length > OWNER_ITEM_LIMITS.history) {
    return 'invalid';
  }
  let previousTime = Date.parse(createdAtIso);
  for (let index = 0; index < history.length; index += 1) {
    const entry = readPlainObject(history[index], ['event', 'atIso', 'reason']);
    if (entry === null) {
      return 'invalid';
    }
    const event = entry.event;
    if (event !== 'opened' && event !== 'closed' && event !== 'reopened' && event !== 'withdrawn') {
      return 'invalid';
    }
    if (typeof entry.atIso !== 'string' || timestampErrorValue(entry.atIso) !== null) {
      return 'invalid';
    }
    const time = Date.parse(entry.atIso);
    if (time < previousTime) {
      return 'invalid';
    }
    previousTime = time;
    if (event === 'opened' || event === 'reopened') {
      if (entry.reason !== null) {
        return 'invalid';
      }
    } else if (event === 'closed') {
      if (typeof entry.reason !== 'string' || !OWNER_ITEM_RESOLUTION_KINDS.includes(entry.reason as OwnerItemResolutionKind)) {
        return 'invalid';
      }
    } else if (typeof entry.reason !== 'string' || !OWNER_ITEM_WITHDRAW_REASONS.includes(entry.reason as OwnerItemWithdrawReason)) {
      return 'invalid';
    }
  }
  const first = readPlainObject(history[0], ['event', 'atIso', 'reason']);
  if (first === null || first.event !== 'opened' || new Date(first.atIso as string).toISOString() !== createdAtIso || first.reason !== null) {
    return 'invalid';
  }
  for (let index = 1; index < history.length; index += 1) {
    const entry = readPlainObject(history[index], ['event', 'atIso', 'reason']);
    if (entry === null) {
      return 'invalid';
    }
    if (entry.event === 'reopened') {
      const previous = readPlainObject(history[index - 1], ['event', 'atIso', 'reason']);
      if (previous === null) {
        return 'invalid';
      }
      if (previous.event === 'closed') {
        if (previous.reason !== 'pr-closed') {
          return 'invalid';
        }
      } else if (previous.event !== 'opened') {
        return 'invalid';
      }
    }
  }
  const last = readPlainObject(history[history.length - 1], ['event', 'atIso', 'reason']);
  if (last === null) {
    return 'invalid';
  }
  if (state === 'open') {
    if (last.event !== 'opened' && last.event !== 'reopened') {
      return 'invalid';
    }
  } else if (state === 'closed') {
    if (last.event !== 'closed') {
      return 'invalid';
    }
    const resKind = resolution !== null && typeof resolution === 'object' ? (resolution as Record<string, unknown>).kind : undefined;
    if (last.reason !== resKind) {
      return 'invalid';
    }
  } else if (last.event !== 'withdrawn') {
    return 'invalid';
  } else {
    const withdrawReason = withdrawal !== null && typeof withdrawal === 'object' ? (withdrawal as Record<string, unknown>).reason : undefined;
    if (last.reason !== withdrawReason) {
      return 'invalid';
    }
  }
  return null;
}

function freezeRefs(refs: unknown): readonly OwnerItemRefRecord[] {
  return Object.freeze(
    (refs as OwnerItemRefRecord[]).map((ref: OwnerItemRefRecord): OwnerItemRefRecord => Object.freeze({ ...ref } as OwnerItemRefRecord)),
  );
}

function freezeBlocks(blocks: unknown): readonly OwnerItemBlockRecord[] {
  return Object.freeze(
    (blocks as OwnerItemBlockRecord[]).map((block: OwnerItemBlockRecord): OwnerItemBlockRecord => Object.freeze({ ...block })),
  );
}

function freezeHistory(history: unknown): readonly OwnerItemHistoryEntryRecord[] {
  return Object.freeze(
    (history as OwnerItemHistoryEntryRecord[]).map(
      (entry: OwnerItemHistoryEntryRecord): OwnerItemHistoryEntryRecord =>
        Object.freeze({
          event: entry.event,
          atIso: new Date(entry.atIso).toISOString(),
          reason: entry.reason,
        }),
    ),
  );
}

function freezeResolution(resolution: unknown): OwnerItemResolutionRecord | null {
  if (resolution === null) {
    return null;
  }
  const parsed = resolution as Record<string, unknown>;
  const kind = parsed.kind as OwnerItemResolutionKind;
  if (kind === 'merged' || kind === 'pr-closed') {
    return Object.freeze({
      kind,
      observedAtIso: new Date(parsed.observedAtIso as string).toISOString(),
    });
  }
  if (kind === 'answered') {
    return Object.freeze({
      kind,
      questionId: parsed.questionId as string,
      answeredAtIso: new Date(parsed.answeredAtIso as string).toISOString(),
    });
  }
  if (kind === 'plan-decided' || kind === 'decision-removed') {
    return Object.freeze({
      kind,
      planRevision: parsed.planRevision as number,
      atIso: new Date(parsed.atIso as string).toISOString(),
    });
  }
  return Object.freeze({
    kind,
    via: parsed.via as OwnerItemDoneVia,
    by: parsed.by as string,
    atIso: new Date(parsed.atIso as string).toISOString(),
  });
}

function freezeWithdrawal(withdrawal: unknown): OwnerItemWithdrawalRecord | null {
  if (withdrawal === null) {
    return null;
  }
  const parsed = withdrawal as Record<string, unknown>;
  return Object.freeze({
    reason: parsed.reason as OwnerItemWithdrawReason,
    by: parsed.by as string,
    atIso: new Date(parsed.atIso as string).toISOString(),
  });
}

/**
 * The item's natural keys, sorted, distinct: one per pr ref of a merge item, one per plan-decision ref, one per question ref.
 */
export function ownerItemKeys(record: OwnerItemRecord): readonly string[] {
  const keys: string[] = [];
  if (record.kind === 'merge') {
    for (const ref of record.refs) {
      if (ref.kind === 'pr') {
        keys.push(ownerItemMergeKey(record.projectId, ref.repository, ref.number));
      }
    }
  }
  for (const ref of record.refs) {
    if (ref.kind === 'plan-decision') {
      keys.push(ownerItemPlanDecisionKey(record.projectId, ref.planId, ref.decisionId));
    } else if (ref.kind === 'question') {
      keys.push(ownerItemQuestionKey(ref.id));
    }
  }
  return Array.from(new Set(keys)).sort((a, b) => a.localeCompare(b));
}

/** JSON.stringify(['merge', projectId, repository, number]) — never a template literal. */
export function ownerItemMergeKey(projectId: string, repository: string, number: number): string {
  return JSON.stringify(['merge', projectId, repository, number]);
}

/** JSON.stringify(['plan-decision', projectId, planId, decisionId]). */
export function ownerItemPlanDecisionKey(projectId: string, planId: string, decisionId: string): string {
  return JSON.stringify(['plan-decision', projectId, planId, decisionId]);
}

/** JSON.stringify(['question', questionId]) — a question is global, not per project. */
export function ownerItemQuestionKey(questionId: string): string {
  return JSON.stringify(['question', questionId]);
}

/** True when the item is open, of a gating kind, and names at least one `lane` or `work-order` block. */
export function isOwnerItemGating(record: OwnerItemRecord): boolean {
  if (record.state !== 'open') {
    return false;
  }
  if (!(OWNER_ITEM_GATING_KINDS as readonly OwnerItemKindValue[]).includes(record.kind)) {
    return false;
  }
  return record.blocks.some((block) => block.kind === 'lane' || block.kind === 'work-order');
}

/** The `lane` and `work-order` blocks of a gating item (input order); empty for a non-gating or non-open item. */
export function ownerItemGatedBlocks(record: OwnerItemRecord): readonly OwnerItemBlockRecord[] {
  if (!isOwnerItemGating(record)) {
    return [];
  }
  return record.blocks.filter((block) => block.kind === 'lane' || block.kind === 'work-order');
}

export class OwnerItem {
  private constructor(private readonly record: OwnerItemRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown): OwnerItemResult {
    try {
      return OwnerItem.createUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  private static createUnchecked(input: unknown): OwnerItemResult {
    const record = readPlainObject(input, RECORD_KEYS);
    if (record === null) {
      return fail('OwnerItem requires a record with exactly its fields');
    }
    if (record.version !== 1) {
      return fail('OwnerItem version must be 1');
    }
    const itemIdError = idFieldError('itemId', record.itemId);
    if (itemIdError !== null) {
      return fail(itemIdError);
    }
    const createdByError = idFieldError('createdBy', record.createdBy);
    if (createdByError !== null) {
      return fail(createdByError);
    }
    const projectIdError = projectIdErrorValue(record.projectId);
    if (projectIdError !== null) {
      return fail(projectIdError);
    }
    const kindResult = OwnerItemKind.create(record.kind);
    if (!kindResult.success) {
      return fail('OwnerItem kind is not one of merge, secret, decision, backup, other');
    }
    const kind = kindResult.value.getValue();
    const subjectError = subjectErrorValue(record.subject, kind);
    if (subjectError !== null) {
      return fail(subjectError);
    }
    const refsCopy = plainArrayCopy(record.refs);
    const blocksCopy = plainArrayCopy(record.blocks);
    const historyCopy = plainArrayCopy(record.history);
    const refsError = refsErrorValue(refsCopy);
    if (refsError !== null) {
      return fail(refsError);
    }
    const blocksError = blocksErrorValue(blocksCopy);
    if (blocksError !== null) {
      return fail(blocksError);
    }
    const kindRefsError = kindRefsErrorValue(kind, refsCopy);
    if (kindRefsError !== null) {
      return fail(kindRefsError);
    }
    if (typeof record.createdAtIso !== 'string' || timestampErrorValue(record.createdAtIso) !== null) {
      return fail('OwnerItem createdAtIso must be a valid timestamp');
    }
    const createdAtIso = new Date(record.createdAtIso).toISOString();
    if (!OWNER_ITEM_STATES.includes(record.state as OwnerItemState)) {
      return fail('OwnerItem state is not one of open, closed, withdrawn');
    }
    const state = record.state as OwnerItemState;
    if (state === 'open') {
      if (record.resolution !== null || record.withdrawal !== null) {
        return fail('OwnerItem open carries no resolution or withdrawal');
      }
    } else if (state === 'closed') {
      if (record.withdrawal !== null || resolutionErrorValue(record.resolution, kind) !== null) {
        return fail('OwnerItem closed requires a resolution its kind allows');
      }
    } else if (!OWNER_ITEM_OWNER_CLOSABLE_KINDS.includes(kind) || record.resolution !== null || withdrawalErrorValue(record.withdrawal) !== null) {
      return fail('OwnerItem withdrawn requires a withdrawal and a kind the owner may close');
    }
    if (
      state === 'closed' &&
      record.resolution !== null &&
      typeof record.resolution === 'object' &&
      (record.resolution as Record<string, unknown>).kind === 'answered'
    ) {
      const questionRef = (refsCopy as OwnerItemRefRecord[]).find((ref) => ref.kind === 'question');
      if (questionRef === undefined || questionRef.id !== (record.resolution as Record<string, unknown>).questionId) {
        return fail('OwnerItem answered must name the item\'s question');
      }
    }
    if (historyErrorValue(historyCopy, createdAtIso, state, record.resolution, record.withdrawal) !== null) {
      return fail('OwnerItem history is not a valid sequence for its state');
    }
    const finalRecord: OwnerItemRecord = {
      version: 1,
      itemId: record.itemId as string,
      projectId: record.projectId as string,
      kind,
      subject: record.subject === null ? null : (record.subject as string),
      refs: freezeRefs(refsCopy),
      blocks: freezeBlocks(blocksCopy),
      createdAtIso,
      createdBy: record.createdBy as string,
      state,
      resolution: freezeResolution(record.resolution),
      withdrawal: freezeWithdrawal(record.withdrawal),
      history: freezeHistory(historyCopy),
    };
    if (JSON.stringify(finalRecord).length > OWNER_ITEM_LIMITS.recordJsonChars) {
      return fail('OwnerItem record exceeds its size limit');
    }
    return { success: true, value: new OwnerItem(Object.freeze(finalRecord)) };
  }

  /** Builds and validates a new item from its open fields and the injected clock. Never throws. */
  static open(input: unknown, nowIso: string): OwnerItemResult {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = readPlainObject(input, OPEN_KEYS);
    } catch {
      return unreadableInputResult();
    }
    if (parsed === null) {
      return { success: false, error: new Error('OwnerItem open requires exactly its fields'), code: 'invalid' };
    }
    const record = {
      version: 1,
      itemId: parsed.itemId,
      projectId: parsed.projectId,
      kind: parsed.kind,
      subject: parsed.subject,
      refs: parsed.refs,
      blocks: parsed.blocks,
      createdAtIso: nowIso,
      createdBy: parsed.createdBy,
      state: 'open',
      resolution: null,
      withdrawal: null,
      history: [{ event: 'opened', atIso: nowIso, reason: null }],
    };
    return OwnerItem.create(record);
  }

  observePullRequest(input: unknown): OwnerItemResult {
    try {
      return this.observePullRequestUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  private observePullRequestUnchecked(input: unknown): OwnerItemResult {
    if (this.record.kind !== 'merge') {
      return { success: false, error: new Error('OwnerItem only a merge item observes its PR'), code: 'kind' };
    }
    const observation = readPlainObject(input, ['repository', 'number', 'state', 'source', 'observedAtIso']);
    if (observation === null) {
      return unreadableInputResult();
    }
    const prRef = this.record.refs.find((ref) => ref.kind === 'pr');
    if (
      prRef === undefined ||
      prRef.kind !== 'pr' ||
      prRef.repository !== observation.repository ||
      prRef.number !== observation.number
    ) {
      return { success: false, error: new Error('OwnerItem observation names another PR'), code: 'invalid' };
    }
    const state = observation.state;
    const source = observation.source;
    if (typeof observation.observedAtIso !== 'string' || timestampErrorValue(observation.observedAtIso) !== null) {
      return unreadableInputResult();
    }
    const atIso = observation.observedAtIso;
    const clockError = this.clockError(atIso);
    if (clockError !== null) {
      return { success: false, error: new Error(clockError), code: 'clock' };
    }
    const current = this.record.state;
    const currentResolutionKind = this.record.resolution === null ? null : this.record.resolution.kind;
    if (state === 'merged') {
      if (source !== 'merge-record') {
        return { success: false, error: new Error('OwnerItem a merge closes only on a merge record'), code: 'source' };
      }
      if (current === 'closed' && currentResolutionKind === 'merged') {
        return { success: true, value: this };
      }
      if (current === 'open' || (current === 'closed' && currentResolutionKind === 'pr-closed')) {
        return this.transitionTo({
          state: 'closed',
          resolution: { kind: 'merged', observedAtIso: atIso },
          withdrawal: null,
          historyEvent: 'closed',
          historyReason: 'merged',
          atIso,
        });
      }
      return { success: false, error: new Error('OwnerItem a merged item is final'), code: 'state' };
    }
    if (state === 'closed') {
      if (source !== 'forge-observation') {
        return { success: false, error: new Error('OwnerItem a merge closes only on a forge observation'), code: 'source' };
      }
      if (current === 'closed' && currentResolutionKind === 'pr-closed') {
        return { success: true, value: this };
      }
      if (current === 'open') {
        return this.transitionTo({
          state: 'closed',
          resolution: { kind: 'pr-closed', observedAtIso: atIso },
          withdrawal: null,
          historyEvent: 'closed',
          historyReason: 'pr-closed',
          atIso,
        });
      }
      return { success: false, error: new Error('OwnerItem a merged item is final'), code: 'state' };
    }
    if (source !== 'forge-observation') {
      return { success: false, error: new Error('OwnerItem a merge reopens only on a forge observation'), code: 'source' };
    }
    if (current === 'open') {
      return { success: true, value: this };
    }
    if (current === 'closed' && currentResolutionKind === 'pr-closed') {
      return this.transitionTo({
        state: 'open',
        resolution: null,
        withdrawal: null,
        historyEvent: 'reopened',
        historyReason: null,
        atIso,
      });
    }
    return { success: false, error: new Error('OwnerItem a merged item is final'), code: 'state' };
  }

  recordAnswer(input: unknown): OwnerItemResult {
    try {
      return this.recordAnswerUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  private recordAnswerUnchecked(input: unknown): OwnerItemResult {
    if (this.record.kind !== 'decision') {
      return { success: false, error: new Error('OwnerItem only a decision item answers a question'), code: 'kind' };
    }
    const answer = readPlainObject(input, ['questionId', 'shape', 'hasOption', 'hasText', 'answeredAtIso']);
    if (answer === null) {
      return unreadableInputResult();
    }
    const questionRef = this.record.refs.find((ref) => ref.kind === 'question');
    if (questionRef === undefined || questionRef.kind !== 'question' || questionRef.id !== answer.questionId) {
      return { success: false, error: new Error('OwnerItem answer names another question'), code: 'invalid' };
    }
    if (typeof answer.answeredAtIso !== 'string' || timestampErrorValue(answer.answeredAtIso) !== null) {
      return unreadableInputResult();
    }
    const atIso = answer.answeredAtIso;
    const clockError = this.clockError(atIso);
    if (clockError !== null) {
      return { success: false, error: new Error(clockError), code: 'clock' };
    }
    const hasChoice =
      answer.shape === 'accept' || (answer.shape === 'answer' && (answer.hasOption === true || answer.hasText === true));
    if (!hasChoice) {
      return { success: false, error: new Error('OwnerItem a decision closes only on a recorded choice'), code: 'no-choice' };
    }
    const current = this.record.state;
    const currentResolutionKind = this.record.resolution === null ? null : this.record.resolution.kind;
    if (
      current === 'closed' &&
      currentResolutionKind === 'answered' &&
      this.record.resolution !== null &&
      this.record.resolution.questionId === answer.questionId
    ) {
      return { success: true, value: this };
    }
    if (current === 'open') {
      return this.transitionTo({
        state: 'closed',
        resolution: { kind: 'answered', questionId: answer.questionId as string, answeredAtIso: atIso },
        withdrawal: null,
        historyEvent: 'closed',
        historyReason: 'answered',
        atIso,
      });
    }
    return { success: false, error: new Error('OwnerItem a decided question is final'), code: 'state' };
  }

  recordPlanDecision(input: unknown): OwnerItemResult {
    try {
      return this.recordPlanDecisionUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  private recordPlanDecisionUnchecked(input: unknown): OwnerItemResult {
    if (this.record.kind !== 'decision') {
      return { success: false, error: new Error('OwnerItem only a decision item records a plan decision'), code: 'kind' };
    }
    const decision = readPlainObject(input, ['planId', 'decisionId', 'outcome', 'planRevision', 'atIso']);
    if (decision === null) {
      return unreadableInputResult();
    }
    const decisionRef = this.record.refs.find((ref) => ref.kind === 'plan-decision');
    if (
      decisionRef === undefined ||
      decisionRef.kind !== 'plan-decision' ||
      decisionRef.planId !== decision.planId ||
      decisionRef.decisionId !== decision.decisionId
    ) {
      return { success: false, error: new Error('OwnerItem plan decision names another decision'), code: 'invalid' };
    }
    const outcome = decision.outcome;
    if (outcome !== 'decided' && outcome !== 'removed') {
      return unreadableInputResult();
    }
    const planRevision = decision.planRevision;
    if (typeof planRevision !== 'number' || !Number.isSafeInteger(planRevision) || planRevision < 1) {
      return unreadableInputResult();
    }
    if (typeof decision.atIso !== 'string' || timestampErrorValue(decision.atIso) !== null) {
      return unreadableInputResult();
    }
    const atIso = decision.atIso;
    const clockError = this.clockError(atIso);
    if (clockError !== null) {
      return { success: false, error: new Error(clockError), code: 'clock' };
    }
    const resolutionKind = outcome === 'decided' ? 'plan-decided' : 'decision-removed';
    const current = this.record.state;
    const currentResolutionKind = this.record.resolution === null ? null : this.record.resolution.kind;
    if (current === 'closed' && currentResolutionKind === resolutionKind) {
      return { success: true, value: this };
    }
    if (current === 'open') {
      return this.transitionTo({
        state: 'closed',
        resolution: { kind: resolutionKind, planRevision, atIso },
        withdrawal: null,
        historyEvent: 'closed',
        historyReason: resolutionKind,
        atIso,
      });
    }
    return { success: false, error: new Error('OwnerItem a decided decision is not reopened by a later import'), code: 'state' };
  }

  markDone(input: unknown): OwnerItemResult {
    try {
      return this.markDoneUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  private markDoneUnchecked(input: unknown): OwnerItemResult {
    if (!(OWNER_ITEM_OWNER_CLOSABLE_KINDS as readonly OwnerItemKindValue[]).includes(this.record.kind)) {
      return { success: false, error: new Error('OwnerItem merge and decision items are not closed by the owner'), code: 'kind' };
    }
    const done = readPlainObject(input, ['via', 'by', 'atIso']);
    if (done === null) {
      return unreadableInputResult();
    }
    if (done.via !== 'cli' && done.via !== 'web') {
      return unreadableInputResult();
    }
    if (typeof done.by !== 'string' || idFieldError('by', done.by) !== null) {
      return unreadableInputResult();
    }
    if (typeof done.atIso !== 'string' || timestampErrorValue(done.atIso) !== null) {
      return unreadableInputResult();
    }
    const atIso = done.atIso;
    const clockError = this.clockError(atIso);
    if (clockError !== null) {
      return { success: false, error: new Error(clockError), code: 'clock' };
    }
    if (this.record.state !== 'open') {
      return { success: false, error: new Error('OwnerItem a done item is final'), code: 'state' };
    }
    return this.transitionTo({
      state: 'closed',
      resolution: { kind: 'done', via: done.via as OwnerItemDoneVia, by: done.by as string, atIso },
      withdrawal: null,
      historyEvent: 'closed',
      historyReason: 'done',
      atIso,
    });
  }

  withdraw(input: unknown): OwnerItemResult {
    try {
      return this.withdrawUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  private withdrawUnchecked(input: unknown): OwnerItemResult {
    if (!(OWNER_ITEM_OWNER_CLOSABLE_KINDS as readonly OwnerItemKindValue[]).includes(this.record.kind)) {
      return { success: false, error: new Error('OwnerItem merge and decision items cannot be withdrawn'), code: 'kind' };
    }
    const withdrawal = readPlainObject(input, ['reason', 'by', 'atIso']);
    if (withdrawal === null) {
      return unreadableInputResult();
    }
    if (withdrawal.reason !== 'no-longer-needed' && withdrawal.reason !== 'duplicate' && withdrawal.reason !== 'superseded') {
      return unreadableInputResult();
    }
    if (typeof withdrawal.by !== 'string' || idFieldError('by', withdrawal.by) !== null) {
      return unreadableInputResult();
    }
    if (typeof withdrawal.atIso !== 'string' || timestampErrorValue(withdrawal.atIso) !== null) {
      return unreadableInputResult();
    }
    const atIso = withdrawal.atIso;
    const clockError = this.clockError(atIso);
    if (clockError !== null) {
      return { success: false, error: new Error(clockError), code: 'clock' };
    }
    if (this.record.state !== 'open') {
      return { success: false, error: new Error('OwnerItem a withdrawn item is final'), code: 'state' };
    }
    return this.transitionTo({
      state: 'withdrawn',
      resolution: null,
      withdrawal: { reason: withdrawal.reason as OwnerItemWithdrawReason, by: withdrawal.by as string, atIso },
      historyEvent: 'withdrawn',
      historyReason: withdrawal.reason as OwnerItemWithdrawReason,
      atIso,
    });
  }

  private clockError(atIso: string): string | null {
    const lastAt = this.record.history[this.record.history.length - 1].atIso;
    if (Date.parse(atIso) < Date.parse(lastAt)) {
      return 'OwnerItem time must not move backwards';
    }
    return null;
  }

  private transitionTo(changes: {
    state: OwnerItemState;
    resolution: OwnerItemResolutionRecord | null;
    withdrawal: OwnerItemWithdrawalRecord | null;
    historyEvent: OwnerItemHistoryEntryRecord['event'];
    historyReason: OwnerItemHistoryEntryRecord['reason'];
    atIso: string;
  }): OwnerItemResult {
    const history = this.record.history.slice();
    history.push({ event: changes.historyEvent, atIso: changes.atIso, reason: changes.historyReason });
    if (history.length > OWNER_ITEM_LIMITS.history) {
      history.splice(1, 1);
    }
    const next: OwnerItemRecord = {
      version: this.record.version,
      itemId: this.record.itemId,
      projectId: this.record.projectId,
      kind: this.record.kind,
      subject: this.record.subject,
      refs: this.record.refs,
      blocks: this.record.blocks,
      createdAtIso: this.record.createdAtIso,
      createdBy: this.record.createdBy,
      state: changes.state,
      resolution: changes.resolution,
      withdrawal: changes.withdrawal,
      history,
    };
    return OwnerItem.create(next);
  }

  getId(): string {
    return this.record.itemId;
  }

  getProjectId(): string {
    return this.record.projectId;
  }

  getKind(): OwnerItemKindValue {
    return this.record.kind;
  }

  getState(): OwnerItemState {
    return this.record.state;
  }

  /** Fresh plain record; arrays and objects are fresh frozen copies. */
  toRecord(): OwnerItemRecord {
    return {
      version: this.record.version,
      itemId: this.record.itemId,
      projectId: this.record.projectId,
      kind: this.record.kind,
      subject: this.record.subject,
      refs: Object.freeze(
        this.record.refs.map((ref: OwnerItemRefRecord): OwnerItemRefRecord => Object.freeze({ ...ref } as OwnerItemRefRecord)),
      ),
      blocks: Object.freeze(
        this.record.blocks.map((block: OwnerItemBlockRecord): OwnerItemBlockRecord => Object.freeze({ ...block })),
      ),
      createdAtIso: this.record.createdAtIso,
      createdBy: this.record.createdBy,
      state: this.record.state,
      resolution: this.record.resolution === null ? null : Object.freeze({ ...this.record.resolution }),
      withdrawal: this.record.withdrawal === null ? null : Object.freeze({ ...this.record.withdrawal }),
      history: Object.freeze(
        this.record.history.map(
          (entry: OwnerItemHistoryEntryRecord): OwnerItemHistoryEntryRecord => Object.freeze({ ...entry }),
        ),
      ),
    };
  }
}
