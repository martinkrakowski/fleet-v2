// @generated entity stub — refined for lane AM3b-1.
/**
 * AttentionItem is a pure domain aggregate for one machine notice (auto-merge
 * plan A12, conductor plan §3.6 and §3.9.2): who raised it, about which typed
 * subject, of which kind, for which project — and optionally which work order
 * for clearing on merge — with a plain-text summary; open until cleared, one
 * item per key, a repeat raise refreshes or reopens it. It is its own
 * aggregate — never an owner item, never a coordination kind — and grants
 * nothing. Validation and transitions return a result
 * (`{ success: true, value } | { success: false, error, code }`), never
 * throw, and never echo an input value; secret-shaped text is refused.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { readPlainObject } from '../record-input.js';
import {
  ATTENTION_ITEM_CLEAR_REASONS,
  ATTENTION_ITEM_CLEAR_VIAS,
  ATTENTION_ITEM_ID_PATTERN,
  ATTENTION_ITEM_KIND_PATTERN,
  ATTENTION_ITEM_LIMITS,
  ATTENTION_ITEM_PR_REF_PATTERN,
  ATTENTION_ITEM_PROJECT_ID_PATTERN,
  ATTENTION_ITEM_STATES,
  ATTENTION_ITEM_SUBJECT_KINDS,
  ATTENTION_ITEM_WORKTREE_REF_PATTERN,
} from '../attention-item-records.js';
import type {
  AttentionItemClearReason,
  AttentionItemClearanceRecord,
  AttentionItemClearVia,
  AttentionItemRecord,
  AttentionItemState,
  AttentionItemSubjectKind,
  AttentionItemSubjectRecord,
} from '../attention-item-records.js';

export type AttentionItemRefusalCode = 'invalid' | 'state' | 'clock' | 'key';
export type AttentionItemResult =
  | { readonly success: true; readonly value: AttentionItem }
  | { readonly success: false; readonly error: Error; readonly code: AttentionItemRefusalCode };

const RECORD_KEYS: readonly string[] = [
  'itemId',
  'projectId',
  'kind',
  'subject',
  'workOrderId',
  'summary',
  'state',
  'raisedBy',
  'firstRaisedAtIso',
  'lastRaisedAtIso',
  'raisedCount',
  'clearance',
];

const RAISE_KEYS: readonly string[] = ['itemId', 'projectId', 'kind', 'subject', 'workOrderId', 'summary', 'raisedBy'];

const RAISE_AGAIN_KEYS: readonly string[] = ['kind', 'subject', 'workOrderId', 'summary', 'raisedBy'];

const CLEAR_KEYS: readonly string[] = ['reason', 'via', 'by'];

/** JSON.stringify(['attention', projectId, subject.kind, subject.ref, kind]) — never a template literal. */
export function attentionItemKey(projectId: string, subject: AttentionItemSubjectRecord, kind: string): string {
  return JSON.stringify(['attention', projectId, subject.kind, subject.ref, kind]);
}

function fail(message: string): AttentionItemResult {
  return { success: false, error: new Error(message), code: 'invalid' };
}

function failCode(code: AttentionItemRefusalCode, message: string): AttentionItemResult {
  return { success: false, error: new Error(message), code };
}

function unreadableInputResult(): AttentionItemResult {
  return { success: false, error: new Error('AttentionItem input could not be read'), code: 'invalid' };
}

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/** Code points refused everywhere as format controls: C0, DEL/C1, bidi and line-separator controls. */
function refusedControlCodePoint(codePoint: number): boolean {
  if (codePoint < 0x20 || codePoint === 0x7f) {
    return true;
  }
  if (codePoint >= 0x80 && codePoint <= 0x9f) {
    return true;
  }
  if (codePoint >= 0x202a && codePoint <= 0x202e) {
    return true;
  }
  if (codePoint === 0x2028 || codePoint === 0x2029) {
    return true;
  }
  if (codePoint >= 0x2066 && codePoint <= 0x2069) {
    return true;
  }
  return false;
}

function idFieldError(field: string, value: unknown): string | null {
  if (typeof value !== 'string' || !ATTENTION_ITEM_ID_PATTERN.test(value)) {
    return `AttentionItem ${field} must be printable ASCII without space, 1-256 characters`;
  }
  if (isSecretShaped(value)) {
    return `AttentionItem ${field} contains a secret-shaped value and was refused`;
  }
  return null;
}

function projectIdErrorValue(value: unknown): string | null {
  if (typeof value !== 'string' || !ATTENTION_ITEM_PROJECT_ID_PATTERN.test(value)) {
    return 'AttentionItem projectId is not a project id';
  }
  if (isSecretShaped(value)) {
    return 'AttentionItem projectId contains a secret-shaped value and was refused';
  }
  return null;
}

function kindErrorValue(value: unknown): string | null {
  if (typeof value !== 'string' || !ATTENTION_ITEM_KIND_PATTERN.test(value)) {
    return 'AttentionItem kind is not a lowercase slug';
  }
  return null;
}

type SubjectValidation =
  | { readonly ok: true; readonly parsed: AttentionItemSubjectRecord }
  | { readonly ok: false; readonly error: string };

function subjectErrorValue(subject: unknown): SubjectValidation {
  const parsed = readPlainObject(subject, ['kind', 'ref']);
  if (parsed === null) {
    return { ok: false, error: 'AttentionItem subject must be a { kind, ref } object' };
  }
  const kind = parsed.kind;
  if (typeof kind !== 'string' || !(ATTENTION_ITEM_SUBJECT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: 'AttentionItem subject kind is not one of work-order, run, attempt, reservation, worktree, pr, project' };
  }
  const ref = parsed.ref;
  if (typeof ref !== 'string') {
    return { ok: false, error: 'AttentionItem subject ref is not valid for its kind' };
  }
  if (isSecretShaped(ref)) {
    return { ok: false, error: 'AttentionItem subject ref contains a secret-shaped value and was refused' };
  }
  if (kind === 'worktree' && !ATTENTION_ITEM_WORKTREE_REF_PATTERN.test(ref)) {
    return { ok: false, error: 'AttentionItem worktree subject ref must be a wt-<12 hex> digest, never a path' };
  }
  if (kind === 'pr' && !ATTENTION_ITEM_PR_REF_PATTERN.test(ref)) {
    return { ok: false, error: 'AttentionItem pr subject ref must be <owner>/<repo>#<number>' };
  }
  if (kind !== 'worktree' && kind !== 'pr' && idFieldError('subject ref', ref) !== null) {
    return { ok: false, error: 'AttentionItem subject ref is not valid for its kind' };
  }
  return { ok: true, parsed: { kind: kind as AttentionItemSubjectKind, ref: ref as string } };
}

function summaryErrorValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'AttentionItem summary must be single-line plain text of at most 1024 code points';
  }
  if (isSecretShaped(value)) {
    return 'AttentionItem summary contains a secret-shaped value and was refused';
  }
  const summaryLength = [...value].length;
  if (summaryLength < 1 || summaryLength > ATTENTION_ITEM_LIMITS.summaryChars) {
    return 'AttentionItem summary must be single-line plain text of at most 1024 code points';
  }
  for (const char of value) {
    if (refusedControlCodePoint(char.codePointAt(0) as number)) {
      return 'AttentionItem summary must be single-line plain text of at most 1024 code points';
    }
  }
  return null;
}

function canonicalIsoError(value: unknown): string | null {
  if (typeof value !== 'string') {
    return 'invalid';
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    return 'invalid';
  }
  return null;
}

type ClearanceValidation =
  | { readonly ok: true; readonly parsed: AttentionItemClearanceRecord }
  | { readonly ok: false; readonly error: string };

function clearanceErrorValue(clearance: unknown, lastRaisedAtIso: string): ClearanceValidation {
  const parsed = readPlainObject(clearance, ['reason', 'via', 'by', 'atIso']);
  if (parsed === null) {
    return { ok: false, error: 'AttentionItem clearance must be a { reason, via, by, atIso } record' };
  }
  const reason = parsed.reason;
  if (typeof reason !== 'string' || !(ATTENTION_ITEM_CLEAR_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: 'AttentionItem clearance reason is not one of dismissed, merged, resolved, stale' };
  }
  const via = parsed.via;
  if (typeof via !== 'string' || !(ATTENTION_ITEM_CLEAR_VIAS as readonly string[]).includes(via)) {
    return { ok: false, error: 'AttentionItem clearance via is not one of cli, web, machine' };
  }
  if (idFieldError('clearance by', parsed.by) !== null) {
    return { ok: false, error: 'AttentionItem clearance by is not a valid actor' };
  }
  if (canonicalIsoError(parsed.atIso) !== null) {
    return { ok: false, error: 'AttentionItem clearance atIso must be a canonical ISO timestamp' };
  }
  if (Date.parse(parsed.atIso as string) < Date.parse(lastRaisedAtIso)) {
    return { ok: false, error: 'AttentionItem clearance atIso must not precede the last raise' };
  }
  return {
    ok: true,
    parsed: {
      reason: reason as AttentionItemClearReason,
      via: via as AttentionItemClearVia,
      by: parsed.by as string,
      atIso: parsed.atIso as string,
    },
  };
}

export class AttentionItem {
  private constructor(private readonly record: AttentionItemRecord) {
    // Invariants are validated in create; the record is frozen on the way in.
  }

  /** The only way in; also used to read a stored record. Never throws. */
  static create(input: unknown): AttentionItemResult {
    try {
      return AttentionItem.createUnchecked(input);
    } catch {
      return unreadableInputResult();
    }
  }

  private static createUnchecked(input: unknown): AttentionItemResult {
    const record = readPlainObject(input, RECORD_KEYS);
    if (record === null) {
      return fail('AttentionItem requires a record with exactly its fields');
    }
    const itemIdError = idFieldError('itemId', record.itemId);
    if (itemIdError !== null) {
      return fail(itemIdError);
    }
    const raisedByError = idFieldError('raisedBy', record.raisedBy);
    if (raisedByError !== null) {
      return fail(raisedByError);
    }
    const projectIdError = projectIdErrorValue(record.projectId);
    if (projectIdError !== null) {
      return fail(projectIdError);
    }
    const kindError = kindErrorValue(record.kind);
    if (kindError !== null) {
      return fail(kindError);
    }
    const subjectValidation = subjectErrorValue(record.subject);
    if (!subjectValidation.ok) {
      return fail(subjectValidation.error);
    }
    const workOrderIdError =
      record.workOrderId === null ? null : idFieldError('workOrderId', record.workOrderId);
    if (workOrderIdError !== null) {
      return fail(workOrderIdError);
    }
    const summaryError = summaryErrorValue(record.summary);
    if (summaryError !== null) {
      return fail(summaryError);
    }
    if (typeof record.state !== 'string' || !(ATTENTION_ITEM_STATES as readonly string[]).includes(record.state)) {
      return fail('AttentionItem state is not one of open, cleared');
    }
    const state = record.state as AttentionItemState;
    if (canonicalIsoError(record.firstRaisedAtIso) !== null) {
      return fail('AttentionItem firstRaisedAtIso must be a canonical ISO timestamp');
    }
    if (canonicalIsoError(record.lastRaisedAtIso) !== null) {
      return fail('AttentionItem lastRaisedAtIso must be a canonical ISO timestamp');
    }
    if (Date.parse(record.firstRaisedAtIso as string) > Date.parse(record.lastRaisedAtIso as string)) {
      return fail('AttentionItem firstRaisedAtIso must not follow lastRaisedAtIso');
    }
    if (typeof record.raisedCount !== 'number' || !Number.isSafeInteger(record.raisedCount) || record.raisedCount < 1) {
      return fail('AttentionItem raisedCount must be a safe integer of at least 1');
    }
    let clearanceParsed: AttentionItemClearanceRecord | null = null;
    if (state === 'open') {
      if (record.clearance !== null) {
        return fail('AttentionItem open carries no clearance');
      }
    } else {
      if (record.clearance === null) {
        return fail('AttentionItem cleared requires a valid clearance');
      }
      const clearanceValidation = clearanceErrorValue(record.clearance, record.lastRaisedAtIso as string);
      if (!clearanceValidation.ok) {
        return fail('AttentionItem cleared requires a valid clearance');
      }
      clearanceParsed = clearanceValidation.parsed;
    }
    const subjectSnapshot = subjectValidation.parsed;
    const finalRecord: AttentionItemRecord = Object.freeze({
      itemId: record.itemId as string,
      projectId: record.projectId as string,
      kind: record.kind as string,
      subject: Object.freeze({ kind: subjectSnapshot.kind, ref: subjectSnapshot.ref }),
      workOrderId: record.workOrderId === null ? null : (record.workOrderId as string),
      summary: record.summary as string,
      state,
      raisedBy: record.raisedBy as string,
      firstRaisedAtIso: record.firstRaisedAtIso as string,
      lastRaisedAtIso: record.lastRaisedAtIso as string,
      raisedCount: record.raisedCount as number,
      clearance:
        clearanceParsed === null
          ? null
          : Object.freeze({
              reason: clearanceParsed.reason,
              via: clearanceParsed.via,
              by: clearanceParsed.by,
              atIso: clearanceParsed.atIso,
            }),
    });
    if (JSON.stringify(finalRecord).length > ATTENTION_ITEM_LIMITS.recordJsonChars) {
      return fail('AttentionItem record exceeds its size limit');
    }
    return { success: true, value: new AttentionItem(finalRecord) };
  }

  /** Builds and validates a first raise from its open fields and the injected clock. Never throws. */
  static raise(input: unknown, nowIso: string): AttentionItemResult {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = readPlainObject(input, RAISE_KEYS);
    } catch {
      return unreadableInputResult();
    }
    if (parsed === null) {
      return fail('AttentionItem raise requires exactly its fields');
    }
    if (canonicalIsoError(nowIso) !== null) {
      return failCode('clock', 'AttentionItem raise requires a canonical ISO timestamp');
    }
    const record = {
      itemId: parsed.itemId,
      projectId: parsed.projectId,
      kind: parsed.kind,
      subject: parsed.subject,
      workOrderId: parsed.workOrderId,
      summary: parsed.summary,
      state: 'open',
      raisedBy: parsed.raisedBy,
      firstRaisedAtIso: nowIso,
      lastRaisedAtIso: nowIso,
      raisedCount: 1,
      clearance: null,
    };
    return AttentionItem.create(record);
  }

  /** A later raise for the same key: refreshes an open item or reopens a cleared one. Never throws. */
  raiseAgain(input: unknown, nowIso: string): AttentionItemResult {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = readPlainObject(input, RAISE_AGAIN_KEYS);
      if (parsed === null) {
        return fail('AttentionItem a later raise requires exactly its fields');
      }
      const subjectValidation = subjectErrorValue(parsed.subject);
      if (!subjectValidation.ok) {
        return fail(subjectValidation.error);
      }
      const kindError = kindErrorValue(parsed.kind);
      if (kindError !== null) {
        return fail(kindError);
      }
      const subjectSnapshot = subjectValidation.parsed;
      const key = attentionItemKey(this.record.projectId, subjectSnapshot, parsed.kind as string);
      if (key !== this.key() || parsed.workOrderId !== this.record.workOrderId) {
        return failCode('key', 'AttentionItem a later raise must name the same key and work order');
      }
      if (canonicalIsoError(nowIso) !== null) {
        return failCode('clock', 'AttentionItem a later raise requires a canonical ISO timestamp');
      }
      if (Date.parse(nowIso) < Date.parse(this.record.lastRaisedAtIso)) {
        return failCode('clock', 'AttentionItem a later raise must not precede the last raise');
      }
      const candidate: AttentionItemRecord = {
        ...this.record,
        kind: parsed.kind as string,
        subject: subjectSnapshot,
        workOrderId: this.record.workOrderId,
        summary: parsed.summary as string,
        raisedBy: parsed.raisedBy as string,
        state: 'open',
        firstRaisedAtIso: this.record.firstRaisedAtIso,
        lastRaisedAtIso: nowIso,
        raisedCount: this.record.raisedCount + 1,
        clearance: null,
      };
      return AttentionItem.create(candidate);
    } catch {
      return unreadableInputResult();
    }
  }

  /** Clears an open item with a reason, channel and actor. Never throws. */
  clear(input: unknown, nowIso: string): AttentionItemResult {
    if (this.record.state !== 'open') {
      return failCode('state', 'AttentionItem only an open item can be cleared');
    }
    let parsed: Record<string, unknown> | null;
    try {
      parsed = readPlainObject(input, CLEAR_KEYS);
    } catch {
      return unreadableInputResult();
    }
    if (parsed === null) {
      return fail('AttentionItem clear requires exactly its fields');
    }
    if (canonicalIsoError(nowIso) !== null) {
      return failCode('clock', 'AttentionItem clear requires a canonical ISO timestamp');
    }
    if (Date.parse(nowIso) < Date.parse(this.record.lastRaisedAtIso)) {
      return failCode('clock', 'AttentionItem clear must not precede the last raise');
    }
    const candidate: AttentionItemRecord = {
      ...this.record,
      state: 'cleared',
      clearance: {
        reason: parsed.reason as AttentionItemClearReason,
        via: parsed.via as AttentionItemClearVia,
        by: parsed.by as string,
        atIso: nowIso,
      },
    };
    return AttentionItem.create(candidate);
  }

  key(): string {
    return attentionItemKey(this.record.projectId, this.record.subject, this.record.kind);
  }

  getId(): string {
    return this.record.itemId;
  }

  getProjectId(): string {
    return this.record.projectId;
  }

  getState(): AttentionItemState {
    return this.record.state;
  }

  getWorkOrderId(): string | null {
    return this.record.workOrderId;
  }

  /** Fresh plain record; the record and its nested objects are fresh frozen copies. */
  toRecord(): AttentionItemRecord {
    return Object.freeze({
      itemId: this.record.itemId,
      projectId: this.record.projectId,
      kind: this.record.kind,
      subject: Object.freeze({ kind: this.record.subject.kind, ref: this.record.subject.ref }),
      workOrderId: this.record.workOrderId,
      summary: this.record.summary,
      state: this.record.state,
      raisedBy: this.record.raisedBy,
      firstRaisedAtIso: this.record.firstRaisedAtIso,
      lastRaisedAtIso: this.record.lastRaisedAtIso,
      raisedCount: this.record.raisedCount,
      clearance:
        this.record.clearance === null
          ? null
          : Object.freeze({ ...this.record.clearance }),
    } as AttentionItemRecord);
  }
}
