// @generated entity stub — refined for lane T2c.
/**
 * PermissionRequest is the domain entity for one pending tool-permission
 * request. It carries the tool call's name and verbatim input under an
 * API-issued id and enforces the "first verdict wins" invariant: the first
 * decision is recorded once, the same decision again changes nothing, and a
 * different decision is a conflict that leaves the stored verdict untouched.
 *
 * The entity is pure: the clock and the id arrive as arguments, it never
 * reads the clock, never throws on malformed input, and holds no I/O. A
 * verdict grants nothing beyond the one tool call it names.
 */

export type ToolPermissionDecision = 'allow' | 'deny';
export type PermissionRequestState = 'pending' | 'decided' | 'expired';
export type ToolPermissionReasonCode = 'timed-out' | 'interrupted';

export interface PermissionRequestProps {
  readonly requestId: string;
  readonly threadId: string;
  readonly toolName: string;
  /** Stored verbatim; never returned by any use case or route. */
  readonly toolInput: unknown;
  readonly requestedAtIso: string;
  readonly deadlineAtIso: string;
}

export interface PermissionVerdictRecord {
  readonly decision: ToolPermissionDecision;
  readonly actorId: string;
  readonly decidedAtIso: string;
  readonly reasonCode?: string;
}

export interface PermissionRequestRecord extends PermissionRequestProps {
  readonly state: PermissionRequestState;
  readonly verdict?: PermissionVerdictRecord;
}

export class PermissionRequest {
  private verdictRecord?: PermissionVerdictRecord;
  private state: PermissionRequestState = 'pending';

  constructor(
    private readonly props: PermissionRequestProps,
    initial?: { readonly state?: PermissionRequestState; readonly verdict?: PermissionVerdictRecord },
  ) {
    if (initial?.state !== undefined) {
      this.state = initial.state;
    }
    if (initial?.verdict !== undefined) {
      this.verdictRecord = { ...initial.verdict };
    }
  }

  getId(): string {
    return this.props.requestId;
  }

  getThreadId(): string {
    return this.props.threadId;
  }

  getDeadlineAtIso(): string {
    return this.props.deadlineAtIso;
  }

  getState(): PermissionRequestState {
    return this.state;
  }

  getVerdict(): PermissionVerdictRecord | undefined {
    return this.verdictRecord === undefined ? undefined : { ...this.verdictRecord };
  }

  /** Still awaiting: no verdict yet and `nowIso` has not passed the deadline. */
  isAwaitingVerdict(nowIso: string): boolean {
    if (this.state !== 'pending' || this.verdictRecord !== undefined) {
      return false;
    }
    return nowIso <= this.props.deadlineAtIso;
  }

  /**
   * Record the first verdict. No verdict yet -> `recorded`; the same
   * decision again -> `unchanged` (the stored verdict is untouched); a
   * different decision -> `conflict` (the stored verdict is untouched);
   * a verdict on an expired request -> `expired`.
   */
  decide(
    decision: ToolPermissionDecision,
    actorId: string,
    decidedAtIso: string,
  ): 'recorded' | 'unchanged' | 'conflict' | 'expired' {
    if (this.state === 'expired') {
      return 'expired';
    }
    if (this.verdictRecord !== undefined) {
      return this.verdictRecord.decision === decision ? 'unchanged' : 'conflict';
    }
    this.state = 'decided';
    this.verdictRecord = { decision, actorId, decidedAtIso };
    return 'recorded';
  }

  /**
   * Expire a pending request. If already decided or expired, this is a no-op.
   */
  expire(
    reasonCode: ToolPermissionReasonCode,
    expiredAtIso: string,
  ): 'expired' | 'noop' {
    if (this.state === 'decided' || (this.verdictRecord !== undefined && this.state !== 'expired')) {
      return 'noop';
    }
    if (this.state === 'expired') {
      return 'noop';
    }
    this.state = 'expired';
    this.verdictRecord = {
      decision: 'deny',
      actorId: 'system',
      decidedAtIso: expiredAtIso,
      reasonCode,
    };
    return 'expired';
  }

  toRecord(): PermissionRequestRecord {
    const base = {
      requestId: this.props.requestId,
      threadId: this.props.threadId,
      toolName: this.props.toolName,
      toolInput: this.props.toolInput,
      requestedAtIso: this.props.requestedAtIso,
      deadlineAtIso: this.props.deadlineAtIso,
    };
    if (this.state === 'pending') {
      return { ...base, state: 'pending' as const };
    }
    if (this.state === 'expired') {
      return { ...base, state: 'expired' as const, verdict: { ...this.verdictRecord! } };
    }
    return { ...base, state: 'decided' as const, verdict: { ...this.verdictRecord! } };
  }
}
