/**
 * RefreshChainsUseCase (lane CO8): the chain-refresh daemon job for one
 * repository. The order is the contract: validate the envelope (no write, no
 * forge call on a failure), list the active chains, read `main`'s head once,
 * then per chain record the keyed intent by CAS, merge `main` into the chain
 * branch through the forge under the same key, and record the outcome by CAS.
 * A repeated key returns the recorded result without a second forge call; a
 * crash between intent and result is recovered by re-reading the record and
 * re-issuing the convergent merge. A conflict sets the record's conflict mark
 * and raises a `chain-refresh-conflict` attention item; merged/up-to-date
 * clears the mark (written with the outcome) and the attention item. Unknown
 * stays unknown: an unreadable record, an unreadable `main` head and an
 * ambiguous forge answer are skipped with a reason code, never merged, empty or
 * a pass. The pass stops when fewer than `DAEMON_CALL_MIN_REMAINING_MS` remain.
 * No clock is read here except the injected one; reasons, keys and chain names
 * only, never a path or an input value.
 */

import { containsSecretShape } from '@fleet/shared';
import {
  chainRefreshKey,
  chainRefreshOf,
  parseChainRepository,
} from '../../domain/chain-records.js';
import type { ChainRecord } from '../../domain/chain-records.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import { computeCallBudget, DAEMON_CALL_MIN_REMAINING_MS } from '../../domain/daemon-tick.js';
import type {
  RefreshChainsChainReport,
  RefreshChainsCommand,
  RefreshChainsPort,
  RefreshChainsResult,
} from '../ports/in/RefreshChainsPort.in-port.js';
import type { ChainAttentionPort } from '../ports/out/ChainAttentionPort.out-port.js';
import type { ChainRepositoryPort } from '../ports/out/ChainRepositoryPort.out-port.js';
import type { MergeBranchHeadResult, MergeForgeActionPort } from '../ports/out/MergeForgeActionPort.out-port.js';

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

interface ValidCommand {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly projectId: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
}

/** Read a field from its own data property, so no getter ever runs. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

type Validation =
  | { readonly ok: true; readonly command: ValidCommand }
  | { readonly ok: false; readonly reason: string };

function validate(raw: unknown): Validation {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const repository = parseChainRepository(ownValue(raw, 'repository'));
    if (repository === undefined) {
      return { ok: false, reason: 'invalid-repository' };
    }
    const projectId = ownValue(raw, 'projectId');
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId) || containsSecretShape(projectId)) {
      return { ok: false, reason: 'invalid-project-id' };
    }
    const nowIso = ownValue(raw, 'nowIso');
    if (!isZonedIsoDateTime(nowIso)) {
      return { ok: false, reason: 'invalid-now' };
    }
    const deadlineIso = ownValue(raw, 'deadlineIso');
    if (!isZonedIsoDateTime(deadlineIso)) {
      return { ok: false, reason: 'invalid-deadline' };
    }
    return { ok: true, command: { repository, projectId, nowIso, deadlineIso } };
  } catch {
    return { ok: false, reason: 'invalid-request' };
  }
}

export class RefreshChainsUseCase implements RefreshChainsPort {
  constructor(
    private readonly deps: {
      readonly chains: ChainRepositoryPort;
      readonly forge: MergeForgeActionPort;
      readonly attention: ChainAttentionPort;
      readonly now?: () => string;
    },
  ) {}

  async runRefreshChains(command: RefreshChainsCommand): Promise<RefreshChainsResult> {
    try {
      const valid = validate(command);
      if (!valid.ok) {
        return { outcome: 'refused', reasonCode: valid.reason, chains: [] };
      }
      return await this.run(valid.command);
    } catch {
      return { outcome: 'refused', reasonCode: 'invalid-request', chains: [] };
    }
  }

  private currentNow(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /** The budget guard of CO8: a call is never started with under 2 s left. */
  private hasBudget(deadlineIso: string): boolean {
    return computeCallBudget({
      nowIso: this.currentNow(),
      deadlineIso,
      normalTimeoutMs: DAEMON_CALL_MIN_REMAINING_MS,
    }).allowed;
  }

  private async run(command: ValidCommand): Promise<RefreshChainsResult> {
    const listed = await this.deps.chains.listChains({
      repository: command.repository,
      deadlineIso: command.deadlineIso,
    });
    if (listed.status === 'unreadable') {
      return { outcome: 'skipped', reasonCode: 'chains-unreadable', chains: [] };
    }
    const head = await this.readMainHead(command);
    if (head.outcome === 'not-found') {
      return { outcome: 'skipped', reasonCode: 'main-not-found', chains: [] };
    }
    if (head.outcome === 'unavailable') {
      return { outcome: 'skipped', reasonCode: 'main-unreadable', chains: [] };
    }
    const chains: RefreshChainsChainReport[] = [];
    let budgetHit = false;
    for (const record of listed.records) {
      if (record.state !== 'started') {
        continue;
      }
      if (!this.hasBudget(command.deadlineIso)) {
        budgetHit = true;
        break;
      }
      const decision = await this.refreshOne(command, record, head.headSha, chains);
      if (decision === 'budget-exhausted') {
        budgetHit = true;
        break;
      }
    }
    if (budgetHit) {
      return { outcome: 'budget-exhausted', reasonCode: null, chains };
    }
    return { outcome: 'completed', reasonCode: null, chains };
  }

  private async readMainHead(command: ValidCommand): Promise<MergeBranchHeadResult> {
    try {
      return await this.deps.forge.readMergeBranchHead({
        repository: command.repository,
        branchName: 'main',
        deadlineIso: command.deadlineIso,
      });
    } catch {
      return { outcome: 'unavailable', reason: 'read-failed' };
    }
  }

  private skip(chains: RefreshChainsChainReport[], chainName: string, key: string): void {
    chains.push({ chainName, key, outcome: 'skipped' });
  }

  /** One chain: the keyed intent, the convergent merge, the recorded outcome, the attention. */
  private async refreshOne(
    command: ValidCommand,
    record: ChainRecord,
    mainSha: string,
    chains: RefreshChainsChainReport[],
  ): Promise<'done' | 'budget-exhausted'> {
    const key = chainRefreshKey(record.chainName, mainSha);
    if (key === null) {
      this.skip(chains, record.chainName, '');
      return 'done';
    }
    const stored = chainRefreshOf(record);
    if (stored !== null && stored.key === key && stored.outcome !== 'in-flight') {
      chains.push({ chainName: record.chainName, key, outcome: stored.outcome });
      return 'done';
    }
    const intent = await this.deps.chains.recordChainRefreshIntent({
      repository: command.repository,
      chainName: record.chainName,
      key,
      mainSha,
      expectedRevision: record.revision,
      atIso: command.nowIso,
      deadlineIso: command.deadlineIso,
    });
    if (intent.outcome === 'refused') {
      this.skip(chains, record.chainName, key);
      return 'done';
    }
    // Re-read once: an `already-recorded` intent returns the recorded outcome when terminal;
    // a fresh intent advances the revision the outcome CAS must expect; a crash between the
    // intent and the result is recovered here by re-issuing the convergent merge.
    const reread = await this.deps.chains.readChain({
      repository: command.repository,
      chainName: record.chainName,
      deadlineIso: command.deadlineIso,
    });
    if (reread.status !== 'ok') {
      this.skip(chains, record.chainName, key);
      return 'done';
    }
    const freshest = reread.record;
    const recordedEntry = chainRefreshOf(freshest);
    if (recordedEntry !== null && recordedEntry.key === key && recordedEntry.outcome !== 'in-flight') {
      chains.push({ chainName: record.chainName, key, outcome: recordedEntry.outcome });
      return 'done';
    }
    if (!this.hasBudget(command.deadlineIso)) {
      return 'budget-exhausted';
    }
    const forge = await this.forgeCall(command, record, key, mainSha);
    if (forge === 'budget-exhausted') {
      return 'budget-exhausted';
    }
    if (forge.outcome === 'ambiguous') {
      this.skip(chains, record.chainName, key);
      return 'done';
    }
    let outcome: 'merged' | 'up-to-date' | 'conflict' | 'branch-gone';
    if (forge.outcome === 'executed') {
      outcome = 'merged';
    } else if (forge.outcome === 'already-applied') {
      outcome = 'up-to-date';
    } else if (forge.outcome === 'branch-gone') {
      outcome = 'branch-gone';
    } else if (forge.outcome === 'refused' && forge.refusalKind === 'conflict') {
      outcome = 'conflict';
    } else {
      // Any other refusal is unknown: reported as skipped, never retried as a merge.
      this.skip(chains, record.chainName, key);
      return 'done';
    }
    const recorded = await this.deps.chains.recordChainRefreshOutcome({
      repository: command.repository,
      chainName: record.chainName,
      key,
      expectedRevision: freshest.revision,
      outcome,
      atIso: command.nowIso,
      deadlineIso: command.deadlineIso,
    });
    if (recorded.outcome !== 'recorded') {
      this.skip(chains, record.chainName, key);
      return 'done';
    }
    if (outcome === 'conflict') {
      // A refused raise is reported by the adapter and never retried blindly.
      await this.deps.attention.raiseChainAttention({
        projectId: command.projectId,
        chainName: record.chainName,
        kind: 'chain-refresh-conflict',
      });
    } else if (outcome === 'merged' || outcome === 'up-to-date') {
      await this.deps.attention.clearChainAttention({
        projectId: command.projectId,
        chainName: record.chainName,
        kind: 'chain-refresh-conflict',
      });
    }
    chains.push({ chainName: record.chainName, key, outcome });
    return 'done';
  }

  private async forgeCall(
    command: ValidCommand,
    record: ChainRecord,
    key: string,
    mainSha: string,
  ): Promise<Awaited<ReturnType<MergeForgeActionPort['performMergeForgeAction']>> | 'budget-exhausted'> {
    if (!this.hasBudget(command.deadlineIso)) {
      return 'budget-exhausted';
    }
    try {
      return await this.deps.forge.performMergeForgeAction({
        kind: 'merge-main-into-branch',
        actionId: key,
        repository: command.repository,
        branchName: record.branchName,
        sourceBranch: 'main',
        expectedHeadSha: mainSha,
        deadlineIso: command.deadlineIso,
      });
    } catch {
      return { outcome: 'ambiguous', reason: 'forge-call-failed' };
    }
  }
}
