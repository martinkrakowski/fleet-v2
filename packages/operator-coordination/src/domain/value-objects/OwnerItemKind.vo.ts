// @generated value-object stub — refined for lane WB3a-1.
/**
 * OwnerItemKind is an immutable value object over the manifest's owner-item
 * enum (plan §3.3). A value outside OWNER_ITEM_KINDS never constructs, so an
 * unrecorded kind can never reach an owner item.
 */

export const OWNER_ITEM_KINDS = ['merge', 'secret', 'decision', 'backup', 'other'] as const;
export type OwnerItemKindValue = (typeof OWNER_ITEM_KINDS)[number];

/** The kinds that gate a lane named in `blocks` (plan §3.1, §3.3). */
export const OWNER_ITEM_GATING_KINDS = ['merge', 'decision', 'secret'] as const satisfies readonly OwnerItemKindValue[];
/** The kinds the owner may mark done or withdraw (D11). */
export const OWNER_ITEM_OWNER_CLOSABLE_KINDS = ['secret', 'backup', 'other'] as const satisfies readonly OwnerItemKindValue[];

const OWNER_ITEM_KIND_VALUES: readonly string[] = OWNER_ITEM_KINDS;

export class OwnerItemKind {
  private constructor(private readonly value: OwnerItemKindValue) {
    // Value is immutable after construction.
  }

  static create(value: unknown): { success: true; value: OwnerItemKind } | { success: false; error: Error } {
    if (typeof value !== 'string' || !OWNER_ITEM_KIND_VALUES.includes(value)) {
      return { success: false, error: new Error('OwnerItemKind is not one of merge, secret, decision, backup, other') };
    }
    return { success: true, value: new OwnerItemKind(value as OwnerItemKindValue) };
  }

  getValue(): OwnerItemKindValue {
    return this.value;
  }

  /** True for merge, decision and secret. */
  gates(): boolean {
    return (OWNER_ITEM_GATING_KINDS as readonly OwnerItemKindValue[]).includes(this.value);
  }

  /** True for secret, backup and other. */
  ownerMayClose(): boolean {
    return (OWNER_ITEM_OWNER_CLOSABLE_KINDS as readonly OwnerItemKindValue[]).includes(this.value);
  }

  equals(other: OwnerItemKind): boolean {
    return this.value === other.value;
  }
}
