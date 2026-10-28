// @generated outbound contract scaffold — refined for AM4a-1.
/**
 * AutoMergeSettingsPort: read a structural subset of the installation's `policy.autoMerge`, its
 * `autoMergeRevision` and its forge mode, so work-execution stays free of `@fleet/installation` (the
 * free-seat pattern of `AllowedSeatPort`); the composition root re-reads the installation on every call.
 */

export type AutoMergeSettingsAnswer =
  | {
      readonly outcome: 'read';
      readonly enabled: boolean;
      readonly allowHighRisk: boolean;
      readonly onBlocked: 'ask-owner' | 'hold';
      readonly revision: string;
      readonly forgeMode: 'github' | 'none' | 'unknown';
    }
  | { readonly outcome: 'unreadable'; readonly reason: string };

export interface AutoMergeSettingsPort {
  readAutoMergeSettings(): Promise<AutoMergeSettingsAnswer>;
}
