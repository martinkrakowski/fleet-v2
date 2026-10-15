// @generated value-object stub — refined for step 5.
/**
 * CoordinationKind is an immutable value object over the manifest's coordination
 * enum. A value outside COORDINATION_KINDS never constructs, so an unrecorded
 * kind can never reach a proposal, a relay or an alert.
 */

export const COORDINATION_KINDS = [
  'action-decision',
  'policy-proposal',
  'relay',
  'registry-alert',
] as const;

export type CoordinationKindValue = (typeof COORDINATION_KINDS)[number];

const COORDINATION_KIND_VALUES: readonly string[] = COORDINATION_KINDS;

export class CoordinationKind {
  private constructor(private readonly value: CoordinationKindValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: boolean; value?: CoordinationKind; error?: Error } {
    if (typeof value !== 'string' || !COORDINATION_KIND_VALUES.includes(value)) {
      return { success: false, error: new Error(`Invalid coordination kind: ${String(value)}`) };
    }
    return { success: true, value: new CoordinationKind(value as CoordinationKindValue) };
  }

  getValue(): CoordinationKindValue {
    return this.value;
  }

  /** Only a decision or a policy proposal asks its authorized decider. */
  requiresDecision(): boolean {
    return this.value === 'action-decision' || this.value === 'policy-proposal';
  }

  equals(other: CoordinationKind): boolean {
    return this.value === other.value;
  }
}
