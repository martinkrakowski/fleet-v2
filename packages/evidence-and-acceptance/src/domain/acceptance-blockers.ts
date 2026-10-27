/**
 * Acceptance blocker kinds (auto-merge plan A11). A blocker's kind is data that
 * travels beside its display text, so no caller ever decides by parsing a
 * reason string. Only `ci-pending` means "not yet": every other kind is a
 * standing blocker. Pure: no Node or vendor import.
 */
export const ACCEPTANCE_BLOCKER_KINDS = [
  'ci-pending',
  'ci-failed',
  'threads-unresolved',
  'threads-unreadable',
  'review-missing',
  'door',
  'stale',
  'other',
] as const;

export type AcceptanceBlockerKind = (typeof ACCEPTANCE_BLOCKER_KINDS)[number];

/** One blocker: its kind and the exact text acceptance has always shown. */
export interface AcceptanceBlocker {
  readonly kind: AcceptanceBlockerKind;
  readonly text: string;
}

export function isAcceptanceBlockerKind(value: unknown): value is AcceptanceBlockerKind {
  return typeof value === 'string' && (ACCEPTANCE_BLOCKER_KINDS as readonly string[]).includes(value);
}

/** A frozen blocker. */
export function acceptanceBlocker(kind: AcceptanceBlockerKind, text: string): AcceptanceBlocker {
  return Object.freeze({ kind, text });
}
