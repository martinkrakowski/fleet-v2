/**
 * LandChainUseCase (lane CO10): land one started, reviewed chain onto `main`.
 * The pass reads every link's pre-merge receipt at the pinned chain head,
 * opens or adopts the one integration pull request onto `main`, records a
 * keyed intent and a compare-and-set landing mark, re-checks the links and
 * unfinished batches after that mark, and only then enqueues the pull request
 * on the daemon merge queue. `dryRun` (the default) writes nothing.
 *
 * The rules take no clock of their own (the injected `nowIso`), mint no id
 * except through the injected `mintEntryId`, log nothing and never throw: an
 * unreadable read or an unknown verdict is `unknown`, every rejection is a
 * fixed reason code, and results carry shas, pull request numbers, chain
 * names and receipt hash inputs only — never a path, diff, forge title or
 * echoed request field.
 */

import { attemptIdForChain } from '@fleet/evidence-and-acceptance';
import { containsSecretShape } from '@fleet/shared';
import { resolveLaneRunBaseBranch } from '../../domain/base-branch.js';
import {
  chainRefreshOf,
  conflictMarkOf,
  isChainCommitSha,
  parseChainName,
  parseChainRepository,
  reviewPinOf,
} from '../../domain/chain-records.js';
import type { ChainRecord } from '../../domain/chain-records.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type { AttemptRecord } from '../../domain/execution-records.js';
import type { LaneRunRecord } from '../../domain/lane-run-records.js';
import { MERGE_QUEUE_TERMINAL_STATES } from '../../domain/merge-queue-records.js';
import type { MergeQueueEntryRecord } from '../../domain/merge-queue-records.js';
import type { LandChainPort, LandChainRefusal, LandChainResult, LandChainUnknown } from '../ports/in/LandChainPort.in-port.js';
import type { AcceptanceReceiptReadPort } from '../ports/out/AcceptanceReceiptReadPort.out-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { ChainLandingPort } from '../ports/out/ChainLandingPort.out-port.js';
import type { ChainRepositoryPort } from '../ports/out/ChainRepositoryPort.out-port.js';
import type { ForgeActionPort } from '../ports/out/ForgeActionPort.out-port.js';
import type { ForgeAncestryPort } from '../ports/out/ForgeAncestryPort.out-port.js';
import type { ForgeReadPort } from '../ports/out/ForgeReadPort.out-port.js';
import type { LaneRunRepositoryPort } from '../ports/out/LaneRunRepositoryPort.out-port.js';
import type { MergeForgeActionPort } from '../ports/out/MergeForgeActionPort.out-port.js';
import type { MergeQueueRepositoryPort } from '../ports/out/MergeQueueRepositoryPort.out-port.js';
import type { ReviewRequestPort } from '../ports/out/ReviewRequestPort.out-port.js';
import {
  aggregateLinkReceipts,
  type ChainLinkReceiptCandidate,
  type ChainLinkReceiptInput,
} from './ReviewChainUseCase.use-case.js';

export const LAND_CHAIN_MAX_LINKS = 50;
export const LAND_CHAIN_MAX_QUEUE_ENTRIES = 1000;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const COMMAND_MAX_KEYS = 6;

/** A command that passed `parseLandChainCommand`. */
export interface LandChainCommand {
  readonly projectId: string;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly chainName: string;
  readonly branchName: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
  /** Absent or `true` is a dry run; only `false` applies. */
  readonly dryRun: boolean;
}

const refused = (reason: LandChainRefusal): LandChainResult => ({ outcome: 'refused', reason });
const unknown = (reason: LandChainUnknown): LandChainResult => ({ outcome: 'unknown', reason });
const FAIL_STORE = unknown('store-unavailable');
const FAIL_JOURNAL = unknown('journal-unreadable');
const FAIL_FORGE = unknown('forge-unavailable');
const FAIL_QUEUE = unknown('queue-unreadable');
const FAIL_LOOKUP = unknown('head-lookup-unavailable');
const FAIL_BATCH = unknown('batch-unreadable');
const FAIL_BUDGET = unknown('budget-exhausted');
const FAIL_ID = unknown('id-unavailable');

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

/** True when any own enumerable string value is over-long or secret-shaped. */
function hasSecretShape(input: object): boolean {
  try {
    for (const key of Object.keys(input)) {
      const value = Object.getOwnPropertyDescriptor(input, key)?.value;
      if (typeof value === 'string' && (byteLength(value) > 256 || containsSecretShape(value))) {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

/** The adversarial command parser: no port call, never throws, secret scan before any validation. */
function parseLandChainCommand(input: unknown): LandChainCommand | LandChainResult {
  try {
    if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
      return refused('invalid-request');
    }
    if (Object.keys(input).length > COMMAND_MAX_KEYS) {
      return refused('invalid-request');
    }
    // The secret-shape scan runs before any field validation, so a secret is
    // never answered with a validation code.
    if (hasSecretShape(input)) {
      return refused('secret-shaped');
    }
    const projectIdValue = own(input, 'projectId');
    if (typeof projectIdValue !== 'string' || !PROJECT_ID_PATTERN.test(projectIdValue)) {
      return refused('invalid-request');
    }
    const repository = parseChainRepository(own(input, 'repository'));
    if (repository === undefined) {
      return refused('invalid-request');
    }
    const chainName = parseChainName(own(input, 'chainName'));
    if (chainName === undefined) {
      return refused('invalid-request');
    }
    const nowIso = own(input, 'nowIso');
    const deadlineIso = own(input, 'deadlineIso');
    if (!isZonedIsoDateTime(nowIso) || !isZonedIsoDateTime(deadlineIso)) {
      return refused('invalid-request');
    }
    const dryRunValue = own(input, 'dryRun');
    if (dryRunValue !== undefined && typeof dryRunValue !== 'boolean') {
      return refused('invalid-request');
    }
    return {
      projectId: projectIdValue,
      repository,
      chainName,
      branchName: `chain/${chainName}`,
      nowIso,
      deadlineIso,
      dryRun: dryRunValue !== false,
    };
  } catch {
    return refused('invalid-request');
  }
}

/** The canonical text the landing intent digest covers. */
export function canonicalLandChainPayload(input: {
  readonly chainName: string;
  readonly headSha: string;
  readonly dryRun: boolean;
  readonly step?: 'premerge' | 'enqueue';
}): string {
  return JSON.stringify({
    kind: 'chain-land',
    chainName: input.chainName,
    headSha: input.headSha,
    dryRun: input.dryRun,
    step: input.step ?? null,
  });
}

/** One link of the chain: a lane run against `chain/<name>` with its last attempt. */
interface LandChainLink {
  readonly pullRequestNumber: number;
  readonly attemptId: string;
  readonly headSha: string;
  readonly tier: 1 | 2;
}

type Fail = LandChainResult;

interface CollectedLinks {
  readonly links: readonly LandChainLink[];
  readonly highestTier: 1 | 2;
}

interface LandFacts {
  readonly pin: { readonly requestId: string; readonly headSha: string };
  readonly tip: string;
  readonly tier: 1 | 2;
  readonly links: readonly ChainLinkReceiptInput[];
  readonly title: string;
  readonly body: string;
}

export interface LandChainDependencies {
  readonly chains: ChainRepositoryPort;
  /** The merge-pass forge actions: the chain-branch head read and the premerge status. */
  readonly branches: MergeForgeActionPort;
  /** The legacy head lookup that names the open pull requests of one branch. */
  readonly forge: ForgeActionPort;
  readonly forgeRead: ForgeReadPort;
  readonly ancestry: ForgeAncestryPort;
  readonly reviews: ReviewRequestPort;
  readonly receipts: AcceptanceReceiptReadPort;
  readonly laneRuns: Pick<LaneRunRepositoryPort, 'list'>;
  readonly attempts: Pick<AttemptRepositoryPort, 'findAttemptById'>;
  readonly mergeQueue: Pick<MergeQueueRepositoryPort, 'listMergeEntries' | 'enqueueMergeEntry'>;
  readonly landing: ChainLandingPort;
  readonly mintEntryId: () => string;
  readonly nowIso: () => string;
  readonly computeDigest: (text: string) => string;
}

/** The answer of one deadline-guarded outbound call: the deadline fail, the mapped throw fail, or the value. */
type Guarded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly fail: Fail };

/** The lane-run list, validated as a dense array; a fake length or a hole is an unreadable store. */
function readRunList(value: unknown): readonly LaneRunRecord[] | null {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length)) {
    return null;
  }
  const checked = Math.min(value.length, LAND_CHAIN_MAX_LINKS + 1);
  for (let at = 0; at < checked; at += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(at))) {
      return null;
    }
  }
  return value as readonly LaneRunRecord[];
}

export class LandChainUseCase implements LandChainPort {
  constructor(private readonly deps: LandChainDependencies) {}

  async execute(input: unknown): Promise<LandChainResult> {
    try {
      const parsed = parseLandChainCommand(input);
      if ('outcome' in parsed) {
        return parsed;
      }
      return await this.run(parsed);
    } catch {
      return FAIL_STORE;
    }
  }

  /** True while the deadline stands; a throwing clock is a spent budget (fail closed). */
  private budgetLeft(deadlineIso: string): boolean {
    let now: string;
    try {
      now = this.deps.nowIso();
    } catch {
      return false;
    }
    const left = Date.parse(deadlineIso) - Date.parse(now);
    return Number.isFinite(left) && left > 0;
  }

  /** Every outbound call goes through here: the deadline first, then the call, never a throw. */
  private async guarded<T>(deadlineIso: string, threw: Fail, call: () => Promise<T>): Promise<Guarded<T>> {
    if (!this.budgetLeft(deadlineIso)) {
      return { ok: false, fail: FAIL_BUDGET };
    }
    try {
      return { ok: true, value: await call() };
    } catch {
      return { ok: false, fail: threw };
    }
  }

  /** One id through the injected mint; a throwing mint is `id-unavailable`. */
  private mintId(): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly fail: Fail } {
    try {
      return { ok: true, id: this.deps.mintEntryId() };
    } catch {
      return { ok: false, fail: FAIL_ID };
    }
  }

  private async run(command: LandChainCommand): Promise<LandChainResult> {
    const prepared = await this.prepare(command);
    if (!prepared.ok) {
      return prepared.fail;
    }

    const collected = await this.collectLinks(command, prepared.tip);
    if (!collected.ok) {
      return collected.fail;
    }
    const chainReceipt = await this.checkChainReceipt(command, prepared.pin, collected.value.highestTier);
    if (chainReceipt !== null) {
      return chainReceipt;
    }
    const receipts = await this.collectLinkReceipts(command, collected.value.links, prepared.tip);
    if (!receipts.ok) {
      return receipts.fail;
    }
    const batch = await this.checkBatch(command);
    if (batch !== null) {
      return batch;
    }

    const rendered = renderLandChain(command.chainName, prepared.tip, receipts.value);
    if (command.dryRun) {
      const action = await this.resolveDryRunAction(command, prepared.tip);
      if ('outcome' in action && 'reason' in action) {
        return action as LandChainResult;
      }
      const resolved = action as { mode: 'open' | 'adopt'; pullRequestNumber: number | null };
      return {
        outcome: 'dry-run',
        title: rendered.title,
        body: rendered.body,
        action: resolved.mode,
        pullRequestNumber: resolved.pullRequestNumber,
      };
    }
    return this.apply(command, { pin: prepared.pin, tip: prepared.tip, tier: collected.value.highestTier, links: receipts.value, title: rendered.title, body: rendered.body });
  }

  // ---------- shared reads ----------

  private async prepare(
    command: LandChainCommand,
  ): Promise<{ ok: true; record: ChainRecord; pin: { requestId: string; headSha: string }; tip: string } | { ok: false; fail: Fail }> {
    const notRead = { ok: false as const, fail: unknown('chain-unreadable') };
    const read = await this.guarded(
      command.deadlineIso,
      unknown('chain-unreadable'),
      () => this.deps.chains.readChain({ repository: command.repository, chainName: command.chainName, deadlineIso: command.deadlineIso }),
    );
    if (!read.ok) {
      return read;
    }
    if (read.value.status === 'not-found') {
      return { ok: false, fail: refused('chain-not-found') };
    }
    if (read.value.status !== 'ok') {
      return notRead;
    }
    const record = read.value.record;
    let pin: { requestId: string; headSha: string } | null;
    let mark: unknown;
    let refreshOutcome: unknown;
    try {
      const rawPin = reviewPinOf(record);
      pin = rawPin === null ? null : { requestId: rawPin.requestId, headSha: rawPin.headSha };
      mark = conflictMarkOf(record);
      refreshOutcome = chainRefreshOf(record) === null ? null : chainRefreshOf(record)?.outcome;
    } catch {
      return notRead;
    }
    if (record.state !== 'started') {
      return { ok: false, fail: refused('chain-not-started') };
    }
    if (mark === 'chain-refresh-conflict') {
      return { ok: false, fail: refused('conflict-mark') };
    }
    if (refreshOutcome === 'in-flight') {
      return { ok: false, fail: refused('refresh-in-flight') };
    }
    if (pin === null) {
      return { ok: false, fail: refused('review-not-started') };
    }

    const head = await this.guarded(
      command.deadlineIso,
      FAIL_FORGE,
      () => this.deps.branches.readMergeBranchHead({ repository: command.repository, branchName: command.branchName, deadlineIso: command.deadlineIso }),
    );
    if (!head.ok) {
      return head;
    }
    if (head.value.outcome === 'not-found') {
      return { ok: false, fail: refused('chain-not-found') };
    }
    if (head.value.outcome === 'unavailable') {
      return { ok: false, fail: FAIL_FORGE };
    }
    if (head.value.outcome !== 'found' || !isChainCommitSha(head.value.headSha) || head.value.headSha !== pin.headSha) {
      return { ok: false, fail: refused('chain-tip-moved') };
    }
    return { ok: true, record, pin, tip: head.value.headSha };
  }

  /** The chain's links (steps 4-5): every lane run against `chain/<name>`, settled at the forge. */
  private async collectLinks(command: LandChainCommand, tip: string): Promise<Guarded<CollectedLinks>> {
    const listed = await this.guarded(command.deadlineIso, FAIL_STORE, () => this.deps.laneRuns.list());
    if (!listed.ok) {
      return listed;
    }
    const allRuns = readRunList(listed.value);
    if (allRuns === null) {
      return { ok: false, fail: FAIL_STORE };
    }
    let runs: readonly LaneRunRecord[];
    try {
      runs = allRuns.filter((run) => resolveLaneRunBaseBranch(run) === command.branchName);
    } catch {
      return { ok: false, fail: FAIL_STORE };
    }
    if (runs.length > LAND_CHAIN_MAX_LINKS) {
      return { ok: false, fail: refused('too-many-links') };
    }
    if (runs.length === 0) {
      return { ok: false, fail: refused('no-links') };
    }

    const entriesListed = await this.guarded(
      command.deadlineIso,
      FAIL_QUEUE,
      () => this.deps.mergeQueue.listMergeEntries({ repository: command.repository, deadlineIso: command.deadlineIso }),
    );
    if (!entriesListed.ok) {
      return entriesListed;
    }
    const allEntries = entriesListed.value;
    if (!Array.isArray(allEntries) || allEntries.length > LAND_CHAIN_MAX_QUEUE_ENTRIES) {
      return { ok: false, fail: FAIL_QUEUE };
    }

    let highestTier: 1 | 2 = 1;
    const links: LandChainLink[] = [];
    for (const run of runs) {
      const settled = await this.settledLink(command, run, tip, allEntries);
      if (settled.link === null) {
        return { ok: false, fail: settled.fail };
      }
      if (settled.link.tier !== 1) {
        highestTier = 2;
      }
      links.push(settled.link);
    }
    return { ok: true, value: { links, highestTier } };
  }

  /** The settled link of one lane run, or the refusal/unknown the run earns. */
  private async settledLink(
    command: LandChainCommand,
    run: LaneRunRecord,
    tip: string,
    entries: readonly MergeQueueEntryRecord[],
  ): Promise<{ link: LandChainLink | null; fail: Fail }> {
    const unsettled: Fail = refused('link-unsettled');
    const pullRequestNumber = (run as { readonly prNumber?: unknown }).prNumber;
    const attemptIds = (run as { readonly attemptIds?: unknown }).attemptIds;
    const lastAttemptId = Array.isArray(attemptIds) && attemptIds.length > 0 ? attemptIds[attemptIds.length - 1] : undefined;
    if (
      typeof pullRequestNumber !== 'number' ||
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber < 1 ||
      typeof lastAttemptId !== 'string'
    ) {
      return { link: null, fail: unsettled };
    }

    let attempt: AttemptRecord | null;
    try {
      attempt = await this.deps.attempts.findAttemptById(lastAttemptId);
    } catch {
      attempt = null;
    }
    if (attempt === null) {
      return { link: null, fail: unsettled };
    }
    const headCommit = (attempt as { readonly artifacts?: { readonly headCommit?: unknown } | null }).artifacts?.headCommit;
    if ((attempt as { readonly completionReceipt?: unknown }).completionReceipt == null || !isChainCommitSha(headCommit)) {
      return { link: null, fail: unsettled };
    }

    const linkEntries = entries.filter((entry) => entry.pullRequest === pullRequestNumber);
    if (
      linkEntries.length === 0 ||
      !linkEntries.every((entry) => (MERGE_QUEUE_TERMINAL_STATES as readonly string[]).includes(entry.state)) ||
      !linkEntries.some((entry) => entry.state === 'merged')
    ) {
      return { link: null, fail: unsettled };
    }

    const prRead = await this.guarded(
      command.deadlineIso,
      FAIL_FORGE,
      () => this.deps.forgeRead.readPullRequest({ ref: { kind: 'number', number: pullRequestNumber }, repository: command.repository }),
    );
    if (!prRead.ok) {
      return { link: null, fail: prRead.fail };
    }
    if (prRead.value.outcome !== 'found') {
      return { link: null, fail: FAIL_FORGE };
    }
    const snapshot = prRead.value.pullRequest;
    if (snapshot.state !== 'merged' || snapshot.baseRef !== command.branchName) {
      return { link: null, fail: unsettled };
    }

    const contains = await this.guarded(
      command.deadlineIso,
      FAIL_FORGE,
      () => this.deps.ancestry.containsCommit({ ancestorSha: headCommit, descendantSha: tip }),
    );
    if (!contains.ok) {
      return { link: null, fail: contains.fail };
    }
    if (contains.value.outcome !== 'answered') {
      return { link: null, fail: FAIL_FORGE };
    }
    if (!contains.value.contains) {
      return { link: null, fail: unsettled };
    }

    const tier = (run as { readonly tier?: unknown }).tier;
    return {
      link: { pullRequestNumber, attemptId: lastAttemptId, headSha: headCommit, tier: tier === 1 ? 1 : 2 },
      fail: unsettled,
    };
  }

  /** The tier-2 chain receipt under the pinned request id; `null` when none is required or it passes. */
  private async checkChainReceipt(
    command: LandChainCommand,
    pin: { readonly requestId: string; readonly headSha: string },
    highestTier: 1 | 2,
  ): Promise<Fail | null> {
    if (highestTier === 1) {
      return null;
    }
    const found = await this.guarded(
      command.deadlineIso,
      FAIL_STORE,
      () =>
        this.deps.reviews.findReviewReceipt({
          attemptId: attemptIdForChain(command.projectId, command.chainName),
          requestId: pin.requestId,
          candidateHeadSha: pin.headSha,
          subject: { kind: 'chain', projectId: command.projectId, chainName: command.chainName, integrationHeadSha: pin.headSha },
        }),
    );
    if (!found.ok) {
      return found.fail;
    }
    if (found.value.outcome === 'not-found') {
      return refused('receipt-missing');
    }
    if (found.value.outcome !== 'found') {
      return FAIL_STORE;
    }
    const receipt = found.value.receipt;
    if (receipt.candidateHeadSha !== pin.headSha || receipt.kind !== 'pre-merge') {
      return refused('receipt-wrong-head');
    }
    if (receipt.verdict === 'failed') {
      return refused('verdict-failed');
    }
    if (receipt.verdict === 'unknown') {
      return unknown('verdict-unknown');
    }
    return null;
  }

  /** Every link's pre-merge receipts, read at the pinned head (never the link head). */
  private async collectLinkReceipts(
    command: LandChainCommand,
    links: readonly LandChainLink[],
    pinHeadSha: string,
  ): Promise<Guarded<readonly ChainLinkReceiptInput[]>> {
    const inputs: ChainLinkReceiptInput[] = [];
    for (const link of links) {
      const read = await this.guarded(
        command.deadlineIso,
        FAIL_STORE,
        () => this.deps.receipts.readReceiptsForHead(link.attemptId, pinHeadSha),
      );
      if (!read.ok) {
        return read;
      }
      if (read.value.outcome === 'none') {
        return { ok: false, fail: refused('link-receipt-missing') };
      }
      if (read.value.outcome !== 'found') {
        return { ok: false, fail: FAIL_STORE };
      }
      inputs.push({
        pullRequestNumber: link.pullRequestNumber,
        attemptId: link.attemptId,
        receipts: read.value.review as readonly ChainLinkReceiptCandidate[],
      });
    }
    const aggregate = aggregateLinkReceipts(inputs);
    if (!aggregate.ok) {
      return {
        ok: false,
        fail: aggregate.reason === 'verdict-unknown' ? unknown('verdict-unknown') : refused('link-receipt-missing'),
      };
    }
    if (aggregate.links.some((link) => link.result === 'fail')) {
      return { ok: false, fail: refused('link-receipt-failed') };
    }
    return { ok: true, value: inputs };
  }

  /** `null` when no unfinished batch targets the chain, else the refusal/unknown it earns. */
  private async checkBatch(command: LandChainCommand): Promise<Fail | null> {
    if (typeof this.deps.landing.unfinishedBatch !== 'function') {
      return FAIL_BATCH;
    }
    const answered = await this.guarded(
      command.deadlineIso,
      FAIL_BATCH,
      () => this.deps.landing.unfinishedBatch({ repository: command.repository, chainName: command.chainName, deadlineIso: command.deadlineIso }),
    );
    if (!answered.ok) {
      return answered.fail;
    }
    if (answered.value.outcome === 'targets') {
      return refused('batch-unfinished');
    }
    if (answered.value.outcome !== 'none') {
      return FAIL_BATCH;
    }
    return null;
  }

  /** Open versus adopt, read-only: the one open pull request of the branch onto `main` at the tip. */
  private async resolveDryRunAction(
    command: LandChainCommand,
    tip: string,
  ): Promise<{ mode: 'open' | 'adopt'; pullRequestNumber: number | null } | LandChainResult> {
    const open = await this.openPullRequestsOfBranch(command, tip);
    if (!open.ok) {
      return open.fail;
    }
    return open.value.length === 1
      ? { mode: 'adopt', pullRequestNumber: open.value[0].number }
      : { mode: 'open', pullRequestNumber: null };
  }

  /** The open pull requests of the branch onto `main` at exactly `tip`, or the failure the lookup earns. */
  private async openPullRequestsOfBranch(
    command: LandChainCommand,
    tip: string,
  ): Promise<Guarded<readonly { number: number }[]>> {
    const lookup = this.deps.forge.findOpenPullRequestsByHead;
    if (lookup === undefined) {
      return { ok: false, fail: FAIL_LOOKUP };
    }
    const found = await this.guarded(
      command.deadlineIso,
      FAIL_LOOKUP,
      () => lookup.call(this.deps.forge, { repository: `${command.repository.owner}/${command.repository.repo}`, branchName: command.branchName }),
    );
    if (!found.ok) {
      return found;
    }
    if (found.value.outcome !== 'read') {
      return { ok: false, fail: FAIL_LOOKUP };
    }
    if (found.value.pullRequests.length > LAND_CHAIN_MAX_LINKS) {
      return { ok: false, fail: FAIL_QUEUE };
    }
    const matching: { number: number }[] = [];
    for (const candidate of found.value.pullRequests) {
      const read = await this.guarded(
        command.deadlineIso,
        FAIL_LOOKUP,
        () => this.deps.forgeRead.readPullRequest({ ref: { kind: 'number', number: candidate.number }, repository: command.repository }),
      );
      if (!read.ok) {
        return read;
      }
      if (
        read.value.outcome === 'found' &&
        read.value.pullRequest.state === 'open' &&
        read.value.pullRequest.baseRef === 'main' &&
        read.value.pullRequest.headRef === command.branchName &&
        read.value.pullRequest.headSha === tip
      ) {
        matching.push({ number: candidate.number });
      }
    }
    return { ok: true, value: matching };
  }

  // ---------- apply ----------

  private async apply(command: LandChainCommand, facts: LandFacts): Promise<LandChainResult> {
    const head12 = facts.tip.slice(0, 12);
    const key = `chain-land/${command.chainName}@${head12}`;
    const digest = this.deps.computeDigest(canonicalLandChainPayload({ chainName: command.chainName, headSha: facts.tip, dryRun: command.dryRun }));

    const journalled = await this.journalEntries(command, key);
    if (!journalled.ok) {
      return journalled.fail;
    }
    const intentEntry = journalled.value.find((entry) => entry.kind === 'intent');
    const finalEntry = journalled.value.find((entry) => entry.kind === 'result');
    if (intentEntry !== undefined && intentEntry.digest !== digest) {
      return refused('intent-digest-mismatch');
    }
    if (finalEntry !== undefined) {
      return this.replayLanded(command, facts.title, finalEntry);
    }
    if (intentEntry === undefined) {
      const fail = await this.appendJournalEntry(command, key, 'intent', digest);
      if (fail !== null) {
        return fail;
      }
    }

    const open = await this.openPullRequestsOfBranch(command, facts.tip);
    if (!open.ok) {
      return open.fail;
    }
    if (open.value.length >= 2) {
      return refused('integration-pr-ambiguous');
    }
    const mode = open.value.length === 1 ? ('adopt' as const) : ('open' as const);
    const opened = await this.guarded(
      command.deadlineIso,
      FAIL_FORGE,
      () =>
        this.deps.landing.openOrAdopt({
          repository: command.repository,
          branchName: command.branchName,
          baseBranch: 'main',
          expectedHeadSha: facts.tip,
          title: facts.title,
          body: facts.body,
          tierLabel: facts.tier === 2 ? 'tier:2' : 'tier:1',
          mode,
          ...(mode === 'adopt' ? { pullRequestNumber: open.value[0].number } : {}),
          actionId: key,
          deadlineIso: command.deadlineIso,
        }),
    );
    if (!opened.ok) {
      return opened.fail;
    }
    if (opened.value.outcome === 'refused') {
      return refused('forge-refused');
    }
    if (opened.value.outcome === 'ambiguous') {
      return FAIL_FORGE;
    }
    const pullRequestNumber = opened.value.pullRequestNumber;

    const reRead = await this.guarded(
      command.deadlineIso,
      FAIL_FORGE,
      () => this.deps.forgeRead.readPullRequest({ ref: { kind: 'number', number: pullRequestNumber }, repository: command.repository }),
    );
    if (!reRead.ok) {
      return reRead.fail;
    }
    if (reRead.value.outcome !== 'found') {
      return FAIL_FORGE;
    }
    if (
      reRead.value.pullRequest.baseRef !== 'main' ||
      reRead.value.pullRequest.headRef !== command.branchName ||
      reRead.value.pullRequest.headSha !== facts.tip
    ) {
      return refused('integration-pr-wrong-base');
    }

    const premergeKey = `chain-land/${command.chainName}/premerge@${head12}`;
    const premergeDigest = this.deps.computeDigest(
      canonicalLandChainPayload({ chainName: command.chainName, headSha: facts.tip, dryRun: command.dryRun, step: 'premerge' }),
    );
    const premergeIntent = await this.appendStepIntent(command, premergeKey, premergeDigest);
    if (premergeIntent !== null) {
      return premergeIntent;
    }
    const status = await this.guarded(
      command.deadlineIso,
      FAIL_FORGE,
      () =>
        this.deps.branches.performMergeForgeAction({
          kind: 'post-status',
          actionId: premergeKey,
          repository: command.repository,
          pullRequestNumber,
          branchName: command.branchName,
          expectedHeadSha: facts.tip,
          status: {
            context: 'premerge',
            state: 'success',
            description: facts.tier === 2 ? 'pre-merge receipt recorded' : 'not required for tier 1',
          },
          deadlineIso: command.deadlineIso,
        }),
    );
    if (!status.ok) {
      return status.fail;
    }
    if (status.value.outcome === 'refused' || status.value.outcome === 'branch-gone') {
      return refused('forge-refused');
    }
    if (status.value.outcome === 'ambiguous') {
      return FAIL_FORGE;
    }

    const marked = await this.recordLandingMark(command, key, facts.tip, pullRequestNumber);
    if (marked !== null) {
      return marked;
    }

    // Re-check after the mark: any failure withdraws the mark and never enqueues.
    const recheckLinks = await this.collectLinks(command, facts.tip);
    if (!recheckLinks.ok) {
      return this.withdrawAndReturn(command, key, facts.tip, pullRequestNumber, recheckLinks.fail);
    }
    const recheckReceipts = await this.collectLinkReceipts(command, recheckLinks.value.links, facts.tip);
    if (!recheckReceipts.ok) {
      return this.withdrawAndReturn(command, key, facts.tip, pullRequestNumber, recheckReceipts.fail);
    }
    const recheckBatch = await this.checkBatch(command);
    if (recheckBatch !== null) {
      return this.withdrawAndReturn(command, key, facts.tip, pullRequestNumber, recheckBatch);
    }

    const enqueueKey = `chain-land/${command.chainName}/enqueue@${head12}`;
    const enqueueDigest = this.deps.computeDigest(
      canonicalLandChainPayload({ chainName: command.chainName, headSha: facts.tip, dryRun: command.dryRun, step: 'enqueue' }),
    );
    const enqueueIntent = await this.appendStepIntent(command, enqueueKey, enqueueDigest);
    if (enqueueIntent !== null) {
      return enqueueIntent;
    }
    const entryId = this.mintId();
    if (!entryId.ok) {
      return entryId.fail;
    }
    const successorId = this.mintId();
    if (!successorId.ok) {
      return successorId.fail;
    }
    const enqueued = await this.guarded(
      command.deadlineIso,
      FAIL_QUEUE,
      () =>
        this.deps.mergeQueue.enqueueMergeEntry({
          repository: command.repository,
          pullRequest: pullRequestNumber,
          headOid: facts.tip,
          tier: facts.tier,
          enqueuedBy: 'conductor',
          runId: null,
          entryId: entryId.id,
          successorEntryId: successorId.id,
          enqueuedAtIso: this.safeNow(command),
          deadlineIso: command.deadlineIso,
        }),
    );
    if (!enqueued.ok) {
      return enqueued.fail;
    }
    if (enqueued.value.outcome === 'refused') {
      return refused('enqueue-refused');
    }

    const appended = await this.appendJournalEntry(command, key, 'result', digest);
    if (appended !== null) {
      return appended;
    }
    return {
      outcome: 'landed',
      title: facts.title,
      body: facts.body,
      pullRequestNumber,
      headSha: facts.tip,
      entryId: entryId.id,
    };
  }

  /** The entries of one journal key; every unreadable shape is `journal-unreadable`. */
  private async journalEntries(
    command: LandChainCommand,
    key: string,
  ): Promise<Guarded<readonly { key: string; kind: 'intent' | 'result'; entryId: string; recordedAtIso: string; digest: string }[]>> {
    const listed = await this.guarded(command.deadlineIso, FAIL_JOURNAL, () => this.deps.landing.listByKey(key));
    if (!listed.ok) {
      return listed;
    }
    if (listed.value.outcome !== 'listed' || !Array.isArray(listed.value.entries)) {
      return { ok: false, fail: FAIL_JOURNAL };
    }
    return { ok: true, value: listed.value.entries };
  }

  /** Append one journal entry (intent or final result) with a freshly minted id; `null` when appended. */
  private async appendJournalEntry(
    command: LandChainCommand,
    key: string,
    kind: 'intent' | 'result',
    digest: string,
  ): Promise<Fail | null> {
    const minted = this.mintId();
    if (!minted.ok) {
      return minted.fail;
    }
    const appended = await this.guarded(
      command.deadlineIso,
      FAIL_JOURNAL,
      () =>
        this.deps.landing.append({
          key,
          kind,
          entryId: minted.id,
          recordedAtIso: this.safeNow(command),
          digest,
          deadlineIso: command.deadlineIso,
        }),
    );
    if (!appended.ok) {
      return appended.fail;
    }
    if (appended.value.outcome !== 'appended') {
      return FAIL_JOURNAL;
    }
    return null;
  }

  /** One step intent (`premerge`/`enqueue`); `null` when appended or already present with the same digest. */
  private async appendStepIntent(command: LandChainCommand, key: string, digest: string): Promise<Fail | null> {
    const entries = await this.journalEntries(command, key);
    if (!entries.ok) {
      return entries.fail;
    }
    if (entries.value.some((entry) => entry.kind === 'intent' && entry.digest !== digest)) {
      return refused('intent-digest-mismatch');
    }
    if (entries.value.some((entry) => entry.kind === 'intent')) {
      return null;
    }
    return this.appendJournalEntry(command, key, 'intent', digest);
  }

  /** The stored landing mark, or the failure reading it earns. */
  private async readLandingMark(
    command: LandChainCommand,
  ): Promise<
    | { ok: true; outcome: 'missing' | 'found'; revision: number; mark?: { headSha: string; pullRequestNumber: number; key: string; state: 'landing' | 'withdrawn' } }
    | { ok: false; fail: Fail }
  > {
    const read = await this.guarded(
      command.deadlineIso,
      FAIL_JOURNAL,
      () => this.deps.landing.readMark({ repository: command.repository, chainName: command.chainName, deadlineIso: command.deadlineIso }),
    );
    if (!read.ok) {
      return read;
    }
    if (read.value.outcome === 'unreadable') {
      return { ok: false, fail: FAIL_JOURNAL };
    }
    if (read.value.outcome === 'missing') {
      return { ok: true, outcome: 'missing', revision: 0 };
    }
    return { ok: true, outcome: 'found', revision: read.value.mark.revision, mark: read.value.mark };
  }

  /** Record the `landing` mark by compare-and-set with one stale-revision retry; `null` when recorded. */
  private async recordLandingMark(command: LandChainCommand, key: string, tip: string, pullRequestNumber: number): Promise<Fail | null> {
    const attempt = async (): Promise<'recorded' | 'stale' | Fail> => {
      const stored = await this.readLandingMark(command);
      if (!stored.ok) {
        return stored.fail;
      }
      if (stored.outcome === 'found' && stored.mark !== undefined && stored.mark.state === 'landing' && (stored.mark.headSha !== tip || stored.mark.key !== key)) {
        return refused('landing-mark-conflict');
      }
      const cas = await this.guarded(
        command.deadlineIso,
        FAIL_JOURNAL,
        () =>
          this.deps.landing.compareAndSetMark({
            repository: command.repository,
            chainName: command.chainName,
            expectedRevision: stored.revision,
            mark: { headSha: tip, pullRequestNumber, key, state: 'landing' },
            deadlineIso: command.deadlineIso,
          }),
      );
      if (!cas.ok) {
        return cas.fail;
      }
      if (cas.value.outcome === 'recorded' || cas.value.outcome === 'already-recorded') {
        return 'recorded';
      }
      return cas.value.reason === 'stale-revision' ? 'stale' : refused('landing-mark-conflict');
    };

    const first = await attempt();
    if (first === 'recorded') {
      return null;
    }
    if (first === 'stale') {
      const second = await attempt();
      if (second === 'recorded') {
        return null;
      }
      if (second === 'stale') {
        return refused('landing-mark-stale');
      }
      return second;
    }
    return first;
  }

  /** Withdraw the landing mark (one stale-revision retry), then return the re-check failure; a failed withdrawal never lands. */
  private async withdrawAndReturn(
    command: LandChainCommand,
    key: string,
    tip: string,
    pullRequestNumber: number,
    failure: Fail,
  ): Promise<LandChainResult> {
    const attempt = async (): Promise<'withdrawn' | 'stale' | 'conflict' | Fail> => {
      const stored = await this.readLandingMark(command);
      if (!stored.ok) {
        return stored.fail;
      }
      const cas = await this.guarded(
        command.deadlineIso,
        FAIL_JOURNAL,
        () =>
          this.deps.landing.compareAndSetMark({
            repository: command.repository,
            chainName: command.chainName,
            expectedRevision: stored.revision,
            mark: { headSha: tip, pullRequestNumber, key, state: 'withdrawn' },
            deadlineIso: command.deadlineIso,
          }),
      );
      if (!cas.ok) {
        return cas.fail;
      }
      if (cas.value.outcome === 'recorded' || cas.value.outcome === 'already-recorded') {
        return 'withdrawn';
      }
      return cas.value.reason === 'stale-revision' ? 'stale' : 'conflict';
    };

    const first = await attempt();
    if (first === 'withdrawn') {
      return failure;
    }
    if (first === 'stale') {
      const second = await attempt();
      if (second === 'withdrawn') {
        return failure;
      }
      if (second === 'stale') {
        return refused('landing-mark-stale');
      }
      return second === 'conflict' ? refused('landing-mark-conflict') : second;
    }
    if (first === 'conflict') {
      return refused('landing-mark-conflict');
    }
    return first;
  }

  /** The answer of an already-recorded final result: the landing stands, forge and queue are not called again. */
  private async replayLanded(command: LandChainCommand, title: string, finalEntry: { entryId: string }): Promise<LandChainResult> {
    const stored = await this.readLandingMark(command);
    if (!stored.ok) {
      return stored.fail;
    }
    if (stored.outcome !== 'found' || stored.mark === undefined) {
      return FAIL_JOURNAL;
    }
    return {
      outcome: 'landed',
      title,
      body: renderLandChain(command.chainName, stored.mark.headSha, []).body,
      pullRequestNumber: stored.mark.pullRequestNumber,
      headSha: stored.mark.headSha,
      entryId: finalEntry.entryId,
    };
  }

  /** The injected instant; an unreadable clock falls back to the command's own (already validated) one. */
  private safeNow(command: LandChainCommand): string {
    try {
      return this.deps.nowIso();
    } catch {
      return command.nowIso;
    }
  }
}

/** The fixed title and telemetry-safe body of one landing. */
function renderLandChain(
  chainName: string,
  tip: string,
  links: readonly { readonly pullRequestNumber: number; readonly attemptId: string }[],
): { title: string; body: string } {
  const title = `Land chain/${chainName}`;
  const lines: string[] = [`Chain: ${chainName}`, `Head: ${tip}`];
  for (const link of links.slice(0, LAND_CHAIN_MAX_LINKS)) {
    lines.push(`pr ${link.pullRequestNumber} attempt ${link.attemptId} pre-merge pass`);
  }
  return { title, body: lines.join('\n') };
}
