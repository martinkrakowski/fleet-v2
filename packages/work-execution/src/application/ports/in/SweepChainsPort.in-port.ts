// @generated inbound contract scaffold — refined for lane CO11.
/**
 * SweepChainsPort: sweep the branches of one repository's landed chains. Only
 * a chain record whose own `state` is the exact string `landed` is swept, and
 * only once: a record that already carries a sweep mark is skipped. Each
 * recorded `linkBranches` member is deleted first (under the id
 * `chain-sweep/<name>@r<revision>/link/<index>`), then the chain's own
 * `chain/<chainName>` branch (under `chain-sweep/<name>@r<revision>/chain`),
 * through the forge's `delete-branch` kind; duplicates collapse into one
 * delete. A member that is another chain's branch, a protected branch, or
 * secret-shaped refuses the whole sweep. When every branch of a chain is
 * deleted or already absent the record's `sweptAtIso` is written by CAS, so
 * the next tick skips it; a failed write leaves the record for the next
 * retry. Dry-run is the default; deletion runs only when `mode` is the exact
 * string `apply`. One malformed or refused member refuses the whole sweep and
 * deletes nothing; worktrees are left to the reaper. Reasons, keys and chain
 * names only; never a path, a URL or an input value.
 */

export interface SweepChainsCommand {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly projectId: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
  /** Any value but the exact string `apply` (including an omitted one) is a dry-run. */
  readonly mode?: 'dry-run' | 'apply';
}

export interface SweepChainsBranchReport {
  readonly chainName: string;
  /** `chain` for the chain's own branch, `link` for a recorded link branch. */
  readonly role: 'chain' | 'link';
  readonly actionId: string;
  readonly branchName: string;
  readonly outcome: 'would-delete' | 'deleted' | 'already-absent';
  readonly reasonCode: string | null;
}

export interface SweepChainsResult {
  readonly outcome: 'dry-run' | 'completed' | 'refused' | 'incomplete' | 'budget-exhausted';
  readonly reasonCode: string | null;
  /** Set only on a member refusal: the class of the rejected branch, never its value. */
  readonly branchClass: string | null;
  readonly chainName: string | null;
  readonly memberRole: 'chain' | 'link' | null;
  readonly memberIndex: number | null;
  readonly branches: readonly SweepChainsBranchReport[];
}

export interface SweepChainsPort {
  runSweepChains(command: unknown): Promise<SweepChainsResult>;
}
