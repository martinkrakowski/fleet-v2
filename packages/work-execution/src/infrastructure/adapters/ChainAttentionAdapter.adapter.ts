// @generated adapter stub — refined for lane CO8.
/**
 * ChainAttentionAdapter implements ChainAttentionPort by delegating in-process to
 * operator-coordination's RecordAttentionItemPort and ClearAttentionItemPort,
 * bound by the composition root (same delegate pattern as LaneRunParkNoticeAdapter).
 *
 * The attention body's summary is composed by the adapter from ids and codes only
 * (the kind, the chain name and the optional link repository); never caller text,
 * never a path, a URL or an input value. The subject is `{ kind: 'run', ref:
 * <chainName> }` for a chain-scoped item, `{ kind: 'pr', ref: '<owner>/<repo>#<number>' }`
 * for an item carrying a link pull request. Clear resolves by key as `resolved`
 * via `machine`, actor `chain-refresh`. A refused delegate call is reported as a
 * refusal with the delegate's code; it is never retried in the same pass. The
 * adapter never throws and never echoes an input value.
 */

import type {
  ChainAttentionCommand,
  ChainAttentionKind,
  ChainAttentionPort,
  ClearChainAttentionResult,
  RaiseChainAttentionResult,
} from '../../application/ports/out/ChainAttentionPort.out-port.js';
import { parseChainName } from '../../domain/chain-records.js';

/** The actor chain attention items are raised and resolved as. */
export const CHAIN_ATTENTION_ACTOR = 'chain-refresh';

/** The clear via for machine callers (operator coordination contract). */
const CHAIN_ATTENTION_CLEAR_VIA = 'machine';

const CHAIN_ATTENTION_KINDS: readonly string[] = ['chain-refresh-conflict', 'link-not-landed', 'branch-moved'];

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Supplier-side delegates; the composition root binds the real use cases. */
export interface ChainAttentionDelegate {
  readonly recordAttentionItem?: (body: unknown, actor: string) => Promise<unknown>;
  readonly clearAttentionItem?: (request: unknown, via: string, actor: string) => Promise<unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The subject of a chain attention item: the chain run, or the link pull request when one is named. */
function subjectOf(command: ChainAttentionCommand): { readonly kind: string; readonly ref: string } {
  const link = command.linkPullRequest;
  if (link !== undefined) {
    return { kind: 'pr', ref: `${link.owner}/${link.repo}#${link.number}` };
  }
  return { kind: 'run', ref: command.chainName };
}

/** The fixed summary: the kind and ids, composed here, never caller text. */
function summaryOf(command: ChainAttentionCommand): string {
  const link = command.linkPullRequest;
  return link === undefined
    ? `${command.kind} chain=${command.chainName}`
    : `${command.kind} chain=${command.chainName} repo=${link.owner}/${link.repo}`;
}

export class ChainAttentionAdapter implements ChainAttentionPort {
  constructor(private readonly delegate?: ChainAttentionDelegate) {}

  /** A fixed refusal code, or null when the command may proceed; never echoes a value. */
  private validate(command: ChainAttentionCommand): string | null {
    if (!isPlainObject(command)) {
      return 'invalid-request';
    }
    if (typeof command.projectId !== 'string' || command.projectId.length === 0) {
      return 'invalid-request';
    }
    if (parseChainName(command.chainName) === undefined) {
      return 'invalid-request';
    }
    if (!CHAIN_ATTENTION_KINDS.includes(command.kind)) {
      return 'invalid-request';
    }
    const link = command.linkPullRequest;
    if (link !== undefined) {
      if (!isPlainObject(link)) {
        return 'invalid-request';
      }
      const owner = link.owner;
      const repo = link.repo;
      const number = link.number;
      if (
        typeof owner !== 'string' ||
        !REPOSITORY_SEGMENT_PATTERN.test(owner) ||
        owner === '.' ||
        owner === '..' ||
        typeof repo !== 'string' ||
        !REPOSITORY_SEGMENT_PATTERN.test(repo) ||
        repo === '.' ||
        repo === '..' ||
        !Number.isSafeInteger(number) ||
        number < 1
      ) {
        return 'invalid-request';
      }
    }
    return null;
  }

  async raiseChainAttention(command: ChainAttentionCommand): Promise<RaiseChainAttentionResult> {
    const invalid = this.validate(command);
    if (invalid !== null) {
      return { outcome: 'refused', reasonCode: invalid };
    }
    const recordAttentionItem = this.delegate?.recordAttentionItem;
    if (recordAttentionItem === undefined) {
      return { outcome: 'refused', reasonCode: 'not-configured' };
    }
    const body = {
      projectId: command.projectId,
      kind: command.kind as ChainAttentionKind,
      subject: subjectOf(command),
      workOrderId: null,
      summary: summaryOf(command),
    };
    try {
      const answer = await recordAttentionItem(body, CHAIN_ATTENTION_ACTOR);
      if (
        isPlainObject(answer) &&
        (answer.outcome === 'raised' || answer.outcome === 'refreshed' || answer.outcome === 'reopened')
      ) {
        return { outcome: answer.outcome, reasonCode: null };
      }
      if (isPlainObject(answer) && answer.outcome === 'refused') {
        return { outcome: 'refused', reasonCode: typeof answer.code === 'string' ? answer.code : 'unreadable' };
      }
      return { outcome: 'refused', reasonCode: 'unreadable' };
    } catch {
      return { outcome: 'refused', reasonCode: 'unreadable' };
    }
  }

  async clearChainAttention(command: ChainAttentionCommand): Promise<ClearChainAttentionResult> {
    const invalid = this.validate(command);
    if (invalid !== null) {
      return { outcome: 'refused', reasonCode: invalid };
    }
    const clearAttentionItem = this.delegate?.clearAttentionItem;
    if (clearAttentionItem === undefined) {
      return { outcome: 'refused', reasonCode: 'not-configured' };
    }
    const request = {
      action: 'resolve',
      projectId: command.projectId,
      kind: command.kind as ChainAttentionKind,
      subject: subjectOf(command),
      reason: 'resolved',
    };
    try {
      const answer = await clearAttentionItem(request, CHAIN_ATTENTION_CLEAR_VIA, CHAIN_ATTENTION_ACTOR);
      if (isPlainObject(answer) && (answer.outcome === 'cleared' || answer.outcome === 'unchanged' || answer.outcome === 'not-found')) {
        return { outcome: answer.outcome, reasonCode: null };
      }
      if (isPlainObject(answer) && answer.outcome === 'refused') {
        return { outcome: 'refused', reasonCode: typeof answer.code === 'string' ? answer.code : 'unreadable' };
      }
      return { outcome: 'refused', reasonCode: 'unreadable' };
    } catch {
      return { outcome: 'refused', reasonCode: 'unreadable' };
    }
  }
}
