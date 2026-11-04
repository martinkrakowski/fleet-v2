/**
 * InspectAttemptUseCase: fetch an attempt record safely without invoking the
 * runner subprocess or mutating server state. Safe and idempotent for GET routes.
 */

import type {
  InspectAttemptPort,
  InspectAttemptRequest,
  InspectAttemptResult,
} from '../ports/in/InspectAttemptPort.in-port.js';
import type { AttemptRepositoryPort } from '../ports/out/AttemptRepositoryPort.out-port.js';
import type { RunnerForAttemptPort } from '../ports/out/RunnerForAttemptPort.out-port.js';
import type { AcceptanceEvidencePort } from '../ports/out/AcceptanceEvidencePort.out-port.js';
import type { ExecutionJournalPort } from '../ports/out/ExecutionJournalPort.out-port.js';
import type { AttemptRecord } from '../../domain/execution-records.js';
import type { AttemptStateValue } from '../../domain/value-objects/AttemptState.vo.js';

export interface InspectAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  /**
   * Optional (H9b1). When given, an attempt whose recorded host no longer
   * matches the current installation inspects as `unknown` with the reason,
   * never a guess from another host. Without it the behaviour is unchanged.
   */
  readonly runnerForAttempt?: RunnerForAttemptPort;
}

export class InspectAttemptUseCase implements InspectAttemptPort {
  constructor(private readonly deps?: InspectAttemptDependencies) {}

  async inspectAttempt(request: InspectAttemptRequest): Promise<InspectAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: InspectAttemptUseCase');
    }

    if (!request.attemptId) {
      return { outcome: 'not-found', attemptId: request.attemptId ?? '' };
    }

    const attempt = await this.deps.attemptRepo.findAttemptById(request.attemptId);
    if (!attempt) {
      return { outcome: 'not-found', attemptId: request.attemptId };
    }

    if (this.deps.runnerForAttempt) {
      // The recorded host is the truth: a recorded host that changed or was
      // removed inspects as unknown with the reason, never a guess.
      const selection = this.deps.runnerForAttempt.runnerForAttempt({
        runner: attempt.runner ?? null,
      });
      if (!selection.ok) {
        return { outcome: 'unknown', attemptId: request.attemptId, reason: selection.reason };
      }
    }

    return { outcome: 'found', attempt };
  }

  async execute(input?: unknown): Promise<InspectAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: InspectAttemptUseCase');
    }
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: InspectAttemptUseCase');
    }
    return this.inspectAttempt(input as InspectAttemptRequest);
  }
}

// ---------------------------------------------------------------------------
// ExplainAttemptUseCase: one read-only explanation of one attempt. It reads
// the attempt record, its journal, held reservations and acceptance evidence,
// never a runner subprocess, and never writes.
// ---------------------------------------------------------------------------

export type ExplainLineSource = 'record' | 'runner' | 'capacity' | 'gate' | 'next';

export interface ExplainAttemptLine {
  readonly source: ExplainLineSource;
  readonly status: 'known' | 'unknown';
  readonly detail: string;
  /** The revision or timestamp this line was read at; null when the source has none. */
  readonly readAt: string | null;
}

export interface ExplainNextCommand {
  readonly command: 'dispatch' | 'reconcile' | 'stop' | 'collect' | 'accept' | 'fix';
  readonly legal: boolean;
  /** '' when legal; otherwise a short reason code. */
  readonly reason: string;
}

export interface ExplainAttemptRequest {
  readonly attemptId: string;
}

export type ExplainAttemptResult =
  | {
      readonly outcome: 'explained';
      readonly attemptId: string;
      readonly lines: readonly ExplainAttemptLine[];
      readonly next: readonly ExplainNextCommand[];
    }
  | { readonly outcome: 'not-found'; readonly attemptId: string }
  | { readonly outcome: 'unknown'; readonly attemptId: string; readonly reason: string };

export interface ExplainAttemptDependencies {
  readonly attemptRepo: AttemptRepositoryPort;
  readonly journal: ExecutionJournalPort;
  /** Optional: without it the gate line is unknown, never a guess. */
  readonly acceptanceEvidence?: AcceptanceEvidencePort;
}

const EXPLAIN_LIVE_STATES: readonly AttemptStateValue[] = [
  'dispatching',
  'running',
  'reconciling',
  'blocked',
];

const EXPLAIN_TERMINAL_STATES: readonly AttemptStateValue[] = [
  'ended',
  'collected',
  'cancelled',
];

function legal(command: ExplainNextCommand['command']): ExplainNextCommand {
  return { command, legal: true, reason: '' };
}

function refused(command: ExplainNextCommand['command'], reason: ExplainNextCommand['reason']): ExplainNextCommand {
  return { command, legal: false, reason };
}

/** `reconcile` and `stop` share one shape: live, terminal, or not yet dispatched. */
function lifecycleCommand(
  command: 'reconcile' | 'stop',
  state: AttemptStateValue,
  hasSession: boolean,
): ExplainNextCommand {
  if (EXPLAIN_TERMINAL_STATES.includes(state)) {
    return refused(command, 'terminal-state');
  }
  if (!EXPLAIN_LIVE_STATES.includes(state)) {
    return refused(command, 'not-dispatched');
  }
  return command === 'stop' && !hasSession ? refused(command, 'no-session') : legal(command);
}

function collectCommand(attempt: AttemptRecord): ExplainNextCommand {
  const hasReceipt = attempt.completionReceipt !== null && attempt.completionReceipt !== undefined;
  if (attempt.state === 'ended') {
    return hasReceipt ? legal('collect') : refused('collect', 'no-completion-receipt');
  }
  if (attempt.state === 'collected' && !hasReceipt) {
    return refused('collect', 'no-completion-receipt');
  }
  return refused('collect', 'not-ended');
}

function acceptCommand(attempt: AttemptRecord): ExplainNextCommand {
  if (attempt.state !== 'collected') {
    return refused('accept', 'not-collected');
  }
  const headCommit = attempt.artifacts?.headCommit;
  return typeof headCommit === 'string' && headCommit !== '' ? legal('accept') : refused('accept', 'no-head');
}

/** The next-command table: one entry per fixed command, derived from the attempt record alone. */
function explainNextCommands(attempt: AttemptRecord): ExplainNextCommand[] {
  const { state } = attempt;
  const hasSession = typeof attempt.sessionId === 'string' && attempt.sessionId !== '';
  return [
    state === 'intent-recorded' ? legal('dispatch') : refused('dispatch', 'already-dispatched'),
    lifecycleCommand('reconcile', state, hasSession),
    lifecycleCommand('stop', state, hasSession),
    collectCommand(attempt),
    acceptCommand(attempt),
    state === 'collected' || state === 'cancelled' ? legal('fix') : refused('fix', 'prior-not-ready'),
  ];
}

export class ExplainAttemptUseCase {
  constructor(private readonly deps?: ExplainAttemptDependencies) {}

  async explainAttempt(request: ExplainAttemptRequest): Promise<ExplainAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ExplainAttemptUseCase');
    }

    const attemptId = request.attemptId ?? '';
    if (attemptId === '') {
      return { outcome: 'not-found', attemptId: '' };
    }

    const first = await this.deps.attemptRepo.findAttemptById(attemptId);
    if (first === null) {
      return { outcome: 'not-found', attemptId };
    }

    const entries = await this.deps.journal.listJournalEntriesForAttempt(attemptId);
    const reservations = await this.deps.journal.listActiveReservations();

    let gateLine: ExplainAttemptLine;
    const head =
      typeof first.artifacts?.headCommit === 'string' && first.artifacts.headCommit !== ''
        ? first.artifacts.headCommit
        : null;
    if (head === null) {
      gateLine = {
        source: 'gate',
        status: 'unknown',
        detail: 'no collected head to judge',
        readAt: null,
      };
    } else if (this.deps.acceptanceEvidence === undefined) {
      gateLine = {
        source: 'gate',
        status: 'unknown',
        detail: 'no acceptance source is configured',
        readAt: null,
      };
    } else {
      const acceptance = await this.deps.acceptanceEvidence.readAcceptance({
        attemptId,
        candidateHeadSha: head,
      });
      if (acceptance.outcome === 'found') {
        gateLine = {
          source: 'gate',
          status: 'known',
          detail: `acceptance ${acceptance.assessment.state} at ${acceptance.assessment.candidateHeadSha} (receipt ${acceptance.assessment.acceptanceReceiptId ?? 'none'})`,
          readAt: acceptance.assessment.candidateHeadSha,
        };
      } else {
        gateLine = {
          source: 'gate',
          status: 'unknown',
          detail: `no acceptance receipt is recorded for head ${head}`,
          readAt: head,
        };
      }
    }

    // The final attempt read must be the last read: if the attempt's revision
    // changes while the reads above run, refuse rather than explain stale data.
    const last = await this.deps.attemptRepo.findAttemptById(attemptId);
    if (last === null || (last.revision ?? 0) !== (first.revision ?? 0)) {
      return {
        outcome: 'unknown',
        attemptId,
        reason: 'the attempt changed while it was being explained; run it again',
      };
    }

    const recordLine: ExplainAttemptLine = {
      source: 'record',
      status: 'known',
      detail: `state ${last.state}, revision ${last.revision ?? 0}`,
      readAt: String(last.revision ?? 0),
    };

    let runnerLine: ExplainAttemptLine;
    const reconcileEntry = [...entries].reverse().find((entry) => entry.action === 'reconcile');
    if (reconcileEntry === undefined) {
      runnerLine = {
        source: 'runner',
        status: 'unknown',
        detail: 'no reconcile answer is recorded',
        readAt: null,
      };
    } else {
      runnerLine = {
        source: 'runner',
        status: 'known',
        detail: `reconcile answered ${reconcileEntry.status} at ${reconcileEntry.recordedAtIso}`,
        readAt: reconcileEntry.recordedAtIso,
      };
    }

    let capacityLine: ExplainAttemptLine;
    const held = reservations.find((reservation) => reservation.attemptId === attemptId);
    if (held === undefined) {
      capacityLine = {
        source: 'capacity',
        status: 'known',
        detail: 'no reservation is held',
        readAt: null,
      };
    } else {
      capacityLine = {
        source: 'capacity',
        status: 'known',
        detail: `held on ${held.hostId} slot ${held.slotIndex}`,
        readAt: held.reservedAtIso,
      };
    }

    const next = explainNextCommands(last);
    const legalNames = next.filter((command) => command.legal).map((command) => command.command);
    const refused = next.filter((command) => !command.legal);
    const nextLine: ExplainAttemptLine = {
      source: 'next',
      status: 'known',
      detail: `legal: ${legalNames.join(', ') || 'none'}; refused: ${refused.map((command) => `${command.command} (${command.reason})`).join(', ') || 'none'}; derived from the attempt record alone`,
      readAt: String(last.revision ?? 0),
    };

    const lines: readonly ExplainAttemptLine[] = [recordLine, runnerLine, capacityLine, gateLine, nextLine];

    return { outcome: 'explained', attemptId, lines, next };
  }

  async execute(input?: unknown): Promise<ExplainAttemptResult> {
    if (!this.deps) {
      throw new Error('Not implemented: ExplainAttemptUseCase');
    }
    if (!input || typeof input !== 'object') {
      throw new Error('Not implemented: ExplainAttemptUseCase');
    }
    return this.explainAttempt(input as ExplainAttemptRequest);
  }
}
