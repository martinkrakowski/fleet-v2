// @generated outbound contract scaffold — refined for lane DTP (merge policy).
/**
 * MergePolicyPort: read the installation's `policy.merge.repos` and `policy.daemon` sections,
 * normalized, with their `policyRevision`. The types below are a structural subset of
 * `@fleet/installation`'s `MergePolicyRead`, so work-execution stays free of a dependency on that
 * package (the `AutoMergeSettingsPort` / `AllowedSeatPort` pattern): `@fleet/work-execution` does
 * not list `@fleet/installation` in its manifest and infrastructure may import only `domain`,
 * `application` and `@fleet/shared`. The composition root binds the adapter's seam to
 * `@fleet/installation`.
 *
 * Rules every implementation keeps:
 * - The port is read-only: it never writes the installation.
 * - The answer is taken at the section's revision on every call, never cached; a changed file
 *   changes the next answer.
 * - An unreadable or invalid section answers `unknown`: never a default, never an empty registry
 *   presented as a success. An installation that configures no merge repository is a valid empty
 *   configuration and answers `known` with zero repositories.
 * - `reason` is a code, never text: no path, file name, error message or configured value.
 */

export type MergePolicyVetoMode = 'off' | 'shadow' | 'live';

export interface MergePolicyRepository {
  readonly owner: string;
  readonly repo: string;
  /** `<owner>/<repo>`. */
  readonly repositoryKey: string;
  readonly projectId: string;
  readonly shadow: boolean;
  readonly unattended: boolean;
  readonly requiredContexts: readonly string[];
  readonly updateBranch: boolean;
  /** Null means none. */
  readonly macosProcedure: string | null;
  readonly maxAttempts: number;
  readonly checksGraceMinutes: number;
  readonly veto: { readonly mode: MergePolicyVetoMode; readonly holdConfidence: number };
}

export interface MergePolicyDaemonSettings {
  readonly intervalSeconds: number;
  readonly budgetSeconds: number;
  readonly settleSeconds: number;
  /** The effective chain-refresh mode: `shadow` or `invalid` (CO8a); never `live`. */
  readonly chainRefresh: 'shadow' | 'invalid';
}

/** What the installation seam hands the adapter; the adapter re-validates it before trusting it. */
export type MergePolicySource =
  | {
      readonly outcome: 'resolved';
      readonly policyRevision: string;
      readonly repositories: readonly MergePolicyRepository[];
      readonly daemon: MergePolicyDaemonSettings;
    }
  | { readonly outcome: 'invalid'; readonly reason: string };

export type MergePolicyAnswer =
  | {
      readonly outcome: 'known';
      readonly policyRevision: string;
      readonly repositories: readonly MergePolicyRepository[];
      readonly daemon: MergePolicyDaemonSettings;
    }
  | {
      readonly outcome: 'unknown';
      readonly reason: 'installation-unreadable' | 'policy-invalid' | 'installation-invalid';
    };

export interface MergePolicyPort {
  readMergePolicy(): Promise<MergePolicyAnswer>;
}
