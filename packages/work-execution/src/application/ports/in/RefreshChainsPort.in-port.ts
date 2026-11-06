// @generated inbound contract scaffold — refined for lane CO8.
/**
 * RefreshChainsPort: run the daemon's chain-refresh job once for one repository
 * within `nowIso` and `deadlineIso`. For each active chain record that is not
 * landing, `main` is merged into `chain/<name>` through the forge's
 * `merge-main-into-branch` kind under the key `chain-refresh/<name>@<main12>`,
 * the intent recorded on the chain record by CAS before the forge call. A
 * repeated key returns the recorded result without a second forge call; `merged`
 * or `up-to-date` clears the record's conflict mark and its attention item, a
 * conflict sets the mark and raises a `chain-refresh-conflict` attention item,
 * and a branch the forge no longer has is left to the sweep. An unreadable
 * record or forge answer is skipped with a reason code, never retried as a
 * merge. Reasons, keys and chain names only; never a path, a URL or an input
 * value.
 */

export interface RefreshChainsCommand {
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly projectId: string;
  readonly nowIso: string;
  readonly deadlineIso: string;
}

export interface RefreshChainsChainReport {
  readonly chainName: string;
  readonly key: string;
  readonly outcome: 'merged' | 'up-to-date' | 'conflict' | 'branch-gone' | 'skipped';
}

export interface RefreshChainsResult {
  readonly outcome: 'completed' | 'skipped' | 'refused' | 'budget-exhausted';
  readonly reasonCode: string | null;
  readonly chains: readonly RefreshChainsChainReport[];
}

export interface RefreshChainsPort {
  runRefreshChains(command: RefreshChainsCommand): Promise<RefreshChainsResult>;
}
