// @generated inbound contract scaffold — refined for lane CO16.
/** The fact pack a brief writer reads, rendered with untrusted markers. */

export type BuildFactPackFact =
  | { readonly kind: 'file-list'; readonly label: string; readonly pathPrefix: string }
  | { readonly kind: 'file-range'; readonly label: string; readonly path: string; readonly fromLine: number; readonly toLine: number }
  | { readonly kind: 'matching-lines'; readonly label: string; readonly path: string; readonly token: string };

export interface BuildFactPackRequest {
  readonly laneId: string;
  readonly repositoryPath: string;
  readonly commit: string;
  readonly facts: readonly BuildFactPackFact[];
}

export type BuildFactPackRefusalReason =
  | 'invalid-request'
  | 'fact-absent'
  | 'fact-unreadable'
  | 'fact-oversized'
  | 'secret-shaped';

export interface BuildFactPackRefusal {
  readonly reason: BuildFactPackRefusalReason;
  /** The label of the offending fact; null when the request itself is invalid. */
  readonly label: string | null;
  /** The secret-pattern rule name when reason is 'secret-shaped'; null otherwise. */
  readonly rule: string | null;
}

export type BuildFactPackResult =
  | { readonly outcome: 'built'; readonly prompt: string; readonly factCount: number }
  | { readonly outcome: 'refused'; readonly refusal: BuildFactPackRefusal };

export interface BuildFactPackPort {
  buildFactPack(request: BuildFactPackRequest): Promise<BuildFactPackResult>;
}
