/**
 * Typed shape of `installation/fleet.json`.
 *
 * The file holds host references and paths to credential files; it never holds
 * credential values. Every section is optional. In the merged result produced
 * by `loadInstallation` the `runner` fields are all optional because
 * environment overrides may create a partial runner section; `parseInstallation`
 * still requires `agent` and `model` whenever the file carries a `runner`
 * section.
 */

/** One seat in the runner fallback chain. */
export interface FallbackSeat {
  readonly agent: string;
  readonly model: string;
  readonly variant?: string;
}

/** The `runner` section. */
export interface RunnerSection {
  readonly agent?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly remotePort?: number;
  readonly host?: string;
  readonly ocmRunBin?: string;
  readonly fallbackChain?: readonly FallbackSeat[];
}

/** The `worktree` section. */
export interface WorktreeSection {
  readonly sshHost: string;
}

/** One named verification procedure. */
export interface VerificationProcedure {
  readonly command: string;
  readonly args?: readonly string[];
}

/** The `verification` section. */
export interface VerificationSection {
  readonly sshHost?: string;
  readonly procedures: Readonly<Record<string, VerificationProcedure>>;
}

/** The `forge` section. */
export interface ForgeSection {
  readonly owner: string;
  readonly repo: string;
}

/** The `reviewer` section. */
export interface ReviewerSection {
  readonly agent: string;
  readonly model: string;
  readonly variant?: string;
}

/** The `waves` section. */
export interface WavesSection {
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly caFile?: string;
  readonly ownerPublicKey?: string;
}

/** The `shelf` section. */
export interface ShelfSection {
  readonly baseUrl: string;
  readonly keyFile: string;
}

/** A parsed installation configuration. */
export interface FleetInstallation {
  readonly schemaVersion: 1;
  readonly runner?: RunnerSection;
  readonly worktree?: WorktreeSection;
  readonly verification?: VerificationSection;
  readonly forge?: ForgeSection;
  readonly reviewer?: ReviewerSection;
  readonly waves?: WavesSection;
  readonly shelf?: ShelfSection;
}
