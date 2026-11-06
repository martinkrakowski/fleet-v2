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

const CHAIN_ATTENTION_KINDS: readonly string[] = [
  'chain-refresh-conflict',
  'link-not-landed',
  'branch-moved',
  'chain-refresh-mode-invalid',
];

/** The policy-level kind: no chain is named; the item names the configuration key. */
const CHAIN_ATTENTION_POLICY_KIND = 'chain-refresh-mode-invalid';

const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Supplier-side delegates; the composition root binds the real use cases. */
export interface ChainAttentionDelegate {
  readonly recordAttentionItem?: (body: unknown, actor: string) => Promise<unknown>;
  readonly clearAttentionItem?: (request: unknown, via: string, actor: string) => Promise<unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The subject of a chain attention item: the chain run, the link pull request when one is named, or the project for the policy-level kind. */
function subjectOf(command: ChainAttentionCommand): { readonly kind: string; readonly ref: string } {
  const link = command.linkPullRequest;
  if (link !== undefined) {
    return { kind: 'pr', ref: `${link.owner}/${link.repo}#${link.number}` };
  }
  if (command.kind === CHAIN_ATTENTION_POLICY_KIND) {
    return { kind: 'project', ref: command.projectId };
  }
  return { kind: 'run', ref: command.chainName ?? '' };
}

/** The fixed summary: the kind, the chain and its repository, composed here, never caller text. */
function summaryOf(command: ChainAttentionCommand): string {
  if (command.kind === CHAIN_ATTENTION_POLICY_KIND) {
    return `${command.kind} policy.daemon.chainRefresh repo=${command.repository.owner}/${command.repository.repo}`;
  }
  return `${command.kind} chain=${command.chainName ?? ''} repo=${command.repository.owner}/${command.repository.repo}`;
}

/** An own data property only: an accessor reads as undefined and never runs. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function isSegment(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_SEGMENT_PATTERN.test(value) && value !== '.' && value !== '..';
}

function snapshotRepository(raw: unknown): { readonly owner: string; readonly repo: string } | null {
  const owner = ownValue(raw, 'owner');
  const repo = ownValue(raw, 'repo');
  return isSegment(owner) && isSegment(repo) ? { owner, repo } : null;
}

function snapshotLink(raw: unknown): ChainAttentionCommand['linkPullRequest'] | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const target = snapshotRepository(raw);
  const number = ownValue(raw, 'number');
  if (target === null || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return null;
  }
  return { owner: target.owner, repo: target.repo, number };
}

/**
 * Copy the command from its own data properties into a plain value, or null when it is
 * malformed. Never throws and never runs an accessor.
 */
function snapshotCommand(raw: unknown): ChainAttentionCommand | null {
  try {
    if (!isPlainObject(raw)) {
      return null;
    }
    const projectId = ownValue(raw, 'projectId');
    const chainName = ownValue(raw, 'chainName');
    const kind = ownValue(raw, 'kind');
    const repository = snapshotRepository(ownValue(raw, 'repository'));
    const link = snapshotLink(ownValue(raw, 'linkPullRequest'));
    if (
      typeof projectId !== 'string' ||
      projectId.length === 0 ||
      typeof kind !== 'string' ||
      !CHAIN_ATTENTION_KINDS.includes(kind) ||
      repository === null ||
      link === null
    ) {
      return null;
    }
    if (kind === CHAIN_ATTENTION_POLICY_KIND) {
      // The policy-level item names the configuration key, never a chain.
      if (chainName !== undefined) {
        return null;
      }
      const policyBase = { projectId, repository, kind: kind as ChainAttentionKind };
      return link === undefined ? policyBase : { ...policyBase, linkPullRequest: link };
    }
    if (typeof chainName !== 'string' || parseChainName(chainName) === undefined) {
      return null;
    }
    const base = { projectId, repository, chainName, kind: kind as ChainAttentionKind };
    return link === undefined ? base : { ...base, linkPullRequest: link };
  } catch {
    return null;
  }
}

export class ChainAttentionAdapter implements ChainAttentionPort {
  constructor(private readonly delegate?: ChainAttentionDelegate) {}

  async raiseChainAttention(raw: ChainAttentionCommand): Promise<RaiseChainAttentionResult> {
    const command = snapshotCommand(raw);
    if (command === null) {
      return { outcome: 'refused', reasonCode: 'invalid-request' };
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

  async clearChainAttention(raw: ChainAttentionCommand): Promise<ClearChainAttentionResult> {
    const command = snapshotCommand(raw);
    if (command === null) {
      return { outcome: 'refused', reasonCode: 'invalid-request' };
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
