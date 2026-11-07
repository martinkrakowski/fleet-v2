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
}

export interface PermissionRequestRecord extends PermissionRequestProps {
  readonly state: 'pending' | 'decided';
  readonly verdict?: PermissionVerdictRecord;
}

export class PermissionRequest {
  private verdictRecord?: PermissionVerdictRecord;

  constructor(private readonly props: PermissionRequestProps) {}

  getId(): string {
    return this.props.requestId;
  }

  getVerdict(): PermissionVerdictRecord | undefined {
    return this.verdictRecord === undefined ? undefined : { ...this.verdictRecord };
  }

  /** Still awaiting: no verdict yet and `nowIso` has not passed the deadline. */
  isAwaitingVerdict(nowIso: string): boolean {
    if (this.verdictRecord !== undefined) {
      return false;
    }
    return nowIso <= this.props.deadlineAtIso;
  }

  /**
   * Record the first verdict. No verdict yet -> `recorded`; the same
   * decision again -> `unchanged` (the stored verdict is untouched); a
   * different decision -> `conflict` (the stored verdict is untouched).
   */
  decide(
    decision: ToolPermissionDecision,
    actorId: string,
    decidedAtIso: string,
  ): 'recorded' | 'unchanged' | 'conflict' {
    if (this.verdictRecord !== undefined) {
      return this.verdictRecord.decision === decision ? 'unchanged' : 'conflict';
    }
    this.verdictRecord = { decision, actorId, decidedAtIso };
    return 'recorded';
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
    if (this.verdictRecord === undefined) {
      return { ...base, state: 'pending' as const };
    }
    return { ...base, state: 'decided' as const, verdict: { ...this.verdictRecord } };
  }
}
