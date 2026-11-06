/**
 * ReviewChainUseCase (lane CO9), with the pure chain-review rules it applies
 * (the rules sit in this file: the use-case barrel is generated and a separate
 * rules module would be drift). The rules take no clock, do no I/O and never
 * throw; every rejection is a fixed code.
 *
 * Start or complete the combined pre-merge
 * review of one chain. Start reads the chain record and tip, gathers the links
 * (lane runs against `chain/<name>`), lists the open pull requests against the
 * chain, checks the reviewer is independent of every implementer, pins the tip
 * on the record by compare-and-set and requests one `pre-merge` review on the
 * chain subject under the key `chain-review/<name>@<head12>`. Complete refuses
 * when the tip moved past the pin, reads the chain receipt and aggregates each
 * link's own attempt `pre-merge` receipt. Unknown stays unknown: an unreadable
 * read, a missing receipt or an unknown verdict is never a pass. No clock of
 * its own, no logging, no path, diff or reviewer text; every reason is a fixed
 * code and no call throws out of this use case.
 */

import { attemptIdForChain, isSameModelFamily, underlyingModelFamily } from '@fleet/evidence-and-acceptance';
import { containsSecretShape } from '@fleet/shared';
import { resolveLaneRunBaseBranch } from '../../domain/base-branch.js';
import {
  isChainCommitSha,
  parseChainName,
  parseChainRepository,
  reviewPinOf,
} from '../../domain/chain-records.js';
import type { ChainRecord } from '../../domain/chain-records.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { AttemptRecord } from '../../domain/execution-records.js';
import type { TelemetryHashInput } from '../../domain/run-telemetry-ids.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { MERGE_QUEUE_TERMINAL_STATES } from '../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import { implementerModelsOf } from '../../domain/seat-selection.js';
import type {
  ChainLinkReceiptProjection,
  ReviewChainCompleteCommand,
  ReviewChainCompleteResult,
  ReviewChainPort,
  ReviewChainReason,
  ReviewChainStartCommand,
  ReviewChainStartResult,
} from '../ports/in/ReviewChainPort.in-port.js';
import type { AcceptanceReceiptReadPort } from '../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ChainRepositoryPort } from '../ports/out/ChainRepositoryPort.out-port.js';
import type { ForgeReadPort } from '../ports/out/ForgeReadPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { MergeForgeActionPort } from '../ports/out/MergeForgeActionPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type {
  ReviewRequestPort,
  ReviewRequestResult,
} from '../ports/out/ReviewRequestPort.out-port.js';

export type ChainReviewReason = ReviewChainReason;

export const CHAIN_REVIEW_MAX_CHAIN_NAME = 200;
export const CHAIN_REVIEW_MAX_LINKS = 50;
export const CHAIN_REVIEW_MAX_ATTEMPT_ID_BYTES = 256;
export const CHAIN_REVIEW_MAX_MODEL_BYTES = 200;
const REQUEST_ID_MAX_LENGTH = 128;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface ChainReviewLinkRef {
  readonly pullRequestNumber: number;
  readonly attemptId: string;
}

/** A start command that passed `parseChainReviewCommand`. */
export interface ChainReviewCommand {
  readonly projectId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly chainName: string;
  readonly branchName: string;
  readonly headSha: string;
  readonly links: readonly ChainReviewLinkRef[];
  readonly policyRevision: string;
  readonly reviewerModel: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
}

/** A complete command that passed `parseChainReviewCompleteCommand`. */
export interface ChainReviewCompleteInput {
  readonly projectId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly chainName: string;
  readonly branchName: string;
  readonly requestId: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
}

export type ChainReviewParse<T> =
  | { readonly ok: true; readonly command: T }
  | { readonly ok: false; readonly reason: ChainReviewReason };

const INVALID = Object.freeze({ ok: false, reason: 'invalid-request' } as const);

function own(source: unknown, key: string): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(source, key)?.value;
  } catch {
    return undefined;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** A bounded, printable, secret-free text of at most `maxBytes` bytes. */
function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    byteLength(value) <= maxBytes &&
    !CONTROL_CHARACTERS.test(value) &&
    !containsSecretShape(value)
  );
}

function parseProjectId(value: unknown): string | undefined {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value) && !containsSecretShape(value) ? value : undefined;
}

/**
 * The chain name reviewed under a request id that must fit the evidence pattern
 * (`chain-review:<name>:<head12>` in at most 128 characters), so a name that is
 * valid for a chain but too long for the request id is refused, not truncated.
 */
function parseReviewableChainName(value: unknown): string | undefined {
  const name = parseChainName(value);
  if (name === undefined || name.length > CHAIN_REVIEW_MAX_CHAIN_NAME) {
    return undefined;
  }
  return chainReviewRequestIdOf(name, '0'.repeat(40)).length <= REQUEST_ID_MAX_LENGTH ? name : undefined;
}

function chainReviewRequestIdOf(chainName: string, headSha: string): string {
  return `chain-review:${chainName}:${headSha.slice(0, 12)}`;
}

/** Zoned instants that are both valid; nothing else is accepted. */
function parseInstants(source: unknown): { readonly nowIso: string; readonly deadlineIso: string } | undefined {
  const nowIso = own(source, 'nowIso');
  const deadlineIso = own(source, 'deadlineIso');
  return isZonedIsoDateTime(nowIso) && isZonedIsoDateTime(deadlineIso) ? { nowIso, deadlineIso } : undefined;
}

function parseLinks(value: unknown): readonly ChainReviewLinkRef[] | undefined {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length > CHAIN_REVIEW_MAX_LINKS) {
    return undefined;
  }
  const links: ChainReviewLinkRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    // A hole, a getter or a non-data slot is refused: the element is read as its own data property.
    const element = Object.getOwnPropertyDescriptor(value, String(index))?.value;
    const pullRequestNumber = own(element, 'pullRequestNumber');
    const attemptId = own(element, 'attemptId');
    if (
      typeof pullRequestNumber !== 'number' || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1 ||
      !isBoundedText(attemptId, CHAIN_REVIEW_MAX_ATTEMPT_ID_BYTES)
    ) {
      return undefined;
    }
    links.push(Object.freeze({ pullRequestNumber, attemptId }));
  }
  return Object.freeze(links);
}

/**
 * A start command, normalised: `nowIso` and `deadlineIso` are required here (the
 * use case supplies its clock and default budget first), `links` is optional and,
 * when present, a dense array of at most 50 `{ pullRequestNumber, attemptId }`.
 * A present `subjectKind` must be `chain`: this review has no other subject.
 * Never throws; every rejection is `invalid-request`.
 */
export function parseChainReviewCommand(input: unknown): ChainReviewParse<ChainReviewCommand> {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return INVALID;
    }
    const subjectKind = own(input, 'subjectKind');
    if (subjectKind !== undefined && subjectKind !== 'chain') {
      return INVALID;
    }
    const projectId = parseProjectId(own(input, 'projectId'));
    const repository = parseChainRepository(own(input, 'repository'));
    const chainName = parseReviewableChainName(own(input, 'chainName'));
    const headSha = own(input, 'headSha');
    const policyRevision = own(input, 'policyRevision');
    const reviewerModel = own(input, 'reviewerModel');
    const instants = parseInstants(input);
    const links = parseLinks(own(input, 'links'));
    if (
      projectId === undefined || repository === undefined || chainName === undefined || !isChainCommitSha(headSha) ||
      !isBoundedText(policyRevision, CHAIN_REVIEW_MAX_MODEL_BYTES) ||
      !isBoundedText(reviewerModel, CHAIN_REVIEW_MAX_MODEL_BYTES) ||
      instants === undefined || links === undefined
    ) {
      return INVALID;
    }
    return {
      ok: true,
      command: Object.freeze({
        projectId, repository, chainName, branchName: `chain/${chainName}`, headSha, links,
        policyRevision, reviewerModel, nowIso: instants.nowIso, deadlineIso: instants.deadlineIso,
      }),
    };
  } catch {
    return INVALID;
  }
}

/** A complete command, normalised the same way; the request id must match the evidence pattern. */
export function parseChainReviewCompleteCommand(input: unknown): ChainReviewParse<ChainReviewCompleteInput> {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return INVALID;
    }
    const projectId = parseProjectId(own(input, 'projectId'));
    const repository = parseChainRepository(own(input, 'repository'));
    const chainName = parseReviewableChainName(own(input, 'chainName'));
    const requestId = own(input, 'requestId');
    const instants = parseInstants(input);
    if (
      projectId === undefined || repository === undefined || chainName === undefined ||
      typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId) || containsSecretShape(requestId) ||
      instants === undefined
    ) {
      return INVALID;
    }
    return {
      ok: true,
      command: Object.freeze({
        projectId, repository, chainName, branchName: `chain/${chainName}`, requestId,
        nowIso: instants.nowIso, deadlineIso: instants.deadlineIso,
      }),
    };
  } catch {
    return INVALID;
  }
}

/** Exactly `chain-review/<name>@<head12>`: 12 lowercase hex of the head. */
export function chainReviewKey(chainName: string, headSha: string): string {
  return `chain-review/${chainName}@${headSha.slice(0, 12)}`;
}

/**
 * The review's request id, derived from the chain name and the head only. The
 * key itself holds `/` and `@`, which the evidence request-id pattern refuses,
 * so the id is `chain-review:<name>:<head12>`; it is the idempotence key.
 */
export function chainReviewRequestId(chainName: string, headSha: string): string {
  return chainReviewRequestIdOf(chainName, headSha);
}

/** True when `nowIso` is strictly before `deadlineIso`; an invalid instant is no budget. */
export function isBudgetLeft(nowIso: string, deadlineIso: string): boolean {
  try {
    if (!isZonedIsoDateTime(nowIso) || !isZonedIsoDateTime(deadlineIso)) {
      return false;
    }
    return Date.parse(nowIso) < Date.parse(deadlineIso);
  } catch {
    return false;
  }
}

function isModelName(value: unknown): value is string {
  return isBoundedText(value, CHAIN_REVIEW_MAX_MODEL_BYTES);
}

/**
 * True when no implementer model shares the reviewer's underlying model family.
 * An empty implementer list is unknown, not independent; so is any model name
 * that is empty, oversized or has no family (an empty family never proves
 * independence).
 */
export function isIndependentReviewer(reviewerModel: string, implementerModels: readonly string[]): boolean {
  try {
    if (!isModelName(reviewerModel) || !Array.isArray(implementerModels) || implementerModels.length === 0) {
      return false;
    }
    const reviewerFamily = underlyingModelFamily(reviewerModel);
    for (let index = 0; index < implementerModels.length; index += 1) {
      const implementer = Object.getOwnPropertyDescriptor(implementerModels, String(index))?.value;
      if (!isModelName(implementer) || reviewerModel.trim() === implementer.trim()) {
        return false;
      }
      if (isSameModelFamily(reviewerFamily, underlyingModelFamily(implementer))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** What the use case read of the chain's links, forge and attempts, in the order it read them. */
export interface ChainReviewStartFacts {
  readonly chainName: string;
  readonly headSha: string;
  readonly reviewerModel: string;
  /** `unreadable`: the lane runs, attempts or merge queue could not be read. */
  readonly links: 'unreadable' | readonly { readonly settled: boolean }[];
  /** `skipped`: not read because an earlier gate already decided. */
  readonly openPullRequests: 'skipped' | 'unreadable' | number;
  /** `null`: the implementer models could not be established. */
  readonly implementerModels: readonly string[] | null;
}

export type ChainReviewStartDecision =
  | {
      readonly outcome: 'proceed';
      readonly key: string;
      readonly requestId: string;
      readonly headSha: string;
    }
  | {
      readonly outcome: 'refused';
      readonly reason: 'link-unsettled' | 'integration-pr-open' | 'implementer-models-unknown' | 'reviewer-not-independent';
    }
  | { readonly outcome: 'unknown'; readonly reason: 'store-unavailable' | 'forge-unavailable' };

const UNKNOWN_STORE = Object.freeze({ outcome: 'unknown', reason: 'store-unavailable' } as const);
const UNKNOWN_FORGE = Object.freeze({ outcome: 'unknown', reason: 'forge-unavailable' } as const);

/**
 * The ordered gates of the contract: an unreadable store is unknown; a link that
 * is not settled refuses; an unreadable forge is unknown; an open pull request
 * against the chain refuses; implementer models that cannot be established
 * refuse; a reviewer that shares a family with one of them refuses. Anything
 * not read is never a pass.
 */
export function decideChainReviewStart(facts: ChainReviewStartFacts): ChainReviewStartDecision {
  try {
    if (facts.links === 'unreadable' || !Array.isArray(facts.links)) {
      return UNKNOWN_STORE;
    }
    if (facts.links.some((link) => link.settled !== true)) {
      return Object.freeze({ outcome: 'refused', reason: 'link-unsettled' } as const);
    }
    if (typeof facts.openPullRequests !== 'number') {
      return UNKNOWN_FORGE;
    }
    if (!Number.isSafeInteger(facts.openPullRequests) || facts.openPullRequests < 0) {
      return UNKNOWN_FORGE;
    }
    if (facts.openPullRequests > 0) {
      return Object.freeze({ outcome: 'refused', reason: 'integration-pr-open' } as const);
    }
    if (facts.implementerModels === null || facts.implementerModels.length === 0) {
      return Object.freeze({ outcome: 'refused', reason: 'implementer-models-unknown' } as const);
    }
    if (!isIndependentReviewer(facts.reviewerModel, facts.implementerModels)) {
      return Object.freeze({ outcome: 'refused', reason: 'reviewer-not-independent' } as const);
    }
    return Object.freeze({
      outcome: 'proceed',
      key: chainReviewKey(facts.chainName, facts.headSha),
      requestId: chainReviewRequestId(facts.chainName, facts.headSha),
      headSha: facts.headSha,
    });
  } catch {
    return UNKNOWN_STORE;
  }
}

/** One review receipt of an attempt at one head, as the receipt port projects it. */
export interface ChainLinkReceiptCandidate {
  readonly receiptId: TelemetryHashInput;
  readonly kind: string;
  readonly result: string;
  readonly findings: {
    readonly blocker: number;
    readonly major: number;
    readonly minor: number;
    readonly nit: number;
  };
  readonly completedAtIso: string;
}

export interface ChainLinkReceiptInput {
  readonly pullRequestNumber: number;
  readonly attemptId: string;
  /** The attempt's review receipts at the link's head; an empty list is a link without a receipt. */
  readonly receipts: readonly ChainLinkReceiptCandidate[];
}

export type ChainLinkAggregate =
  | { readonly ok: true; readonly links: readonly ChainLinkReceiptProjection[] }
  | { readonly ok: false; readonly reason: 'link-receipt-missing' | 'verdict-unknown' };

const MISSING = Object.freeze({ ok: false, reason: 'link-receipt-missing' } as const);
const UNKNOWN_VERDICT = Object.freeze({ ok: false, reason: 'verdict-unknown' } as const);

function instantMs(value: unknown): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * One projection per link, from the link's latest `pre-merge` review receipt. A
 * link with no `pre-merge` receipt is `link-receipt-missing`; a latest receipt
 * whose result is neither a pass nor a fail (pending, unknown, not applicable) is
 * `verdict-unknown`; a fail is reported as a fail. Nothing else of a receipt is
 * copied: the receipt id stays the hash input the receipt port returned.
 */
export function aggregateLinkReceipts(links: readonly ChainLinkReceiptInput[]): ChainLinkAggregate {
  try {
    // A chain with no link has nothing to land: an empty list is never a pass.
    if (!Array.isArray(links) || links.length === 0 || links.length > CHAIN_REVIEW_MAX_LINKS) {
      return MISSING;
    }
    const projections: ChainLinkReceiptProjection[] = [];
    for (let index = 0; index < links.length; index += 1) {
      const link = Object.getOwnPropertyDescriptor(links, String(index))?.value;
      const pullRequestNumber = own(link, 'pullRequestNumber');
      const attemptId = own(link, 'attemptId');
      const receipts = own(link, 'receipts');
      if (
        typeof pullRequestNumber !== 'number' || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1 ||
        !isBoundedText(attemptId, CHAIN_REVIEW_MAX_ATTEMPT_ID_BYTES) || !Array.isArray(receipts)
      ) {
        return MISSING;
      }
      let latest: ChainLinkReceiptCandidate | undefined;
      for (let at = 0; at < receipts.length; at += 1) {
        const candidate = Object.getOwnPropertyDescriptor(receipts, String(at))?.value as ChainLinkReceiptCandidate | undefined;
        if (own(candidate, 'kind') !== 'pre-merge') {
          continue;
        }
        if (latest === undefined || instantMs(own(candidate, 'completedAtIso')) >= instantMs(own(latest, 'completedAtIso'))) {
          latest = candidate;
        }
      }
      if (latest === undefined) {
        return MISSING;
      }
      const result = own(latest, 'result');
      const findings = own(latest, 'findings');
      const completedAtIso = own(latest, 'completedAtIso');
      const receiptId = own(latest, 'receiptId') as TelemetryHashInput | undefined;
      if (result !== 'pass' && result !== 'fail') {
        return UNKNOWN_VERDICT;
      }
      const blocker = own(findings, 'blocker');
      const major = own(findings, 'major');
      const minor = own(findings, 'minor');
      const nit = own(findings, 'nit');
      if (
        receiptId === undefined || typeof receiptId !== 'object' || receiptId === null || typeof completedAtIso !== 'string' ||
        !isCount(blocker) || !isCount(major) || !isCount(minor) || !isCount(nit)
      ) {
        return UNKNOWN_VERDICT;
      }
      projections.push(
        Object.freeze({
          pullRequestNumber,
          attemptId,
          receiptId,
          result,
          kind: 'pre-merge' as const,
          findings: Object.freeze({ blocker, major, minor, nit }),
          completedAtIso,
        }),
      );
    }
    return { ok: true, links: Object.freeze(projections) };
  } catch {
    return MISSING;
  }
}


export interface ReviewChainDependencies {
  readonly chains: ChainRepositoryPort;
  readonly forge: ForgeReadPort;
  readonly branches: Pick<MergeForgeActionPort, 'readMergeBranchHead'>;
  readonly reviews: ReviewRequestPort;
  readonly receipts: AcceptanceReceiptReadPort;
  readonly laneRuns: Pick<LaneRunRepositoryPort, 'list'>;
  readonly attempts: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  readonly mergeQueue: Pick<MergeQueueRepositoryPort, 'listMergeEntries'>;
  /** The fallback when a command carries no `nowIso`; without both, the command is invalid. */
  readonly clock?: () => string;
}

/** The budget a command without `deadlineIso` gets, from its own `nowIso`. */
const DEFAULT_BUDGET_MS = 5 * 60 * 1000;
const TERMINAL_STATES: readonly string[] = MERGE_QUEUE_TERMINAL_STATES;

type Fail = { readonly outcome: 'refused' | 'unknown'; readonly reason: ReviewChainReason };

function refusedWith(reason: ReviewChainReason): Fail {
  return { outcome: 'refused', reason };
}

function unknownWith(reason: ReviewChainReason): Fail {
  return { outcome: 'unknown', reason };
}

/** One link of the chain: a lane run against `chain/<name>` with its pull request and last attempt. */
interface ChainLink {
  readonly pullRequestNumber: number | null;
  readonly attemptId: string | null;
  readonly headSha: string | null;
  readonly settled: boolean;
}

interface GatheredLinks {
  readonly links: readonly ChainLink[];
  readonly attempts: readonly AttemptRecord[];
}

type Prepared =
  | { readonly ok: true; readonly record: ChainRecord; readonly tipSha: string }
  | { readonly ok: false; readonly fail: Fail };

/** The review port's refusal, in this port's closed vocabulary. */
function reasonOfReviewRefusal(reason: string): ReviewChainReason {
  switch (reason) {
    case 'invalid-request':
      return 'invalid-request';
    case 'not-configured':
      return 'review-not-configured';
    case 'not-independent':
      return 'reviewer-not-independent';
    case 'subject-not-implemented':
      return 'subject-not-implemented';
    default:
      return 'review-refused';
  }
}

export class ReviewChainUseCase implements ReviewChainPort {
  constructor(private readonly deps: ReviewChainDependencies) {}

  async startChainReview(command: ReviewChainStartCommand): Promise<ReviewChainStartResult> {
    try {
      const parsed = parseChainReviewCommand(this.normalizeStart(command));
      if (!parsed.ok) {
        return refusedWith(parsed.reason);
      }
      if (!isBudgetLeft(parsed.command.nowIso, parsed.command.deadlineIso)) {
        return refusedWith('budget-exhausted');
      }
      return await this.runStart(parsed.command);
    } catch {
      return unknownWith('store-unavailable');
    }
  }

  async completeChainReview(command: ReviewChainCompleteCommand): Promise<ReviewChainCompleteResult> {
    try {
      const parsed = parseChainReviewCompleteCommand(this.normalizeComplete(command));
      if (!parsed.ok) {
        return refusedWith(parsed.reason);
      }
      if (!isBudgetLeft(parsed.command.nowIso, parsed.command.deadlineIso)) {
        return refusedWith('budget-exhausted');
      }
      return await this.runComplete(parsed.command);
    } catch {
      return unknownWith('store-unavailable');
    }
  }

  // ---------- command normalisation ----------

  /** `nowIso` wins over the clock; a missing deadline is `nowIso` plus the default budget. */
  private instants(command: unknown): { nowIso: unknown; deadlineIso: unknown } {
    let nowIso = own(command, 'nowIso');
    if (nowIso === undefined && this.deps.clock !== undefined) {
      try {
        nowIso = this.deps.clock();
      } catch {
        nowIso = undefined;
      }
    }
    let deadlineIso = own(command, 'deadlineIso');
    if (deadlineIso === undefined && typeof nowIso === 'string' && !Number.isNaN(Date.parse(nowIso))) {
      deadlineIso = new Date(Date.parse(nowIso) + DEFAULT_BUDGET_MS).toISOString();
    }
    return { nowIso, deadlineIso };
  }

  private normalizeStart(command: unknown): unknown {
    return {
      projectId: own(command, 'projectId'),
      repository: own(command, 'repository'),
      chainName: own(command, 'chainName'),
      headSha: own(command, 'chainHeadSha'),
      policyRevision: own(command, 'policyRevision'),
      reviewerModel: own(command, 'reviewerModel'),
      ...this.instants(command),
    };
  }

  private normalizeComplete(command: unknown): unknown {
    return {
      projectId: own(command, 'projectId'),
      repository: own(command, 'repository'),
      chainName: own(command, 'chainName'),
      requestId: own(command, 'requestId'),
      ...this.instants(command),
    };
  }

  /** The budget between two outbound calls: the injected clock when there is one, else the command's own instant. */
  private budgetLeft(nowIso: string, deadlineIso: string): boolean {
    let now = nowIso;
    if (this.deps.clock !== undefined) {
      try {
        now = this.deps.clock();
      } catch {
        return false;
      }
    }
    return isBudgetLeft(now, deadlineIso);
  }

  // ---------- shared reads ----------

  /** The chain record (started, for this repository and chain) and the chain branch tip. */
  private async prepare(command: {
    readonly repository: { readonly owner: string; readonly repo: string };
    readonly chainName: string;
    readonly branchName: string;
    readonly deadlineIso: string;
  }): Promise<Prepared> {
    let read: Awaited<ReturnType<ChainRepositoryPort['readChain']>>;
    try {
      read = await this.deps.chains.readChain({
        repository: command.repository,
        chainName: command.chainName,
        deadlineIso: command.deadlineIso,
      });
    } catch {
      return { ok: false, fail: unknownWith('chain-unreadable') };
    }
    if (read.status === 'not-found') {
      return { ok: false, fail: refusedWith('chain-not-found') };
    }
    if (read.status !== 'ok') {
      return { ok: false, fail: unknownWith('chain-unreadable') };
    }
    const record = read.record;
    if (
      record.chainName !== command.chainName ||
      record.branchName !== command.branchName ||
      record.repository.owner !== command.repository.owner ||
      record.repository.repo !== command.repository.repo
    ) {
      return { ok: false, fail: unknownWith('chain-unreadable') };
    }
    if (record.state !== 'started') {
      return { ok: false, fail: refusedWith('chain-not-found') };
    }
    let head: Awaited<ReturnType<MergeForgeActionPort['readMergeBranchHead']>>;
    try {
      head = await this.deps.branches.readMergeBranchHead({
        repository: command.repository,
        branchName: command.branchName,
        deadlineIso: command.deadlineIso,
      });
    } catch {
      return { ok: false, fail: unknownWith('forge-unavailable') };
    }
    if (head.outcome === 'not-found') {
      return { ok: false, fail: refusedWith('chain-not-found') };
    }
    if (head.outcome !== 'found' || !isChainCommitSha(head.headSha)) {
      return { ok: false, fail: unknownWith('forge-unavailable') };
    }
    return { ok: true, record, tipSha: head.headSha };
  }

  /**
   * The chain's links: every lane run whose resolved base is `chain/<name>`, with
   * its pull request and last attempt. A link is settled only when its last
   * attempt has a collected completion receipt and head, and its pull request's
   * merge-queue entries are all terminal with one merged. `null`: a read failed.
   */
  private async gatherLinks(command: {
    readonly repository: { readonly owner: string; readonly repo: string };
    readonly branchName: string;
    readonly deadlineIso: string;
  }): Promise<GatheredLinks | null> {
    let runs: readonly LaneRunRecord[];
    let entries: readonly MergeQueueEntryRecord[];
    try {
      runs = (await this.deps.laneRuns.list()).filter((run) => resolveLaneRunBaseBranch(run) === command.branchName);
      entries = await this.deps.mergeQueue.listMergeEntries({
        repository: command.repository,
        deadlineIso: command.deadlineIso,
      });
    } catch {
      return null;
    }
    const links: ChainLink[] = [];
    const allAttempts: AttemptRecord[] = [];
    for (const run of runs) {
      const attempts: AttemptRecord[] = [];
      for (const attemptId of run.attemptIds) {
        let attempt: AttemptRecord | null;
        try {
          attempt = await this.deps.attempts.findAttemptById(attemptId);
        } catch {
          return null;
        }
        if (attempt === null) {
          return null;
        }
        attempts.push(attempt);
      }
      allAttempts.push(...attempts);
      const last = attempts.length === 0 ? undefined : attempts[attempts.length - 1];
      const headSha = last?.artifacts?.headCommit ?? null;
      const pullRequest = run.prNumber;
      const linkEntries = pullRequest === null ? [] : entries.filter((entry) => entry.pullRequest === pullRequest);
      const queueSettled =
        linkEntries.length > 0 &&
        linkEntries.every((entry) => TERMINAL_STATES.includes(entry.state)) &&
        linkEntries.some((entry) => entry.state === 'merged');
      links.push({
        pullRequestNumber: pullRequest,
        attemptId: last?.id ?? null,
        headSha: headSha !== null && isChainCommitSha(headSha) ? headSha : null,
        settled:
          pullRequest !== null &&
          last !== undefined &&
          last.completionReceipt !== null &&
          headSha !== null &&
          isChainCommitSha(headSha) &&
          queueSettled,
      });
    }
    return { links, attempts: allAttempts };
  }

  // ---------- start ----------

  private async runStart(command: ChainReviewCommand): Promise<ReviewChainStartResult> {
    const prepared = await this.prepare(command);
    if (!prepared.ok) {
      return prepared.fail;
    }
    if (prepared.tipSha !== command.headSha) {
      return refusedWith('chain-tip-moved');
    }

    const gathered = await this.gatherLinks(command);
    const linkFacts = gathered === null ? ('unreadable' as const) : gathered.links.map((link) => ({ settled: link.settled }));
    // The pull-request read is skipped when the links already decide (unreadable or one unsettled).
    if (gathered === null || gathered.links.some((link) => !link.settled)) {
      const early = decideChainReviewStart({
        chainName: command.chainName,
        headSha: command.headSha,
        reviewerModel: command.reviewerModel,
        links: linkFacts,
        openPullRequests: 'skipped',
        implementerModels: null,
      });
      return early.outcome === 'proceed' ? unknownWith('store-unavailable') : early;
    }

    if (!this.budgetLeft(command.nowIso, command.deadlineIso)) {
      return refusedWith('budget-exhausted');
    }
    const openPullRequests = await this.countOpenPullRequests(command);
    const models = implementerModelsOf(gathered.attempts);
    const decision = decideChainReviewStart({
      chainName: command.chainName,
      headSha: command.headSha,
      reviewerModel: command.reviewerModel,
      links: linkFacts,
      openPullRequests,
      implementerModels: models.ok ? models.models : null,
    });
    if (decision.outcome !== 'proceed') {
      return decision;
    }
    const implementerModels = models.ok ? [...models.models].sort() : [];

    if (!this.budgetLeft(command.nowIso, command.deadlineIso)) {
      return refusedWith('budget-exhausted');
    }
    const pinned = await this.pinTip(command, prepared.record, {
      headSha: decision.headSha,
      requestId: decision.requestId,
      key: decision.key,
      pinnedAtIso: command.nowIso,
    });
    if (pinned.outcome !== 'pinned') {
      return pinned;
    }

    // A pin that was already on the record may have a review behind it: the receipt answers, no second review runs.
    if (pinned.already) {
      const existing = await this.findChainReceipt(command, decision.requestId, decision.headSha);
      if (existing.outcome === 'found') {
        return this.started(decision, command.reviewerModel, existing.reviewerModel);
      }
      if (existing.outcome === 'fail') {
        return existing.fail;
      }
    }

    if (!this.budgetLeft(command.nowIso, command.deadlineIso)) {
      return refusedWith('budget-exhausted');
    }
    let result: ReviewRequestResult;
    try {
      result = await this.deps.reviews.requestReview({
        requestId: decision.requestId,
        kind: 'pre-merge',
        attemptId: attemptIdForChain(command.projectId, command.chainName),
        projectId: command.projectId,
        candidateHeadSha: decision.headSha,
        subject: {
          kind: 'chain',
          projectId: command.projectId,
          chainName: command.chainName,
          integrationHeadSha: decision.headSha,
        },
        policyRevision: command.policyRevision,
        implementerModel: implementerModels[0],
        reviewerModel: command.reviewerModel,
        diffSummary: `Combined review of chain ${command.chainName} against main at ${decision.headSha.slice(0, 12)}`,
        nowIso: command.nowIso,
      });
    } catch {
      return unknownWith('review-unknown');
    }
    switch (result.outcome) {
      case 'receipt':
        return this.started(decision, command.reviewerModel, result.receipt.reviewerModel);
      case 'no-receipt':
        return refusedWith('review-no-receipt');
      case 'refused':
        return refusedWith(reasonOfReviewRefusal(result.reason));
      default:
        return unknownWith('review-unknown');
    }
  }

  private started(
    decision: { readonly key: string; readonly requestId: string; readonly headSha: string },
    reviewerModel: string,
    recordedReviewerModel: string,
  ): ReviewChainStartResult {
    // The receipt names the model that really reviewed; the command's model is the fallback for an unnamed one.
    return {
      outcome: 'started',
      requestId: decision.requestId,
      key: decision.key,
      headSha: decision.headSha,
      reviewerModel: recordedReviewerModel.length > 0 ? recordedReviewerModel : reviewerModel,
    };
  }

  /** Open pull requests against `chain/<name>`: the count, or `unreadable`; never an empty list on failure. */
  private async countOpenPullRequests(command: ChainReviewCommand): Promise<number | 'unreadable'> {
    try {
      const listed = await this.deps.forge.listOpenPullRequestsByBase?.({
        base: command.branchName,
        repository: command.repository,
      });
      // A forge that cannot list is unreadable, never an empty list.
      return listed !== undefined && listed.outcome === 'listed' ? listed.pullRequests.length : 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  /**
   * Pin the tip by compare-and-set at the record's revision. A stale answer is
   * re-read once and retried once, then refused; `already-recorded` is the
   * idempotent repeat of the same key and head.
   */
  private async pinTip(
    command: ChainReviewCommand,
    record: ChainRecord,
    pin: { readonly headSha: string; readonly requestId: string; readonly key: string; readonly pinnedAtIso: string },
  ): Promise<{ readonly outcome: 'pinned'; readonly already: boolean } | Fail> {
    let revision = record.revision;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let decision: Awaited<ReturnType<NonNullable<ChainRepositoryPort['recordChainReviewPin']>>> | undefined;
      try {
        decision = await this.deps.chains.recordChainReviewPin?.({
          repository: command.repository,
          chainName: command.chainName,
          expectedRevision: revision,
          pin,
          deadlineIso: command.deadlineIso,
        });
      } catch {
        return unknownWith('store-unavailable');
      }
      if (decision === undefined) {
        return unknownWith('store-unavailable');
      }
      if (decision.outcome === 'recorded') {
        return { outcome: 'pinned', already: false };
      }
      if (decision.outcome === 'already-recorded') {
        return { outcome: 'pinned', already: true };
      }
      if (decision.reason === 'chain-unreadable') {
        return unknownWith('chain-unreadable');
      }
      if (decision.reason !== 'chain-record-stale') {
        return unknownWith('store-unavailable');
      }
      if (attempt === 1) {
        return refusedWith('chain-record-stale');
      }
      const reread = await this.prepareRecord(command);
      if (reread.outcome !== 'ok') {
        return reread.fail;
      }
      const stored = reviewPinOf(reread.record);
      if (stored !== null && (stored.key !== pin.key || stored.headSha !== pin.headSha)) {
        return refusedWith('chain-record-stale');
      }
      revision = reread.record.revision;
    }
    return refusedWith('chain-record-stale');
  }

  /** One more read of the record for the retry; the tip is not read again. */
  private async prepareRecord(
    command: ChainReviewCommand,
  ): Promise<{ readonly outcome: 'ok'; readonly record: ChainRecord } | { readonly outcome: 'fail'; readonly fail: Fail }> {
    try {
      const read = await this.deps.chains.readChain({
        repository: command.repository,
        chainName: command.chainName,
        deadlineIso: command.deadlineIso,
      });
      if (read.status === 'ok' && read.record.chainName === command.chainName) {
        return { outcome: 'ok', record: read.record };
      }
      return { outcome: 'fail', fail: read.status === 'not-found' ? refusedWith('chain-not-found') : unknownWith('chain-unreadable') };
    } catch {
      return { outcome: 'fail', fail: unknownWith('chain-unreadable') };
    }
  }

  // ---------- the chain receipt ----------

  /** The chain's combined receipt for the pinned request id, mapped into this port's codes. */
  private async findChainReceipt(
    command: { readonly projectId: string; readonly chainName: string },
    requestId: string,
    headSha: string,
  ): Promise<
    | { readonly outcome: 'found'; readonly receiptId: string; readonly reviewerModel: string; readonly verdict: 'passed' | 'failed' | 'unknown' }
    | { readonly outcome: 'not-found' }
    | { readonly outcome: 'fail'; readonly fail: Fail }
  > {
    let found: Awaited<ReturnType<ReviewRequestPort['findReviewReceipt']>>;
    try {
      found = await this.deps.reviews.findReviewReceipt({
        attemptId: attemptIdForChain(command.projectId, command.chainName),
        requestId,
        candidateHeadSha: headSha,
        subject: { kind: 'chain', projectId: command.projectId, chainName: command.chainName, integrationHeadSha: headSha },
      });
    } catch {
      return { outcome: 'fail', fail: unknownWith('store-unavailable') };
    }
    if (found.outcome === 'not-found') {
      return { outcome: 'not-found' };
    }
    if (found.outcome === 'unavailable') {
      switch (found.reason) {
        case 'receipt-mismatch':
          return { outcome: 'fail', fail: unknownWith('verdict-unknown') };
        case 'not-configured':
          return { outcome: 'fail', fail: refusedWith('review-not-configured') };
        case 'invalid-request':
          return { outcome: 'fail', fail: refusedWith('invalid-request') };
        default:
          return { outcome: 'fail', fail: unknownWith('store-unavailable') };
      }
    }
    const receipt = found.receipt;
    if (receipt.kind !== 'pre-merge' || receipt.candidateHeadSha !== headSha || receipt.requestId !== requestId) {
      return { outcome: 'fail', fail: unknownWith('verdict-unknown') };
    }
    return { outcome: 'found', receiptId: receipt.receiptId, reviewerModel: receipt.reviewerModel, verdict: receipt.verdict };
  }

  // ---------- complete ----------

  private async runComplete(command: ChainReviewCompleteInput): Promise<ReviewChainCompleteResult> {
    const prepared = await this.prepare(command);
    if (!prepared.ok) {
      return prepared.fail;
    }
    const pin = reviewPinOf(prepared.record);
    if (pin === null || pin.requestId !== command.requestId) {
      return refusedWith('receipt-missing');
    }
    if (prepared.tipSha !== pin.headSha) {
      return refusedWith('chain-tip-moved');
    }

    if (!this.budgetLeft(command.nowIso, command.deadlineIso)) {
      return refusedWith('budget-exhausted');
    }
    const receipt = await this.findChainReceipt(command, pin.requestId, pin.headSha);
    if (receipt.outcome === 'not-found') {
      return refusedWith('receipt-missing');
    }
    if (receipt.outcome === 'fail') {
      return receipt.fail;
    }
    if (receipt.verdict === 'unknown') {
      return unknownWith('verdict-unknown');
    }

    const gathered = await this.gatherLinks(command);
    if (gathered === null) {
      return unknownWith('store-unavailable');
    }
    if (gathered.links.some((link) => !link.settled)) {
      return refusedWith('link-unsettled');
    }

    const inputs: ChainLinkReceiptInput[] = [];
    for (const link of gathered.links) {
      if (!this.budgetLeft(command.nowIso, command.deadlineIso)) {
        return refusedWith('budget-exhausted');
      }
      // A settled link has a pull request, an attempt and a head by construction.
      if (link.pullRequestNumber === null || link.attemptId === null || link.headSha === null) {
        return refusedWith('link-unsettled');
      }
      let read: Awaited<ReturnType<AcceptanceReceiptReadPort['readReceiptsForHead']>>;
      try {
        read = await this.deps.receipts.readReceiptsForHead(link.attemptId, link.headSha);
      } catch {
        return unknownWith('store-unavailable');
      }
      if (read.outcome === 'none') {
        return refusedWith('link-receipt-missing');
      }
      if (read.outcome !== 'found') {
        return unknownWith('store-unavailable');
      }
      inputs.push({ pullRequestNumber: link.pullRequestNumber, attemptId: link.attemptId, receipts: read.review });
    }
    const aggregate = aggregateLinkReceipts(inputs);
    if (!aggregate.ok) {
      return aggregate.reason === 'link-receipt-missing' ? refusedWith(aggregate.reason) : unknownWith(aggregate.reason);
    }
    const links: readonly ChainLinkReceiptProjection[] = aggregate.links;
    const passed = receipt.verdict === 'passed' && links.every((link) => link.result === 'pass');
    return {
      outcome: 'completed',
      requestId: pin.requestId,
      receiptId: receipt.receiptId,
      reviewerModel: receipt.reviewerModel,
      verdict: passed ? 'passed' : 'failed',
      links,
    };
  }
}
