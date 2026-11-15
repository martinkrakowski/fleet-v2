// @generated inbound contract scaffold — refined for lane CO11.
/**
 * SweepChainsPort: sweep the branches of one repository's landed chains. Only
 * a chain record whose own `state` is the exact string `landed` is swept: its
 * `chain/<chainName>` branch is deleted through the forge's `delete-branch`
 * kind under the id `chain-sweep/<name>@r<revision>/chain`, and every
 * `linkBranches` member that is that same branch collapses into the one
 * delete. Dry-run is the default; deletion runs only when `mode` is the exact
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
  readonly role: 'chain';
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
