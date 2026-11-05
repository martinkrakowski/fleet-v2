/**
 * StartChainUseCase (lane CO7): start one chain. The order is the contract:
 * validate the envelope (no write, no forge call on a failure), read the
 * chain, record the keyed intent, then create `chain/<name>` from `main`
 * through the forge, then record the outcome. An ambiguous forge answer is
 * reconciled by reading the branch head, never guessed and never written
 * twice. A repeated call with the recorded key returns the recorded outcome;
 * a crash between intent and result is recovered by reading the branch first.
 * No clock, no logging, no command line; reasons are fixed codes.
 */

import {
  applyChainOutcome,
  decideChainStart,
  createChainRecord,
  isChainActionKey,
  isChainCommitSha,
  isChainReasonCode,
  parseChainName,
  parseChainRepository,
} from '../../domain/chain-records.js';
import type { ChainRecord, ChainRepositoryRef } from '../../domain/chain-records.js';
import { isZonedIsoDateTime } from '../../domain/conductor-halt.js';
import type {
  StartChainCommand,
  StartChainDecision,
  StartChainPort,
  StartChainReason,
} from '../ports/in/StartChainPort.in-port.js';
import { START_CHAIN_REASONS } from '../ports/in/StartChainPort.in-port.js';
import type { ChainRepositoryPort } from '../ports/out/ChainRepositoryPort.out-port.js';
import type { MergeForgeActionPort } from '../ports/out/MergeForgeActionPort.out-port.js';

interface ValidCommand {
  readonly repository: ChainRepositoryRef;
  readonly chainName: string;
  readonly branchName: string;
  readonly expectedHeadSha: string;
  readonly actionKey: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
}

type Validation =
  | { readonly ok: true; readonly command: ValidCommand }
  | { readonly ok: false; readonly reason: StartChainReason };

/** Read a field from its own data property, so no getter ever runs. */
function ownValue(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function validate(raw: unknown): Validation {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: 'invalid-request' };
    }
    const repository = parseChainRepository(ownValue(raw, 'repository'));
    if (repository === undefined) {
      return { ok: false, reason: 'invalid-repository' };
    }
    const chainName = parseChainName(ownValue(raw, 'chainName'));
    if (chainName === undefined) {
      return { ok: false, reason: 'invalid-chain-name' };
    }
    const expectedHeadSha = ownValue(raw, 'expectedHeadSha');
    if (!isChainCommitSha(expectedHeadSha)) {
      return { ok: false, reason: 'invalid-expected-head' };
    }
    const actionKey = ownValue(raw, 'actionKey');
    if (!isChainActionKey(actionKey)) {
      return { ok: false, reason: 'invalid-action-key' };
    }
    const nowIso = ownValue(raw, 'nowIso');
    if (!isZonedIsoDateTime(nowIso)) {
      return { ok: false, reason: 'invalid-now' };
    }
    const deadlineIso = ownValue(raw, 'deadlineIso');
    if (!isZonedIsoDateTime(deadlineIso)) {
      return { ok: false, reason: 'invalid-deadline' };
    }
    return {
      ok: true,
      command: { repository, chainName, branchName: `chain/${chainName}`, expectedHeadSha, actionKey, nowIso, deadlineIso },
    };
  } catch {
    return { ok: false, reason: 'invalid-request' };
  }
}

function refused(reason: StartChainReason, record: ChainRecord | null = null): StartChainDecision {
  return { outcome: 'refused', reason, record };
}

function unresolved(record: ChainRecord | null = null): StartChainDecision {
  return { outcome: 'unknown', reason: 'unresolved', record };
}

/** The recorded refusal reason when it is one of this port's codes; a generic code otherwise. */
function recordedRefusalReason(record: ChainRecord): StartChainReason {
  const reason = record.reason;
  if (isChainReasonCode(reason) && (START_CHAIN_REASONS as readonly string[]).includes(reason)) {
    return reason as StartChainReason;
  }
  return 'chain-start-refused';
}

export class StartChainUseCase implements StartChainPort {
  constructor(private readonly deps: { readonly chains: ChainRepositoryPort; readonly forge: MergeForgeActionPort }) {}

  async startChain(command: StartChainCommand): Promise<StartChainDecision> {
    try {
      const valid = validate(command);
      if (!valid.ok) {
        return refused(valid.reason);
      }
      return await this.run(valid.command);
    } catch {
      return unresolved();
    }
  }

  private async run(command: ValidCommand): Promise<StartChainDecision> {
    const read = await this.deps.chains.readChain({
      repository: command.repository,
      chainName: command.chainName,
      deadlineIso: command.deadlineIso,
    });
    if (read.status === 'not-found') {
      return this.startFresh(command);
    }
    if (read.status !== 'ok') {
      return unresolved();
    }
    const record = read.record;
    if (
      record.chainName !== command.chainName ||
      record.branchName !== command.branchName ||
      record.repository.owner !== command.repository.owner ||
      record.repository.repo !== command.repository.repo
    ) {
      return unresolved();
    }
    if (record.actionKey !== command.actionKey) {
      if (record.state === 'started') {
        return refused('chain-already-started', record);
      }
      return refused(record.state === 'intent-recorded' ? 'chain-start-in-flight' : 'chain-start-refused', record);
    }
    if (record.expectedHeadSha !== command.expectedHeadSha) {
      return refused('action-key-conflict', record);
    }
    if (record.state === 'started') {
      return { outcome: 'started', record };
    }
    if (record.state === 'refused') {
      return refused(recordedRefusalReason(record), record);
    }
    return this.recover(command, record);
  }

  private async startFresh(command: ValidCommand): Promise<StartChainDecision> {
    const created = createChainRecord({
      repository: command.repository,
      chainName: command.chainName,
      expectedHeadSha: command.expectedHeadSha,
      actionKey: command.actionKey,
      createdAtIso: command.nowIso,
    });
    if (!created.ok) {
      return refused(created.reason === 'invalid-created-at' ? 'invalid-now' : created.reason);
    }
    const intent = await this.deps.chains.recordChainIntent({
      record: created.record,
      deadlineIso: command.deadlineIso,
    });
    if (intent.outcome === 'already-recorded') {
      return refused('chain-start-in-flight');
    }
    if (intent.outcome !== 'recorded') {
      return refused('intent-refused');
    }
    return this.createBranch(command, created.record);
  }

  /** The same key found at `intent-recorded`: a crash or an ambiguous answer left it open; read before any write. */
  private async recover(command: ValidCommand, record: ChainRecord): Promise<StartChainDecision> {
    const head = await this.readHead(command);
    if (head.outcome === 'not-found') {
      return this.createBranch(command, record);
    }
    return this.settleFromHead(command, record, head);
  }

  private async createBranch(command: ValidCommand, record: ChainRecord): Promise<StartChainDecision> {
    let result: Awaited<ReturnType<MergeForgeActionPort['performMergeForgeAction']>>;
    try {
      result = await this.deps.forge.performMergeForgeAction({
        kind: 'create-branch',
        actionId: command.actionKey,
        repository: command.repository,
        branchName: command.branchName,
        sourceBranch: 'main',
        expectedHeadSha: command.expectedHeadSha,
        deadlineIso: command.deadlineIso,
      });
    } catch {
      // A throw does not say whether the branch was created: reconcile by reading it.
      result = { outcome: 'ambiguous', reason: 'forge-call-failed' };
    }
    if (result.outcome === 'executed') {
      return result.headSha === command.expectedHeadSha
        ? this.settle(command, record, 'started', null)
        : this.settle(command, record, 'refused', 'branch-exists-at-other-commit');
    }
    if (result.outcome === 'refused') {
      return this.settle(command, record, 'refused', 'forge-refused');
    }
    if (result.outcome !== 'ambiguous') {
      return unresolved(record);
    }
    const head = await this.readHead(command);
    return this.settleFromHead(command, record, head);
  }

  /** One branch-head read; a throw is an unavailable read, never a not-found. */
  private async readHead(command: ValidCommand): Promise<Awaited<ReturnType<MergeForgeActionPort['readMergeBranchHead']>>> {
    try {
      return await this.deps.forge.readMergeBranchHead({
        repository: command.repository,
        branchName: command.branchName,
        deadlineIso: command.deadlineIso,
      });
    } catch {
      return { outcome: 'unavailable', reason: 'read-failed' };
    }
  }

  private async settleFromHead(
    command: ValidCommand,
    record: ChainRecord,
    head: Awaited<ReturnType<MergeForgeActionPort['readMergeBranchHead']>>,
  ): Promise<StartChainDecision> {
    const verdict = decideChainStart(
      head.outcome === 'found'
        ? { kind: 'branch-found', headSha: head.headSha }
        : head.outcome === 'not-found'
          ? { kind: 'branch-absent' }
          : { kind: 'unavailable' },
      command.expectedHeadSha,
    );
    if (verdict.state === 'unknown') {
      return unresolved(record);
    }
    return this.settle(command, record, verdict.state, verdict.reason);
  }

  /** Record the outcome; a failed record never turns a started chain into a refusal. */
  private async settle(
    command: ValidCommand,
    record: ChainRecord,
    state: 'started' | 'refused',
    reason: string | null,
  ): Promise<StartChainDecision> {
    let decision: Awaited<ReturnType<ChainRepositoryPort['recordChainOutcome']>>;
    try {
      decision = await this.deps.chains.recordChainOutcome({
        repository: command.repository,
        chainName: command.chainName,
        actionKey: command.actionKey,
        expectedRevision: record.revision,
        state,
        reason,
        deadlineIso: command.deadlineIso,
      });
    } catch {
      return unresolved(record);
    }
    if (decision.outcome !== 'recorded') {
      return unresolved(record);
    }
    const updated = applyChainOutcome(record, { state, reason });
    if (state === 'started') {
      return { outcome: 'started', record: updated };
    }
    return refused(recordedRefusalReason(updated), updated);
  }
}
