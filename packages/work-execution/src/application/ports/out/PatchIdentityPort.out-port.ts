// @generated outbound contract scaffold — refined for lane DT7.
/**
 * PatchIdentityPort answers whether a Tier 2 `premerge` receipt may be carried
 * from an old branch head to a new head after a forge branch update. The
 * adapter inspects a bare mirror of the repository (`<stateDir>/mirrors/
 * <repoDigest>.git`); the live checkout is never touched.
 */

/** The carry question for one forge branch update. */
export interface PatchIdentityRequest {
  repositoryDigest: string; // names the mirror under <stateDir>/mirrors
  baseSha: string; // 40-hex; the lane head's merge-base with main
  oldHeadSha: string; // 40-hex; the head that carries the receipt
  newHeadSha: string; // 40-hex; the head after the forge update
  deadlineIso: string;
}

export type PatchIdentityResult =
  | {
      ok: true;
      carry: boolean;
      reason: 'patch-id-unchanged' | 'patch-id-changed' | 'unknown';
      oldPatchId: string | null;
      newPatchId: string | null;
      filesChangedByUpdate: readonly string[];
      overlapWithLaneDiff: readonly string[];
    }
  | { ok: false; reason: 'refused'; code: 'bad-digest' | 'bad-sha' | 'no-mirror' };

export interface PatchIdentityPort {
  lanePatchIdentity(request: PatchIdentityRequest): Promise<PatchIdentityResult>;
}
