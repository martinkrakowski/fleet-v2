/**
 * SweepChainsUseCase (lane CO11): delete the branch of every chain record
 * whose own `state` is the exact string `landed`. The order is the contract:
 * validate the envelope, list the chains, validate every record and every
 * `linkBranches` member before the first delete (one bad member means zero
 * deletes), then delete each landed chain's `chain/<name>` branch once
 * through the forge's `delete-branch` kind under the id
 * `chain-sweep/<name>@r<revision>/chain`. Dry-run is the default: deletion
 * runs only when the command's own `mode` is the exact string `apply`. A
 * `branch-gone` or repeated-id answer is `already-absent`, so a repeat after
 * a partial sweep completes. A malformed, unreadable, secret-shaped or
 * off-pattern member refuses the whole sweep; the raw rejected string is
 * never copied into any result. Worktrees are left to the reaper. No clock is
 * read here except the injected one; reasons, keys and chain names only,
 * never a path or an input value.
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

interface PlannedDelete {
  readonly chainName: string;
  readonly branchName: string;
  readonly actionId: string;
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
 * a landed chain, null for a skipped non-landed record, or a refusal.
 */
function readRecord(record: unknown): PlannedDelete | null | SweepRefusal {
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
    return { chainName, branchName, actionId: `chain-sweep/${chainName}@r${revision}/chain` };
  } catch {
    return { kind: 'plain', reasonCode: 'record-malformed' };
  }
}

export class SweepChainsUseCase implements SweepChainsPort {
  constructor(
    private readonly deps: {
      readonly chains: Pick<ChainRepositoryPort, 'listChains'>;
      readonly forge: MergeForgeActionPort;
      readonly now: () => string;
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
    const planned: PlannedDelete[] = [];
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
      if ('kind' in read && read.kind === 'plain') {
        return refusalResult(read);
      }
      if ('kind' in read && read.kind === 'branch') {
        return refusalResult(read);
      }
      // A landed record: validate its linkBranches membership before any delete.
      const links = this.readLinkBranches(records[index], read);
      if (typeof links === 'string') {
        return refusalResult({ kind: 'plain', reasonCode: links });
      }
      for (const refusal of links) {
        return refusalResult(refusal);
      }
      if (!seenChains.has(read.chainName)) {
        seenChains.add(read.chainName);
        planned.push(read);
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
        branches: planned.map((entry) => ({
          chainName: entry.chainName,
          role: 'chain' as const,
          actionId: entry.actionId,
          branchName: entry.branchName,
          outcome: 'would-delete' as const,
          reasonCode: null,
        })),
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
   * refusal reason, otherwise each member is classified and every refusal is
   * returned. Duplicate valid links collapse into the one planned delete.
   */
  private readLinkBranches(source: unknown, record: PlannedDelete): string | readonly SweepRefusal[] {
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
      const refusals: SweepRefusal[] = [];
      for (let index = 0; index < raw.length; index += 1) {
        if (!Object.hasOwn(raw, index)) {
          return [{ kind: 'plain', reasonCode: 'record-malformed' }];
        }
        const branchClass = classifySweepBranch(record.chainName, raw[index]);
        if (branchClass !== null || raw[index] !== record.branchName) {
          refusals.push({
            kind: 'branch',
            reasonCode: 'branch-pattern-refused',
            branchClass: branchClass ?? 'not-chain-pattern',
            chainName: record.chainName,
            memberRole: 'link',
            memberIndex: index,
          });
        }
      }
      return refusals;
    } catch {
      return 'record-malformed';
    }
  }

  private async apply(command: ValidCommand, planned: readonly PlannedDelete[]): Promise<SweepChainsResult> {
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
    for (const entry of planned) {
      const nowIso = this.safeNow();
      if (!this.hasBudget(command.deadlineIso, nowIso)) {
        return { outcome: 'budget-exhausted', reasonCode: null, branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
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
        branches.push({ chainName: entry.chainName, role: 'chain', actionId: entry.actionId, branchName: entry.branchName, outcome: 'deleted', reasonCode: null });
        continue;
      }
      if (result.outcome === 'branch-gone' || result.outcome === 'already-applied') {
        branches.push({ chainName: entry.chainName, role: 'chain', actionId: entry.actionId, branchName: entry.branchName, outcome: 'already-absent', reasonCode: null });
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
    return { outcome: 'completed', reasonCode: null, branchClass: null, chainName: null, memberRole: null, memberIndex: null, branches };
  }
}
