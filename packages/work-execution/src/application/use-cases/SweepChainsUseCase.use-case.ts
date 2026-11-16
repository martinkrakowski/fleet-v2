/**
 * SweepChainsUseCase (lane CO11): delete the branches of every chain record
 * whose own `state` is the exact string `landed`. The order is the contract:
 * validate the envelope, list the chains, validate every record and every
 * `linkBranches` member before the first delete (one bad member means zero
 * deletes), then delete each landed chain's recorded link branches and
 * finally its own `chain/<name>` branch through the forge's `delete-branch`
 * kind (link id `chain-sweep/<name>@r<revision>/link/<index>`, chain id
 * `chain-sweep/<name>@r<revision>/chain`; duplicates collapse into one
 * delete). A record that already carries a `sweptAtIso` mark is skipped, and
 * when every branch of a chain is deleted or already absent the mark is
 * written through `recordChainSwept` by CAS, so the next tick does not repeat
 * the sweep. Dry-run is the default: deletion runs only when the command's
 * own `mode` is the exact string `apply`. A `branch-gone` or repeated-id
 * answer is `already-absent`, so a repeat after a partial sweep completes. A
 * malformed, unreadable, secret-shaped or off-pattern member refuses the
 * whole sweep; the raw rejected string is never copied into any result.
 * Worktrees are left to the reaper. No clock is read here except the injected
 * one; reasons, keys and chain names only, never a path or an input value.
 */

import { containsSecretShape, LANE_DIFF_SECRET_PATTERNS } from '@fleet/shared';
import { parseChainName, parseChainRepository } from '../../domain/chain-records.js';
import { parseBaseBranch } from '../../domain/base-branch.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { computeCallBudget, DAEMON_CALL_MIN_REMAINING_MS } from '../../domain/daemon-tick.js';
import type {
  SweepChainsBranchReport,
  SweepChainsPort,
  SweepChainsResult,
} from '../ports/in/SweepChainsPort.in-port.js';
import type { ChainRepositoryPort } from '../ports/out/ChainRepositoryPort.out-port.js';
import type { ConductorHaltPort } from '../ports/out/ConductorHaltPort.out-port.js';
import type { MergeForgeActionPort } from '../ports/out/MergeForgeActionPort.out-port.js';

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_REVISION = 1_000_000_000;
const MAX_RECORDS = 100;
const MAX_LINKS = 32;
/** Branches a sweep may never name, even for a chain whose name matches. */
const PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'HEAD', 'trunk', 'release'];

interface ValidCommand {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly projectId: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
  readonly apply: boolean;
}

/** Read a field from its own data property, so no getter ever runs. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function isSecretShaped(text: string): boolean {
  return containsSecretShape(text) || LANE_DIFF_SECRET_PATTERNS.some((pattern) => pattern.regex.test(text));
}

/**
 * True only when `branchName` is exactly this chain's own `chain/<chainName>`
 * branch: the name parses, the branch parses as a base branch, the protected
 * set is excluded, and neither string is secret-shaped. `chain/release` is
 * deletable only for chain name `release`; the delete path is always
 * `heads/chain/<name>`, never the bare name.
 */
export function isDeletableSweepBranch(chainName: string, branchName: string): boolean {
  if (parseChainName(chainName) !== chainName) {
    return false;
  }
  if (typeof branchName !== 'string' || branchName !== `chain/${chainName}`) {
    return false;
  }
  if (parseBaseBranch(branchName) !== branchName) {
    return false;
  }
  if (PROTECTED_BRANCHES.includes(branchName) || branchName.startsWith('release/') || branchName.startsWith('releases/') || branchName.startsWith('refs/')) {
    return false;
  }
  if (isSecretShaped(chainName) || isSecretShaped(branchName)) {
    return false;
  }
  return true;
}

/**
 * The class of a member a sweep refuses, or null when the member is this
 * chain's own `chain/<chainName>`. The rejected value is never returned.
 */
function classifySweepBranch(chainName: unknown, branchName: unknown): string | null {
  if (typeof branchName !== 'string' || typeof chainName !== 'string') {
    return 'non-string';
  }
  if (isSecretShaped(branchName) || isSecretShaped(chainName)) {
    return 'secret-shaped';
  }
  if (PROTECTED_BRANCHES.includes(branchName)) {
    return branchName === 'release' ? 'release' : 'main';
  }
  if (branchName.startsWith('release/') || branchName.startsWith('releases/')) {
    return 'release';
  }
  if (branchName.startsWith('refs/')) {
    return 'unsafe';
  }
  if (parseBaseBranch(branchName) !== undefined && branchName.startsWith('chain/')) {
    // A well-formed chain branch of some other chain is still not this one.
    return branchName === `chain/${chainName}` && isDeletableSweepBranch(chainName, branchName) ? null : 'other-chain';
  }
  return 'not-chain-pattern';
}

/** A safe git branch name a recorded link may carry; stricter shapes are refusals. */
const LINK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isSafeLinkBranchName(branchName: string): boolean {
  return (
    branchName.length <= 200 &&
    !branchName.includes('..') &&
    !branchName.endsWith('/') &&
    !branchName.endsWith('.') &&
    !branchName.endsWith('.lock') &&
    LINK_NAME_PATTERN.test(branchName)
  );
}

/**
 * The class of a recorded link member a sweep refuses, or null when the link
 * is deletable: any safe branch name that is not protected, not another
 * chain's branch and not secret-shaped. A link naming this chain's own
 * `chain/<chainName>` branch classifies as null and collapses into the chain
 * delete.
 */
function classifySweepLink(chainName: string, branchName: unknown): string | null {
  if (typeof branchName !== 'string') {
    return 'non-string';
  }
  if (isSecretShaped(branchName) || isSecretShaped(chainName)) {
    return 'secret-shaped';
  }
  if (PROTECTED_BRANCHES.includes(branchName)) {
    return branchName === 'release' ? 'release' : 'main';
  }
  if (branchName.startsWith('release/') || branchName.startsWith('releases/')) {
    return 'release';
  }
  if (branchName.startsWith('refs/')) {
    return 'unsafe';
  }
  if (branchName.startsWith('chain/')) {
    if (parseBaseBranch(branchName) === undefined) {
      return 'not-chain-pattern';
    }
    return branchName === `chain/${chainName}` ? null : 'other-chain';
  }
  return isSafeLinkBranchName(branchName) ? null : 'not-chain-pattern';
}

interface PlannedBranch {
  readonly role: 'chain' | 'link';
  readonly memberIndex: number | null;
  readonly branchName: string;
  readonly actionId: string;
}

/** One landed chain's planned sweep: its link branches first, its own branch last. */
interface PlannedChain {
  readonly chainName: string;
  readonly revision: number;
  readonly branches: readonly PlannedBranch[];
}

type SweepRefusal =
  | { readonly kind: 'plain'; readonly reasonCode: string }
  | {
      readonly kind: 'branch';
      readonly reasonCode: 'branch-pattern-refused';
      readonly branchClass: string;
      readonly chainName: string;
      readonly memberRole: 'chain' | 'link';
      readonly memberIndex: number | null;
    };

/** True for a refusal inside the mixed link-plan answer. */
function isSweepRefusal(value: unknown): value is SweepRefusal {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

/**
 * The fail-closed halt read (plan §3.7, fix round 1): a missing dependency
 * fails closed; a provided port without `read`, a throw, and any answer that
 * is not an object with `state: 'clear'` — or whose record does not agree
 * with that tag — read as halted.
 */
async function isHalted(halt?: Pick<ConductorHaltPort, 'read'>): Promise<boolean> {
  if (halt === undefined) {
    return true;
  }
  if (typeof halt.read !== 'function') {
    return true;
  }
  try {
    const state = await halt.read();
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      return true;
    }
    const tag = (state as { readonly state?: unknown }).state;
    if (tag !== 'clear') {
      return true;
    }
    // `clear` is believed only when its record agrees: absent (null), or a
    // plain record whose own `halted` is exactly false. Anything else — a
    // malformed record, a getter, `halted: true` — fails closed.
    const record = (state as { readonly record?: unknown }).record;
    if (record === null) {
      return false;
    }
    if (typeof record !== 'object' || Array.isArray(record)) {
      return true;
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, 'halted');
    return descriptor === undefined || descriptor.value !== false;
  } catch {
    return true;
  }
}

function refusalResult(refusal: SweepRefusal): SweepChainsResult {
  if (refusal.kind === 'branch') {
    return {
      outcome: 'refused',
      reasonCode: refusal.reasonCode,
      branchClass: refusal.branchClass,
      chainName: refusal.chainName,
      memberRole: refusal.memberRole,
      memberIndex: refusal.memberIndex,
      branches: [],
    };
  }
  return {
    outcome: 'refused',
    reasonCode: refusal.reasonCode,
    branchClass: null,
    chainName: null,
    memberRole: null,
    memberIndex: null,
    branches: [],
  };
}

function validate(raw: unknown): ValidCommand | string {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return 'invalid-request';
    }
    const repository = parseChainRepository(ownValue(raw, 'repository'));
    if (repository === undefined) {
      return 'invalid-repository';
    }
    const projectId = ownValue(raw, 'projectId');
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      return 'invalid-project-id';
    }
    if (isSecretShaped(projectId)) {
      return 'secret-shaped';
    }
    const nowIso = ownValue(raw, 'nowIso');
    if (!isZonedIsoDateTime(nowIso)) {
      return 'invalid-now';
    }
    const deadlineIso = ownValue(raw, 'deadlineIso');
    if (!isZonedIsoDateTime(deadlineIso)) {
      return 'invalid-deadline';
    }
    // Any mode but the exact string `apply` (including an unreadable one) is a dry-run.
    const apply = ownValue(raw, 'mode') === 'apply';
    return { repository, projectId, nowIso, deadlineIso, apply };
  } catch {
    return 'invalid-request';
  }
}

const KNOWN_STATES: readonly string[] = ['intent-recorded', 'started', 'refused', 'landed'];

/**
 * Validate one chain record's own data properties. Returns the plan entry for
 * a landed chain, null for a skipped record (non-landed, or already swept),
 * or a refusal.
 */
function readRecord(record: unknown): PlannedChain | null | SweepRefusal {
  try {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return { kind: 'plain', reasonCode: 'record-malformed' };
    }
    const chainName = ownValue(record, 'chainName');
    const branchName = ownValue(record, 'branchName');
    const revision = ownValue(record, 'revision');
    const state = ownValue(record, 'state');
    if (typeof chainName !== 'string' || parseChainName(chainName) === undefined || isSecretShaped(chainName)) {
      return { kind: 'plain', reasonCode: 'record-malformed' };
    }
    if (typeof branchName !== 'string' || isSecretShaped(branchName)) {
      return { kind: 'plain', reasonCode: 'record-malformed' };
    }
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISION) {
      return { kind: 'plain', reasonCode: 'record-malformed' };
    }
    // A prototype-inherited state is not the record's own and counts as missing.
    if (typeof state !== 'string' || !KNOWN_STATES.includes(state)) {
      return { kind: 'plain', reasonCode: 'record-malformed' };
    }
    const branchClass = classifySweepBranch(chainName, branchName);
    if (branchClass !== null || branchName !== `chain/${chainName}`) {
      return {
        kind: 'branch',
        reasonCode: 'branch-pattern-refused',
        branchClass: branchClass ?? 'not-chain-pattern',
        chainName,
        memberRole: 'chain',
        memberIndex: null,
      };
    }
    if (state !== 'landed') {
      return null;
    }
    // A record a previous sweep already handled is skipped, never re-swept.
    const sweptAtIso = ownValue(record, 'sweptAtIso');
    if (sweptAtIso !== undefined && sweptAtIso !== null) {
      if (typeof sweptAtIso !== 'string' || !isZonedIsoDateTime(sweptAtIso)) {
        return { kind: 'plain', reasonCode: 'record-malformed' };
      }
      return null;
    }
    return {
      chainName,
      revision,
      branches: [
        {
          role: 'chain',
          memberIndex: null,
          branchName,
          actionId: `chain-sweep/${chainName}@r${revision}/chain`,
        },
      ],
    };
  } catch {
    return { kind: 'plain', reasonCode: 'record-malformed' };
  }
}

export class SweepChainsUseCase implements SweepChainsPort {
  constructor(
    private readonly deps: {
      readonly chains: Pick<ChainRepositoryPort, 'listChains' | 'recordChainSwept'>;
      readonly forge: MergeForgeActionPort;
      readonly now: () => string;
      /**
       * The conductor halt read (plan §3.7). Required and fail closed:
       * missing, unreadable, off-contract or halted, an apply-mode sweep
       * refuses before any delete and before any swept mark.
       */
      readonly halt: Pick<ConductorHaltPort, 'read'>;
    },
  ) {}

  async runSweepChains(command: unknown): Promise<SweepChainsResult> {
    try {
      const valid = validate(command);
      if (typeof valid === 'string') {
        return refusalResult({ kind: 'plain', reasonCode: valid });
      }
      return await this.run(valid);
    } catch {
      return refusalResult({ kind: 'plain', reasonCode: 'invalid-request' });
    }
  }

  /** The injected clock; null when it throws, which reads as a reached deadline. */
  private safeNow(): string | null {
    try {
      return this.deps.now();
    } catch {
      return null;
    }
  }

  private hasBudget(deadlineIso: string, nowIso: string | null): boolean {
    if (nowIso === null) {
      return false;
    }
    return computeCallBudget({
      nowIso,
      deadlineIso,
      normalTimeoutMs: DAEMON_CALL_MIN_REMAINING_MS,
    }).allowed;
  }

  private async run(command: ValidCommand): Promise<SweepChainsResult> {
    const listed = await this.listChains(command);
    if (typeof listed === 'string') {
      return refusalResult({ kind: 'plain', reasonCode: listed });
    }
    const planned: PlannedChain[] = [];
    const seenChains = new Set<string>();
    const records = listed;
    const count = records.length;
    for (let index = 0; index < count; index += 1) {
      if (!Object.hasOwn(records, index)) {
        return refusalResult({ kind: 'plain', reasonCode: 'record-malformed' });
      }
      const read = readRecord(records[index]);
      if (read === null) {
        continue;
      }
      if ('kind' in read) {
        return refusalResult(read);
      }
      // A landed record: validate its linkBranches membership before any delete.
      const links = this.readLinkBranches(records[index], read);
      if (typeof links === 'string') {
        return refusalResult({ kind: 'plain', reasonCode: links });
      }
      if (links.length > 0 && isSweepRefusal(links[0])) {
        return refusalResult(links[0]);
      }
      if (!seenChains.has(read.chainName)) {
        seenChains.add(read.chainName);
        planned.push({ ...read, branches: [...(links as readonly PlannedBranch[]), ...read.branches] });
      }
    }
    if (!command.apply) {
      return {
        outcome: 'dry-run',
        reasonCode: planned.length === 0 ? 'nothing-to-sweep' : null,
        branchClass: null,
        chainName: null,
        memberRole: null,
        memberIndex: null,
        branches: planned.flatMap((chain) =>
          chain.branches.map((entry) => ({
            chainName: chain.chainName,
            role: entry.role,
            actionId: entry.actionId,
            branchName: entry.branchName,
            outcome: 'would-delete' as const,
            reasonCode: null,
          })),
        ),
      };
    }
    return this.apply(command, planned);
  }

  /** List the chains; a string is the refusal reason. */
  private async listChains(command: ValidCommand): Promise<readonly unknown[] | string> {
    try {
      const list = this.deps.chains?.listChains;
      if (typeof list !== 'function') {
        return 'chains-unreadable';
      }
      const listed = await list.call(this.deps.chains, { repository: command.repository, deadlineIso: command.deadlineIso });
      if (listed === null || typeof listed !== 'object' || ownValue(listed, 'status') !== 'ok') {
        return 'chains-unreadable';
      }
      const records = ownValue(listed, 'records');
      if (!Array.isArray(records)) {
        // Array-like objects and every other shape are refused without reading `length`.
        return 'chains-malformed';
      }
      if (!Number.isSafeInteger(records.length) || records.length > MAX_RECORDS) {
        return 'too-many-members';
      }
      return records;
    } catch {
      return 'chains-unreadable';
    }
  }

  /**
   * Read one landed record's `linkBranches` own property: a string is the
   * refusal reason, refusals name a rejected member, and otherwise every
   * deletable link becomes a planned delete (link branches first, so the
   * chain branch goes last). A link naming this chain's own branch, and
   * duplicates of an already planned link, collapse into nothing new.
   */
  private readLinkBranches(
    source: unknown,
    chain: PlannedChain,
  ): readonly PlannedBranch[] | readonly SweepRefusal[] | string {
    try {
      const raw = ownValue(source, 'linkBranches');
      if (raw === undefined || raw === null) {
        return 'membership-unreadable';
      }
      if (!Array.isArray(raw)) {
        return 'chains-malformed';
      }
      if (!Number.isSafeInteger(raw.length) || raw.length > MAX_LINKS) {
        return 'too-many-members';
      }
      const links: PlannedBranch[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < raw.length; index += 1) {
        if (!Object.hasOwn(raw, index)) {
          return [{ kind: 'plain', reasonCode: 'record-malformed' }];
        }
        const branchClass = classifySweepLink(chain.chainName, raw[index]);
        if (branchClass !== null) {
          return [
            {
              kind: 'branch',
              reasonCode: 'branch-pattern-refused',
              branchClass,
              chainName: chain.chainName,
              memberRole: 'link',
              memberIndex: index,
            },
          ];
        }
        const branchName = raw[index] as string;
        if (branchName === chain.branches[chain.branches.length - 1]!.branchName || seen.has(branchName)) {
          continue;
        }
        seen.add(branchName);
        links.push({
          role: 'link',
          memberIndex: index,
          branchName,
          actionId: `chain-sweep/${chain.chainName}@r${chain.revision}/link/${index}`,
        });
      }
      return links;
    } catch {
      return 'record-malformed';
    }
  }

  private async apply(command: ValidCommand, planned: readonly PlannedChain[]): Promise<SweepChainsResult> {
    if (await isHalted(this.deps.halt)) {
      // Refused before any delete and before any swept mark; rechecked below
      // before every not-yet-sent delete.
      return refusalResult({ kind: 'plain', reasonCode: 'halted' });
    }
    try {
      if (typeof this.deps.forge?.isConfigured !== 'function' || this.deps.forge.isConfigured() === false) {
        return refusalResult({ kind: 'plain', reasonCode: 'forge-not-configured' });
      }
    } catch {
      return refusalResult({ kind: 'plain', reasonCode: 'forge-unavailable' });
    }
    if (typeof this.deps.forge?.performMergeForgeAction !== 'function') {
      return refusalResult({ kind: 'plain', reasonCode: 'forge-unavailable' });
    }
    if (planned.length === 0) {
      return {
        outcome: 'completed',
        reasonCode: 'nothing-to-sweep',
        branchClass: null,
        chainName: null,
        memberRole: null,
        memberIndex: null,
        branches: [],
      };
    }
    const branches: SweepChainsBranchReport[] = [];
    for (const chain of planned) {
      for (const entry of chain.branches) {
        const nowIso = this.safeNow();
        if (!this.hasBudget(command.deadlineIso, nowIso)) {
          return { outcome: 'budget-exhausted', reasonCode: null, branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
        }
        if (await isHalted(this.deps.halt)) {
          // Recheck before this not-yet-sent delete: deletes already sent stay
          // reported in `branches`; no further delete and no swept mark goes
          // out after the halt appeared.
          return { outcome: 'incomplete', reasonCode: 'halted', branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
        }
        let result;
        try {
          result = await this.deps.forge.performMergeForgeAction({
            kind: 'delete-branch',
            actionId: entry.actionId,
            repository: command.repository,
            branchName: entry.branchName,
            deadlineIso: command.deadlineIso,
          });
        } catch {
          return { outcome: 'incomplete', reasonCode: 'delete-ambiguous', branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
        }
        if (result.outcome === 'executed') {
          branches.push({ chainName: chain.chainName, role: entry.role, actionId: entry.actionId, branchName: entry.branchName, outcome: 'deleted', reasonCode: null });
          continue;
        }
        if (result.outcome === 'branch-gone' || result.outcome === 'already-applied') {
          branches.push({ chainName: chain.chainName, role: entry.role, actionId: entry.actionId, branchName: entry.branchName, outcome: 'already-absent', reasonCode: null });
          continue;
        }
        if (result.outcome === 'refused' && result.reason === 'budget-exhausted') {
          return { outcome: 'budget-exhausted', reasonCode: null, branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
        }
        if (result.outcome === 'refused') {
          return { outcome: 'incomplete', reasonCode: 'delete-refused', branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
        }
        return { outcome: 'incomplete', reasonCode: 'delete-ambiguous', branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
      }
      // Every branch of this chain is deleted or already absent: write the
      // sweep mark so the next tick skips it. A failed mark leaves the record
      // for the next retry, which completes as `already-absent` and marks again.
      const markRefusal = await this.recordSwept(command, chain);
      if (markRefusal !== null) {
        return { outcome: 'incomplete', reasonCode: markRefusal, branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
      }
    }
    return { outcome: 'completed', reasonCode: null, branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
  }

  /**
   * Write one swept chain's handled mark by CAS on the revision the list
   * read. Null when recorded (or already recorded); a fixed refusal code
   * otherwise. Never throws.
   */
  private async recordSwept(command: ValidCommand, chain: PlannedChain): Promise<string | null> {
    const record = this.deps.chains?.recordChainSwept;
    if (typeof record !== 'function') {
      return 'sweep-unrecorded';
    }
    try {
      const decision = await record.call(this.deps.chains, {
        repository: command.repository,
        chainName: chain.chainName,
        expectedRevision: chain.revision,
        sweptAtIso: command.nowIso,
        deadlineIso: command.deadlineIso,
      });
      if (decision === null || typeof decision !== 'object') {
        return 'sweep-unrecorded';
      }
      const outcome = (decision as { readonly outcome?: unknown }).outcome;
      return outcome === 'recorded' || outcome === 'already-recorded' ? null : 'sweep-unrecorded';
    } catch {
      return 'sweep-unrecorded';
    }
  }
}
