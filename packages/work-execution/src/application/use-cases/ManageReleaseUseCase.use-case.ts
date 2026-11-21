/**
 * ManageReleaseUseCase implements ManageReleasePort (cutover row CO14).
 *
 * Flow: read the request defensively, read the conductor driver lease (an
 * unreadable lease is `lease-unknown`, never "no lease"), read the store,
 * resolve the target, then either report the plan or apply it.
 *
 * An install stages a release: it builds at `<root>/<sha>` and consumes its
 * grant exactly once, but never repoints `current` and never prunes — only a
 * swap or a rollback serves a build. Apply is fenced three ways:
 * - Authority: a recorded owner grant for `release:<action>` at the target sha
 *   is resolved through ActionAuthorizationPort before any write, and consumed
 *   (once, durably) just before the repoint. A missing, mismatched, expired or
 *   consumed grant is `authority-refused`; a grant read that fails or answers
 *   unknown is `authority-unknown`. No free-text value is ever authority. The
 *   grant is bound to the release root it names: a granted result that does
 *   not carry exactly this release's root is `release-grant-root-mismatch`.
 *   A crash after the consumption but before the repoint is recoverable: the
 *   deterministic action id resumes the same grant idempotently, the same
 *   consumption id replays as consumed, and the retry reaches the repoint.
 * - The driver: a live lease refuses before any write; the build then runs
 *   outside any lock, and the repoint runs only while this process holds the
 *   conductor driver lease itself (acquired by CAS just before the repoint,
 *   renewed and re-checked by the store's fence immediately before its one
 *   rename and before each build the prune takes out, with a margin of lease
 *   time left, and released after the prune). A driver that took
 *   the lease meanwhile makes the acquire fail, and nothing is repointed.
 * - Stale trees: the build runs in a staging directory the store creates
 *   exclusively for this run; only that directory is verified and moved to
 *   <root>/<sha>. A failed cleanup leaves a uniquely named directory nothing
 *   will reuse.
 *
 * The build is four reviewed argv steps through the command executor (no
 * shell); the git step is a local read with no hooks and no network, and every
 * step runs on a filtered environment that never hands the operator's full
 * environment (tokens, credentials) to a child. Nothing is echoed from a command, and no result carries a path or a
 * grant id; an unfinished prune is reported, never smoothed over.
 *
 * CO14b fix round 8: two further guarantees. First, a previously-unbound root
 * is bound to this driver's state directory (`bindRootIfUnbound`) only AFTER
 * the grant above has resolved and BEFORE the first write any apply makes
 * (`beginOperation`) — never before authorization, which an unauthorized
 * caller could otherwise exploit to permanently claim a root for this driver.
 * Second, a rollback's target — never named by the request itself, unlike
 * install and swap — is recovered from a crashed attempt's own still-open
 * intent when one exists (`resolveTarget`), rather than being recomputed
 * fresh from `current`, which a crashed attempt's own successful repoint may
 * already have moved out from under that recomputation.
 *
 * CO14b fix round 9: round 8's "already at target" short-circuits (the
 * rollback disjunct in `stillTargets`, and `fencedRepoint`'s skip of
 * `store.repoint`) are now gated on `begun.outcome === 'resumed'`
 * (`OperationContext.isResume`), never available to a freshly `'started'`
 * operation. Luna's finding: a crashed-looking gap is not the only way a
 * fresh listing can already show `current === target` — a SEPARATE,
 * independently and validly authorized rollback request can race in after a
 * first call has repointed to the same target and released its lease, but
 * before that first call's own `completeOperation` has run. If the second
 * call's own `peekOperation` happens only after the first call's intent is
 * gone, the second call begins a brand-new operation (`'started'`) under its
 * own fresh opId — never a resume of the first call's — and must not be
 * allowed to treat the first call's prior work as its own just because the
 * goal happens to already be met. Gating on `isResume` makes a fresh
 * operation that finds `current` already at its rollback target fall through
 * to the ordinary check (`previousBuild(builds, current) === target`), which
 * is false in exactly that race (a build's own predecessor is never itself),
 * so the fresh call is correctly refused `current-moved` rather than
 * falsely reporting `applied` for a repoint it never itself performed.
 *
 * CO14b fix round 10 (Fable's pre-merge pass, two findings): round 8's
 * `resolveTarget` adopted ANY open rollback intent's recorded sha
 * unconditionally. Intents never expire on their own -- only the claim does,
 * after `CLAIM_STALE_MS` -- so a rollback left open by a crash during
 * `prune` (after the repoint itself already landed) poisoned every later
 * rollback forever (finding 1): each one was hijacked to the stale target,
 * failed `stillTargets`'s `current-moved` check against whatever `current`
 * had since become, and refused. Worse, if a LATER, independently and freshly
 * authorized rollback request happened to compute that same stale sha as its
 * own legitimate target (an ordinary coincidence -- `previousBuild` of
 * wherever `current` has moved back to), `peekOperation` found the same
 * stale intent by its sha, adopted the OLD opId as a "resume", and
 * `resolveGrant`'s idempotent-replay path let the ORIGINAL, already-consumed
 * grant authorize this SECOND, logically distinct repoint with no fresh
 * grant at all (finding 2).
 *
 * The fix: every intent now carries `repointed` (`ReleaseStorePort.
 * markRepointed`, `ReleaseOpenOperationPeek.repointed`), set once, by
 * `fencedRepoint`, immediately after its own repoint lands or is confirmed
 * already there -- before `prune` or `completeOperation`. `resolveTarget`
 * adopts an open intent whose `repointed` is still `false` exactly as before
 * (safe already: the ordinary `current !== plannedCurrent` check downstream
 * still gates it). An intent whose `repointed` is `true` is adopted only
 * when `current`, read fresh right now, still equals its own recorded sha;
 * otherwise the intent is stale -- it is retired on the spot (never merely
 * skipped, so it can never be rediscovered) and the target is computed
 * fresh, exactly as if no intent were open.
 *
 * That reactive check alone closes finding 1 and finding 2's literal
 * scenario, because by the time a later request's own fresh `current` is
 * read, it has already diverged from the stale sha. It does not by itself
 * close the one residual case Fable flagged without resolving: `current`
 * later, coincidentally, cycling back to EXACTLY that stale sha through
 * entirely unrelated, separately authorized repoints (not the crashed
 * attempt's own work) -- at that instant the reactive check alone cannot
 * tell "still genuinely mid-flight" from "coincidentally revisited", and
 * would wrongly adopt a no-op target instead of the correct fresh one.
 * `fencedRepoint` therefore also retires any OTHER open rollback intent
 * (`retireOtherStaleRollbackIntent`) the instant its OWN repoint confirms
 * `current` is at ITS target: `current` cannot be at two shas at once, and
 * only this process can repoint while holding the driver lease, so any
 * other open rollback intent for a different sha is proven stale right
 * then, not merely apparently so. Retiring it there -- the first moment it
 * is disproven, regardless of what `current` does afterward -- means it can
 * never survive to be coincidentally rediscovered later. The two mechanisms
 * are complementary: the reactive check handles a request that arrives while
 * `current` has already diverged; the proactive one guarantees a diverged
 * intent never lingers to be revisited.
 *
 * CO14b fix round 11 (Luna, three findings): round 10's own implementation
 * of that design had gaps.
 *
 * Finding 1: `resolveTarget`'s reactive check compared `open.repointed`'s
 * sha against `current` -- but that `current` was the STALE snapshot `run()`
 * captured before `resolveTarget` ever ran, never a fresh read taken at the
 * point of the retire decision itself. Race: call X marks its own intent
 * `repointed: true` and its repoint genuinely lands AFTER call Y's `run()`
 * already captured Y's (now-stale) `current` but BEFORE Y's `resolveTarget`
 * runs its retire check. Y, judging X's live, just-succeeded intent against
 * its own older snapshot, could wrongly conclude it is stale and retire a
 * recovery intent X might still need. The fix: once an intent's own
 * `repointed` is `true`, the retire decision re-reads `current` FRESH (a new
 * `store.list` call, the same "revalidate under the lease" idiom
 * `fencedRepoint` already uses before its own repoint) rather than reusing
 * `run()`'s earlier snapshot; the recomputed fallback target is likewise
 * read fresh, never from the stale snapshot.
 *
 * Finding 2: `fencedRepoint`'s proactive cleanup (`retireOtherStaleRollbackIntent`)
 * retired any OTHER open rollback intent whose sha merely differed from this
 * call's own target -- with no check of that OTHER intent's own `repointed`
 * flag. A rollback-to-B intent that is still `repointed: false` (it has not
 * reached its own repoint step yet) is not proven stale by anything: it may
 * be a different, legitimate, still-pending operation with every right to
 * exist. The fix: the proactive cleanup retires another open intent only
 * when that intent's OWN `repointed` is `true` -- proven stale (current
 * cannot be at two shas at once, and only this process can repoint while
 * holding the lease) -- never merely because its sha differs. The two
 * findings' fixes are complementary, not alternatives: an intent is retired
 * only when it is BOTH `repointed: true` AND, per a fresh read, no longer
 * matching current reality.
 *
 * Finding 3 (a repeat of the round-4 lesson): the reactive retire-on-stale
 * logic could reach `cancelOperation` -- a store write -- even for a
 * plan-only request (`request.apply === false`), violating this file's own
 * documented contract that a plan prints and writes nothing. The fix: the
 * write itself is gated on `request.apply === true`; a plan-only request
 * that discovers a stale intent still computes and reports the correct,
 * fresh target (so the plan stays accurate), it simply never performs the
 * retiring write -- the next genuine apply to reach the same decision
 * retires it for real. `fencedRepoint`'s own proactive cleanup needs no
 * equivalent gate: it runs only from `applyOperation`, itself reachable only
 * from `apply()`, which `run()` never calls for a plan-only request.
 *
 * CO14b fix round 12 (Luna, a consistency finding): round 11's own fresh
 * re-read inside `resolveTarget` fixed what `target` the stale-intent branch
 * resolves to, but `run()` still built the rest of a plan-only result --
 * `current` and `kept` (and, through `kept`, `wouldPrune`) -- from the
 * listing it captured itself, before `resolveTarget` ever ran. When
 * `resolveTarget` had re-read fresh, that outer snapshot could already be
 * stale: the plan then reported an old `current`/`kept` alongside a `target`
 * that was actually resolved against newer reality -- an internally
 * inconsistent picture, never a mix a caller should see. The fix:
 * `resolveTarget` now also returns the `builds`/`current` it actually used
 * to compute `target` -- its own fresh re-read when it performed one, or
 * simply the listing `run()` passed in when it did not need to -- and
 * `run()` builds `kept` and the plan's `current`/`wouldPrune` from that
 * returned listing, never its own separately-held copy. The apply path needs
 * no equivalent change: `fencedRepoint` already revalidates everything it
 * needs under the lease from its own fresh read, and the one place the outer
 * listing still reaches `apply()` (`alreadyBuilt`, computed from `kept`) only
 * ever matters for `install`, whose target is always the request's own named
 * sha -- a case `resolveTarget` never re-reads for, so the outer and the
 * resolved listing are always identical there.
 *
 * CO14b fix round 16 (#4b-1 and #4c): two store-consistency guarantees.
 * First (#4b-1), `resolveTarget` is now strictly read-only: it never calls
 * `cancelOperation`, not even for an apply. A rollback intent it proves
 * stale is REPORTED (`staleOpen`) and retired by `apply()` only after
 * `resolveGrant` and `bindRootIfUnbound` have both succeeded -- so a
 * concurrent apply behind a live driver lease, or an unauthorized one, can
 * never cancel a live marked intent and its claim before the lease check
 * or the authorization. Second (#4c), a marked (`repointed: true`) intent
 * is adopted only when the store's own marker of which operation last
 * wrote `current` (`readLastCurrentOp`, written by `store.repoint` ahead
 * of the fence and the rename) still names exactly that operation and
 * sha: an unrelated swap landing later on the same sha can no longer make
 * a crashed rollback's spent intent look live, and a no-op `applied`
 * replaying its spent grant is impossible. A missing or unreadable marker
 * is fail-closed: unreadable, then refused `store-unreadable`.
 */

import { containsSecretShape } from '@fleet/shared';

import type { ReleaseActionKind } from '../../domain/coordination-keys.js';
import { isLeaseLapsed, type ConductorDriverLeaseRecord } from '../../domain/lane-run-lease.js';
import { snapshotPlainDataRecord } from '../../domain/plain-record-reads.js';
import type {
  ManageReleaseApplied,
  ManageReleasePlan,
  ManageReleasePort,
  ManageReleaseRefusal,
  ManageReleaseRequest,
  ManageReleaseResult,
  ReleaseAction,
} from '../ports/in/ManageReleasePort.in-port.js';
import type { ActionAuthorizationPort } from '../ports/out/ActionAuthorizationPort.out-port.js';
import type { CommandExecutorPort, CommandRunOptions } from '../ports/out/CommandExecutorPort.out-port.js';
import type { ConductorDriverLeasePort } from '../ports/out/ConductorDriverLeasePort.out-port.js';
import type {
  ReleaseBuildRecord,
  ReleaseDriverBinding,
  ReleaseLastCurrentOpResult,
  ReleaseOpenOperationPeek,
  ReleaseOperationBegin,
  ReleaseStorePort,
  ReleaseStorePruneResult,
} from '../ports/out/ReleaseStorePort.out-port.js';

export interface ManageReleaseDependencies {
  readonly store: ReleaseStorePort;
  readonly lease: ConductorDriverLeasePort;
  /** Resolves and consumes the recorded owner grant for `release:<action>` at the target sha. */
  readonly authorization: ActionAuthorizationPort;
  readonly executor: CommandExecutorPort;
  readonly nowIso: () => string;
  /** The operator environment the composition root supplies; only a filtered
   *  allowlist of it reaches the git child, never the operator's full set. */
  readonly env: () => Record<string, string | undefined>;
  /**
   * CO14b fix round 8: the state directory of the driver this use case acts
   * for, used only to bind a previously-unbound root to it (never to read a
   * lease directly: the lease port the caller supplies is already bound to
   * this same directory). Relocated here from `releaseHandler` (apps/cli/src/
   * release.ts), which used to perform the bind itself before authorization
   * was ever checked -- a security gap: see `bindRootIfUnbound`.
   */
  readonly stateDir: string;
}

const REQUEST_KEYS = ['action', 'root', 'sha', 'source', 'keep', 'apply', 'projectId'] as const;
const ACTIONS: readonly ReleaseAction[] = ['install', 'swap', 'rollback'];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PATH_BYTES = 4096;
const MAX_PROJECT_ID_BYTES = 256;
const MIN_KEEP = 2;
const MAX_KEEP = 64;
const GIT_STEP_TIMEOUT_MS = 300_000;
const GIT_STEP_MAX_BUFFER_BYTES = 1_048_576;
const YARN_STEP_TIMEOUT_MS = 900_000;
const YARN_STEP_MAX_BUFFER_BYTES = 4_194_304;
/** How long the release holds the driver lease around the repoint; well inside the lease maximum. */
const REPOINT_FENCE_MS = 120_000;
/** The lease time that must remain when the fence passes; the rename after it is one local syscall. */
const REPOINT_MARGIN_MS = 60_000;
/** The only operator variables the git child may see; everything else (tokens, credentials) stays out. */
/**
 * The only operator variables any build child (git, tar, yarn) may see: none
 * of them a credential, a token or a home directory. HOME is never passed:
 * every child gets this run's own empty home from the store, so neither an
 * operator dotfile (`.npmrc`, `.yarnrc.yml`, `.gitconfig`, `.netrc`) nor an
 * operator cache reaches the commit's own install and build scripts.
 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'YARN_NM_MODE',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
];

type ValidRequest = ManageReleaseRequest;

interface HeldLease {
  readonly holderId: string;
  readonly fence: number;
  /** Moves forward each time the fence renews the lease. */
  leaseUntilIso: string;
}

export class ManageReleaseUseCase implements ManageReleasePort {
  constructor(private readonly deps: ManageReleaseDependencies) {}

  async manageRelease(request: ManageReleaseRequest): Promise<ManageReleaseResult> {
    try {
      return await this.run(request);
    } catch {
      return refuse('failed');
    }
  }

  private async run(raw: unknown): Promise<ManageReleaseResult> {
    const request = readRequest(raw);
    if (request === null) {
      return refuse('invalid-request');
    }
    if (request.apply && request.projectId === null) {
      return refuse('authority-required');
    }
    const live = await this.leaseIsLive();
    if (live === null) {
      return refuse('lease-unknown');
    }
    const listing = await this.deps.store.list({ root: request.root });
    if (listing.outcome !== 'read') {
      return refuse('store-unreadable');
    }
    const resolved = await this.resolveTarget(request, listing.builds, listing.current);
    if (resolved.outcome === 'unreadable') {
      return refuse('store-unreadable');
    }
    // CO14b fix round 12: `resolved.builds`/`resolved.current` are whichever
    // listing `resolveTarget` actually used to compute `target` -- its own
    // fresh re-read when it performed one (the stale-intent branch above),
    // or simply `listing` unchanged when it did not need to. `kept` and the
    // plan below are built from THAT listing, never from `listing` directly,
    // so a plan never mixes an old `current`/`kept` with a `target` already
    // resolved against newer reality.
    const { target, previous, builds, current } = resolved;
    const kept = builds.map((build) => build.sha);
    if (target === null || (request.action === 'swap' && !kept.includes(target))) {
      return refuse('not-found');
    }
    const alreadyBuilt = kept.includes(target);
    if (!request.apply) {
      const plan: ManageReleasePlan = {
        outcome: 'planned',
        action: request.action,
        target,
        current,
        previous,
        kept,
        wouldPrune: this.wouldPrune(builds, target, alreadyBuilt, request.keep),
        lease: live ? 'live' : 'free',
      };
      return plan;
    }
    if (live) {
      return refuse('driver-lease-live');
    }
    // The apply path is unaffected by which listing resolved `target`:
    // `fencedRepoint` revalidates everything it needs itself, under the
    // lease, from its own fresh read; the one remaining use of a listing
    // here, `alreadyBuilt`, only matters for `install`, whose target
    // (the request's own named sha) `resolveTarget` never re-reads for, so
    // `listing.current` is passed exactly as before.
    return this.apply(request, target, listing.current, alreadyBuilt, resolved.staleOpen);
  }

  /**
   * The apply path: grant, build when needed, then act. An install creates the
   * build and consumes its grant but never repoints `current` (CO14 follow-up:
   * install stages a release, a swap or a rollback is what serves it), so it
   * runs no repoint and no prune and reports the unmoved current. A swap or a
   * rollback goes through the fenced repoint.
   */
  private async apply(
    request: ValidRequest,
    target: string,
    plannedCurrent: string | null,
    alreadyBuilt: boolean,
    staleOpen?: { readonly opId: string; readonly sha: string },
  ): Promise<ManageReleaseResult> {
    // One operation per apply: a durable intent with a unique id is recorded
    // before the grant is touched, and its result after the irreversible step.
    // The grant authorizes exactly this operation id; only an intent that has
    // no recorded result may be resumed, and only under its own id.
    //
    // CO14b #4b-1: a stale intent `resolveTarget` declined to adopt is NOT
    // resumed even when `peekOperation` finds it by this call's own target:
    // its opId would otherwise replay the spent grant of the crashed attempt.
    // This call generates a fresh operation id instead, and the stale intent
    // is retired below -- only after authorization and the root bind have
    // both succeeded, so an unauthorized or refused request can never cancel
    // an intent (CO14b #4b-1: no pre-auth `cancelOperation`).
    let opId: string;
    try {
      const open = await this.deps.store.peekOperation({ root: request.root, action: request.action, sha: target });
      if (open.outcome === 'unreadable') {
        return refuse('store-unreadable');
      }
      opId =
        open.outcome === 'open' && !(staleOpen !== undefined && open.opId === staleOpen.opId)
          ? open.opId
          : this.deps.store.newOperationId();
    } catch {
      return refuse('store-unreadable');
    }
    // Read-only until the grant resolves: a refused authority writes nothing.
    const grant = await this.resolveGrant(request, target, opId);
    if (typeof grant !== 'string') {
      return refuse(grant.refusal);
    }
    // CO14b fix round 8 (finding 1): bind a previously-unbound root to this
    // driver's state directory only now -- AFTER authorization is confirmed,
    // BEFORE `beginOperation` (the first write any apply makes). Relocated
    // from `releaseHandler` (apps/cli/src/release.ts), which used to do this
    // write before any authorization check at all: an unauthorized caller
    // (wrong or missing project, no matching grant) could permanently claim
    // an unbound root for itself before ever being refused, making the root
    // unusable for whichever driver should actually have served it. Moving
    // the bind here keeps the original round-3 property (the bind still
    // happens before any mutating action, closing the concurrent-driver
    // race) while closing that gap: an unauthorized request never reaches
    // this line.
    const bindRefusal = await this.bindRootIfUnbound(request.root);
    if (bindRefusal !== null) {
      return refuse(bindRefusal);
    }
    // CO14b #4b-1: the deferred retirement of a stale rollback intent runs
    // only here -- after `resolveGrant` and `bindRootIfUnbound` have both
    // succeeded, so an unauthorized request never cancels anyone's intent,
    // and after the live-lease refusal in `run()` (which precedes `apply`),
    // so a concurrent apply can no longer cancel a live marked intent and
    // its claim before the lease check. A retire that fails refuses before
    // `beginOperation`: no second intent is ever opened.
    if (staleOpen !== undefined && !(await this.retireRollbackIntent(request.root, staleOpen.opId, staleOpen.sha))) {
      return refuse('store-unreadable');
    }
    let begun: ReleaseOperationBegin;
    try {
      begun = await this.deps.store.beginOperation({
        root: request.root,
        action: request.action,
        sha: target,
        opId,
        nowIso: this.deps.nowIso(),
      });
    } catch {
      return refuse('store-unreadable');
    }
    if (begun.outcome === 'busy') {
      return refuse('release-in-progress');
    }
    if (begun.outcome === 'unreadable') {
      return refuse('store-unreadable');
    }
    const operation: OperationContext = {
      opId: begun.opId,
      consumed: false,
      // CO14b fix round 9: only a genuine resume of a pre-existing intent may
      // later treat "current already at target" as its own prior work.
      isResume: begun.outcome === 'resumed',
    };
    let result: ManageReleaseResult;
    try {
      result = await this.applyOperation(request, target, plannedCurrent, alreadyBuilt, operation, grant);
    } catch {
      result = refuse('failed');
    }
    const ref = { root: request.root, action: request.action, sha: target, opId: operation.opId };
    try {
      if (result.outcome === 'applied') {
        await this.deps.store.completeOperation(ref);
      } else if (!operation.consumed && begun.outcome === 'started') {
        await this.deps.store.cancelOperation(ref);
      } else {
        // The grant may be spent: the intent stays so the same operation can resume.
        await this.deps.store.releaseOperation(ref);
      }
    } catch {
      // The claim goes stale by itself; the result stands.
    }
    return result;
  }

  private async applyOperation(
    request: ValidRequest,
    target: string,
    plannedCurrent: string | null,
    alreadyBuilt: boolean,
    operation: OperationContext,
    grant: string,
  ): Promise<ManageReleaseResult> {
    let rebuilt = false;
    if (request.action === 'install') {
      // CO14 round 5: the grant is consumed BEFORE anything is built or placed;
      // a grant that cannot be consumed builds nothing. A build that then
      // fails leaves no installed build and reports the grant as spent.
      operation.consumed = true;
      const consumed = await this.consumeGrant(request, target, grant, operation.opId);
      if (consumed !== null) {
        return refuse(consumed);
      }
      if (!alreadyBuilt) {
        const built = await this.build(request, target);
        if (built !== null) {
          return refuse('build-failed-grant-spent');
        }
        rebuilt = true;
      }
      const fresh = await this.deps.store.list({ root: request.root });
      if (fresh.outcome !== 'read') {
        return refuse('store-unreadable');
      }
      return {
        outcome: 'applied',
        action: request.action,
        target,
        current: fresh.current,
        kept: fresh.builds.map((build) => build.sha),
        pruned: [],
        pruneOutcome: 'pruned',
        rebuilt,
      };
    }
    const repointed = await this.fencedRepoint(request, target, plannedCurrent, grant, operation);
    if ('refusal' in repointed) {
      return refuse(repointed.refusal);
    }
    const { pruned, kept } = repointed;
    // An unfinished prune still reports what it did remove, so `kept` never lists a deleted build.
    const removed = pruned.removed ?? [];
    const applied: ManageReleaseApplied = {
      outcome: 'applied',
      action: request.action,
      target,
      current: target,
      kept: kept.filter((sha) => !removed.includes(sha)),
      pruned: [...removed],
      pruneOutcome: pruned.outcome === 'pruned' ? 'pruned' : 'unreadable',
      rebuilt,
    };
    return applied;
  }

  /** true when a driver holds an unexpired lease; null when the lease cannot be read. */
  private async leaseIsLive(): Promise<boolean | null> {
    try {
      const lease = await this.deps.lease.read();
      return lease !== null && !isLeaseLapsed(lease, this.deps.nowIso());
    } catch {
      return null;
    }
  }

  /** The grant id of an applicable recorded owner grant, or the refusal. Writes nothing. */
  private async resolveGrant(
    request: ValidRequest,
    target: string,
    opId: string,
  ): Promise<string | { readonly refusal: ManageReleaseRefusal }> {
    const coordinates = grantCoordinates(request, target, opId);
    try {
      const resolved = await this.deps.authorization.resolveActionAuthorization({
        actionId: coordinates.actionId,
        projectId: request.projectId as string,
        workOrderId: coordinates.actionId,
        attemptId: coordinates.actionId,
        actionKind: coordinates.actionKind,
        expectedHeadSha: target,
        policyRevision: coordinates.actionKind,
        releaseRoot: request.root,
      });
      if (resolved.outcome === 'granted') {
        // The grant is bound to the root it names (CO14 follow-up): a granted
        // release result that does not carry exactly this release's root never
        // authorizes it — a missing root is a mismatch too, never a match.
        if (resolved.releaseRoot !== request.root) {
          return { refusal: 'release-grant-root-mismatch' };
        }
        return typeof resolved.authorizationGrantId === 'string' && resolved.authorizationGrantId.trim() !== ''
          ? resolved.authorizationGrantId
          : { refusal: 'authority-unknown' };
      }
      if (resolved.outcome === 'blocked' && resolved.reason === 'release-grant-root-mismatch') {
        return { refusal: 'release-grant-root-mismatch' };
      }
      return { refusal: resolved.outcome === 'blocked' ? 'authority-refused' : 'authority-unknown' };
    } catch {
      return { refusal: 'authority-unknown' };
    }
  }

  /**
   * CO14b fix round 8 (finding 1): bind this root to `deps.stateDir` when it
   * has none yet (first binding wins); confirm a mismatch when it is already
   * bound elsewhere. Called only from `apply()`, only after authorization has
   * already granted -- see the call site's comment. Writes at most once per
   * previously-unbound root.
   */
  private async bindRootIfUnbound(root: string): Promise<ManageReleaseRefusal | null> {
    let binding: ReleaseDriverBinding;
    try {
      binding = await this.deps.store.readDriverBinding({ root });
    } catch {
      return 'release-root-state-dir-unknown';
    }
    if (binding.outcome === 'unreadable') {
      return 'release-root-state-dir-unknown';
    }
    if (binding.outcome === 'bound') {
      return binding.stateDir === this.deps.stateDir ? null : 'release-root-state-dir-unknown';
    }
    try {
      const bound = await this.deps.store.bindDriver({ root, stateDir: this.deps.stateDir });
      return bound.outcome === 'bound' && bound.stateDir === this.deps.stateDir
        ? null
        : 'release-root-state-dir-unknown';
    } catch {
      return 'release-root-state-dir-unknown';
    }
  }

  /**
   * CO14b fix round 8 (finding 2): the target and the informational
   * `previous` field, for a plan or an apply alike. Install and swap always
   * target the request's own named sha, never ambiguous. Rollback is
   * different: its target is never named by the request, so it is normally
   * `previousBuild(builds, current)` -- but when a crashed rollback's own
   * intent is still open, that intent's recorded sha is reused instead of
   * being recomputed, because a fresh `previousBuild` call can no longer
   * reproduce it once that crashed attempt's own (possibly successful)
   * repoint has already moved `current` out from under it. A plan reports
   * this recovered target too, so it reflects what a resume would really do,
   * never a value a resume could never actually use.
   *
   * CO14b fix round 12: also returns `builds`/`current` -- whichever listing
   * this call actually used to compute `target`, its own fresh re-read when
   * the stale-intent branch below performed one, or simply the caller's own
   * `builds`/`current` echoed back unchanged otherwise. The caller builds
   * everything else it reports from THIS returned listing, never a
   * separately-held copy of its own that may already be stale by the time
   * this function returns.
   */
  private async resolveTarget(
    request: ValidRequest,
    builds: readonly ReleaseBuildRecord[],
    current: string | null,
  ): Promise<
    | {
        readonly outcome: 'resolved';
        readonly target: string | null;
        readonly previous: string | null;
        readonly builds: readonly ReleaseBuildRecord[];
        readonly current: string | null;
        /**
         * CO14b #4b-1: a rollback intent this call proved NOT adoptable. It
         * is only REPORTED here -- this function is read-only and performs
         * no store write of any kind, even for an apply -- and `apply()`
         * retires it after `resolveGrant` and `bindRootIfUnbound` have both
         * succeeded, so an unauthorized or lease-refused request can never
         * cancel an intent.
         */
        readonly staleOpen?: { readonly opId: string; readonly sha: string };
      }
    | { readonly outcome: 'unreadable' }
  > {
    if (request.action !== 'rollback') {
      return { outcome: 'resolved', target: request.sha, previous: previousBuild(builds, current), builds, current };
    }
    let open: ReleaseOpenOperationPeek;
    try {
      open = await this.deps.store.peekAnyOpenOperation({ root: request.root, action: 'rollback' });
    } catch {
      return { outcome: 'unreadable' };
    }
    if (open.outcome === 'unreadable') {
      return { outcome: 'unreadable' };
    }
    if (open.outcome === 'open') {
      // CO14b fix round 11 (finding 1): `open.repointed` alone does not
      // settle whether this intent is still live -- it may ALREADY be
      // stale right now even though the `current` this function was
      // handed (captured by `run()`, before this call) is too old to show
      // it: another call's repoint can land between that snapshot and this
      // decision. Re-read `current` FRESH, under no lease, the same
      // "revalidate" idiom `fencedRepoint` uses before its own repoint, so
      // the retire decision is never made against a snapshot older than
      // the intent's own repoint.
      const fresh = await this.deps.store.list({ root: request.root });
      if (fresh.outcome !== 'read') {
        return { outcome: 'unreadable' };
      }
      // CO14b fix round 14 (finding 1): an intent that never reached its
      // repoint (`repointed: false`) is adopted only while it still describes
      // the live state: `current` is already at its sha, or its sha is
      // exactly what a rollback from the FRESH `current` would target. An
      // authorized swap that moved `current` on since the intent began makes
      // it stale for good (an unmarked intent is skipped by the swap's own
      // cleanup), so it is retired below and the target recomputed.
      //
      // CO14b #4c: a marked (`repointed: true`) intent is adopted only when
      // the store-level `current` operation marker names exactly this
      // operation -- `readLastCurrentOp` answers read with `opId ===
      // open.opId && sha === open.sha` -- AND the fresh `current` still
      // equals its sha. `current === open.sha` alone is not enough: a
      // crashed rollback's marker-less intent could be adopted after an
      // unrelated, separately authorized swap later lands on the same sha,
      // reporting a no-op `applied` that replays the spent grant. A missing
      // optional `readLastCurrentOp` port method is fail-closed: unreadable.
      let adoptable: boolean;
      if (open.repointed) {
        if (this.deps.store.readLastCurrentOp === undefined) {
          return { outcome: 'unreadable' };
        }
        let lastOp: ReleaseLastCurrentOpResult;
        try {
          lastOp = await this.deps.store.readLastCurrentOp({ root: request.root });
        } catch {
          return { outcome: 'unreadable' };
        }
        if (lastOp.outcome === 'unreadable') {
          return { outcome: 'unreadable' };
        }
        adoptable =
          fresh.current === open.sha &&
          lastOp.outcome === 'read' &&
          lastOp.opId === open.opId &&
          lastOp.sha === open.sha;
      } else {
        adoptable = fresh.current === open.sha || previousBuild(fresh.builds, fresh.current) === open.sha;
      }
      if (adoptable) {
        // CO14b fix round 12: this was decided against `fresh`, not the
        // caller's own listing, so `fresh` is the listing returned too.
        return { outcome: 'resolved', target: open.sha, previous: open.sha, builds: fresh.builds, current: fresh.current };
      }
      // Proven stale under the fresh read: do NOT adopt it. The retirement
      // itself is deferred to `apply()` (see `staleOpen` above and the
      // retire call there), so this function stays read-only -- a plan-only
      // request writes nothing (the round-4 and round-11 finding-3
      // lessons) and an apply retires only after authorization and the
      // root bind have succeeded (#4b-1). A failed retire refuses there,
      // before `beginOperation`, so no second intent is ever opened
      // (the round-14 finding-3 lesson).
      const previous = previousBuild(fresh.builds, fresh.current);
      // CO14b fix round 12: `target` is resolved against `fresh`, so the
      // listing returned is `fresh` too -- never the caller's older
      // `builds`/`current`, which this branch has just proven stale.
      return {
        outcome: 'resolved',
        target: previous,
        previous,
        builds: fresh.builds,
        current: fresh.current,
        staleOpen: { opId: open.opId, sha: open.sha },
      };
    }
    const previous = previousBuild(builds, current);
    return { outcome: 'resolved', target: previous, previous, builds, current };
  }

  /**
   * Repoint `current` and prune only while this process holds the conductor
   * driver lease: re-read it, acquire it by CAS, consume the grant, repoint
   * behind the store's fence, prune, release. Another release needs the same
   * lease to repoint, so no repoint can land between this prune's snapshot of
   * `current` and its removals. The prune result when repointed; the refusal
   * otherwise.
   */
  private async fencedRepoint(
    request: ValidRequest,
    target: string,
    plannedCurrent: string | null,
    grantId: string,
    operation: OperationContext,
  ): Promise<
    | { readonly refusal: ManageReleaseRefusal }
    | { readonly pruned: ReleaseStorePruneResult; readonly kept: readonly string[] }
  > {
    const held = await this.acquireLease(request, target);
    if (typeof held === 'string') {
      return { refusal: held };
    }
    try {
      // Revalidate under the lease: another release may have repointed while
      // this one resolved its grant or built, so the target must still be what
      // the plan named against the same `current`.
      const fresh = await this.deps.store.list({ root: request.root });
      if (fresh.outcome !== 'read') {
        return { refusal: 'store-unreadable' };
      }
      if (!stillTargets(request.action, fresh.builds, fresh.current, plannedCurrent, target, operation.isResume)) {
        return { refusal: 'current-moved' };
      }
      // A resumed operation (the same opId, read back through beginOperation's
      // EEXIST path) re-plans from whatever `fresh` shows right now. When that
      // already sits at `target`, this exact opId's own earlier attempt almost
      // certainly repointed it before crashing short of `completeOperation`:
      // the repoint below is skipped, never the consumption (already correctly
      // idempotent by design) or the prune (a crash between a successful
      // repoint and a successful prune means the prune never ran the first
      // time either, and it is exactly as idempotent against a fresh listing
      // as repoint is). `stillTargets` needs no change for this: it already
      // answers true for an already-achieved state, which is a valid plan.
      //
      // CO14b fix round 9: this skip is gated on `operation.isResume` too.
      // `fresh.current === target` alone is not evidence that THIS call's own
      // operation did that work: a separate, freshly `'started'` operation can
      // legitimately observe it, for instance when a different, independently
      // authorized request already drove `current` there and released its
      // lease before this call's own `peekOperation` ran. Only a genuine
      // resume (`begun.outcome === 'resumed'`, the same opId read back) may
      // treat an already-achieved target as its own prior work; a fresh
      // operation still falls through to `store.repoint`, which is a no-op
      // write when `current` already matches (repoint is idempotent).
      const alreadyAtTarget = operation.isResume && fresh.current === target;
      const kept = fresh.builds.map((build) => build.sha);
      // Only this process holds the lease, so no repoint has a temp link in
      // flight: an orphan is a crashed run's. The pass is fenced under the
      // same lease and is best effort, and runs unconditionally: it is cleanup
      // independent of this run's history, never part of the plan it executes.
      try {
        await this.deps.store.removeOrphanCurrentTemps({ root: request.root, fence: () => this.stillHolds(held) });
      } catch {
        // An unknown root here never blocks the repoint, which re-checks everything itself.
      }
      operation.consumed = true;
      const consumed = await this.consumeGrant(request, target, grantId, operation.opId);
      if (consumed !== null) {
        return { refusal: consumed };
      }
      if (!alreadyAtTarget) {
        // CO14b fix round 14 (finding 2): write-ahead. The intent is marked
        // BEFORE the rename, so a process that dies anywhere after it leaves
        // an intent that says the repoint may have landed. A later adopter
        // then needs `current` to equal the intent's sha, else retires it
        // (fail-closed: a fresh plan, never a replay of the spent grant). A
        // mark that cannot be written refuses before the rename; the grant is
        // already consumed, so the intent stays for the same operation to
        // resume.
        if (request.action === 'rollback') {
          const marked = await this.deps.store.markRepointed({
            root: request.root,
            action: 'rollback',
            sha: target,
            opId: operation.opId,
          });
          if (marked.outcome !== 'ok') {
            return { refusal: 'store-unreadable' };
          }
        }
        const repointed = await this.deps.store.repoint({
          root: request.root,
          sha: target,
          // CO14b #4c: record this operation as the one that last wrote
          // `current`, so a later rollback adopts a marked intent only when
          // the marker still names exactly this operation.
          opId: operation.opId,
          fence: () => this.stillHolds(held),
        });
        if (repointed.outcome !== 'ok') {
          return { refusal: repointRefusal(repointed.outcome) };
        }
      }
      // CO14b fix round 10: `current` is now confirmed to be at `target`,
      // under this same lease -- either this call's own repoint just landed,
      // or (a genuine resume) it was already there. Mark THIS rollback's own
      // intent so a later, unrelated call can tell "the mutation already
      // ran" from "it never did" (`resolveTarget`); and retire any OTHER
      // open rollback intent, proven stale right now (current cannot be at
      // two shas at once, and only this process can repoint while holding
      // the driver lease, so nothing else can be concurrently mid-repoint to
      // keep that other intent genuinely live). Both are best effort: a
      // failure here never blocks this call's own result, and leaves the
      // next repoint, or `resolveTarget`'s own reactive check, to catch it.
      if (request.action === 'rollback') {
        await this.markRepointedBestEffort(request.root, operation.opId, target);
      }
      await this.retireOtherStaleRollbackIntent(request.root, operation.opId);
      // The repoint stands from here on (this attempt's own, or the crashed
      // one this call resumed): a prune that throws is an unfinished prune of
      // an applied release, never a refusal a caller would retry.
      try {
        return {
          kept,
          pruned: await this.deps.store.prune({
            root: request.root,
            keep: request.keep,
            fence: () => this.stillHolds(held),
          }),
        };
      } catch {
        return { kept, pruned: { outcome: 'unreadable' } };
      }
    } finally {
      await this.releaseLease(held);
    }
  }

  /**
   * CO14b fix round 10: mark this rollback's own intent repointed, once its
   * mutation is confirmed landed. Best effort -- a failure here is corrected
   * next time either `resolveTarget`'s own check runs (a marked intent is
   * adopted only while `current` equals its sha; an unmarked one only while
   * it still describes the live state, per round 14) or this same mark is
   * attempted again on a later call.
   */
  private async markRepointedBestEffort(root: string, opId: string, sha: string): Promise<void> {
    try {
      await this.deps.store.markRepointed({ root, action: 'rollback', sha, opId });
    } catch {
      // Best effort; see the comment above.
    }
  }

  /**
   * CO14b fix round 10 (finding 2's residual case), round 15: retire any
   * OTHER open, marked rollback intent once this call has confirmed `current`
   * is at its target. "Other" is decided by opId, never by sha: a stale
   * marked intent whose sha equals this call's target (a swap landing on the
   * very build an abandoned rollback aimed at) would otherwise survive and be
   * adopted by a later rollback through the `repointed && current === sha`
   * branch, replaying its spent grant as a silent no-op. This call's own
   * intent (same opId) is never touched. Best effort, deliberately: the
   * repoint has already landed, so a refusal here would misreport an applied
   * release. An unreadable peek or failing retirement leaves the intent open
   * (the residual risk: a later rollback may adopt it; no second intent is
   * ever opened, so the round-14 two-open-intents case cannot arise here).
   */
  private async retireOtherStaleRollbackIntent(root: string, ownOpId: string): Promise<void> {
    try {
      const open = await this.deps.store.peekAnyOpenOperation({ root, action: 'rollback' });
      // Round 11 (finding 2): an intent whose own `repointed` is still `false`
      // has not reached its repoint and may be a legitimate pending operation;
      // only a marked one is provably contradicted by `current` being
      // confirmed here.
      if (open.outcome === 'open' && open.opId !== ownOpId && open.repointed) {
        await this.retireRollbackIntent(root, open.opId, open.sha);
      }
    } catch {
      // Best effort; see the comment above.
    }
  }

  /**
   * Cancel a rollback intent proven stale, releasing its claim too. True when
   * the intent is gone (cancelled, or already absent); false when the store
   * could not retire it. Callers that must not leave a second intent behind
   * (`resolveTarget`) refuse on false; the best-effort caller ignores it.
   */
  private async retireRollbackIntent(root: string, opId: string, sha: string): Promise<boolean> {
    try {
      const cancelled = await this.deps.store.cancelOperation({ root, action: 'rollback', sha, opId });
      return cancelled.outcome === 'ok' || cancelled.outcome === 'not-found';
    } catch {
      return false;
    }
  }

  /**
   * The fence the store awaits right before its rename (repoint) and before
   * each build it takes out (prune): renew this process's lease for another
   * fence window, then require, on a clock read after the renew returned, at
   * least REPOINT_MARGIN_MS left. A lease this process no longer holds cannot
   * be renewed, so a driver that took it over fails the fence.
   */
  private async stillHolds(held: HeldLease): Promise<boolean> {
    const nowIso = this.deps.nowIso();
    const renewed = await this.deps.lease.renew({
      holderId: held.holderId,
      fence: held.fence,
      leaseUntilIso: new Date(Date.parse(nowIso) + REPOINT_FENCE_MS).toISOString(),
      nowIso,
    });
    if (renewed.outcome !== 'ok' || renewed.lease.fence !== held.fence) {
      return false;
    }
    held.leaseUntilIso = renewed.lease.leaseUntilIso;
    // The margin is measured on a clock read after the renew returned, so a
    // slow lease store can never leave a stale "time left" behind it.
    return Date.parse(held.leaseUntilIso) - Date.parse(this.deps.nowIso()) >= REPOINT_MARGIN_MS;
  }

  private async acquireLease(request: ValidRequest, target: string): Promise<HeldLease | ManageReleaseRefusal> {
    let lease: ConductorDriverLeaseRecord | null;
    try {
      lease = await this.deps.lease.read();
    } catch {
      return 'lease-unknown';
    }
    const nowIso = this.deps.nowIso();
    if (lease !== null && !isLeaseLapsed(lease, nowIso)) {
      return 'driver-lease-live';
    }
    const holderId = `release-${request.action}-${target}`;
    try {
      const acquired = await this.deps.lease.acquire({
        holderId,
        observedFence: lease?.fence ?? 0,
        leaseUntilIso: new Date(Date.parse(nowIso) + REPOINT_FENCE_MS).toISOString(),
        nowIso,
      });
      return acquired.outcome === 'ok'
        ? { holderId, fence: acquired.lease.fence, leaseUntilIso: acquired.lease.leaseUntilIso }
        : 'driver-lease-live';
    } catch {
      return 'lease-unknown';
    }
  }

  /** Best effort: a release that fails leaves a lease that lapses on its own within the fence window. */
  private async releaseLease(held: HeldLease): Promise<void> {
    try {
      await this.deps.lease.release({ holderId: held.holderId, fence: held.fence, nowIso: this.deps.nowIso() });
    } catch {
      // The lease expires by itself; the repoint result stands.
    }
  }

  private async consumeGrant(
    request: ValidRequest,
    target: string,
    grantId: string,
    opId: string,
  ): Promise<ManageReleaseRefusal | null> {
    const coordinates = grantCoordinates(request, target, opId);
    try {
      const consumed = await this.deps.authorization.consumeActionAuthorization({
        authorizationGrantId: grantId,
        actionId: coordinates.actionId,
        actionKind: coordinates.actionKind,
        expectedHeadSha: target,
        attemptId: coordinates.actionId,
        releaseRoot: request.root,
      });
      if (consumed.outcome === 'consumed' && consumed.actionId === coordinates.actionId) {
        return null;
      }
      return consumed.outcome === 'refused' && consumed.reason === 'release-grant-root-mismatch'
        ? 'release-grant-root-mismatch'
        : 'authority-refused';
    } catch {
      return 'authority-unknown';
    }
  }

  /** The shas a prune would remove once `target` is current (and, for a new install, built). */
  private wouldPrune(
    builds: readonly ReleaseBuildRecord[],
    target: string,
    alreadyBuilt: boolean,
    keep: number,
  ): readonly string[] {
    const after = alreadyBuilt
      ? builds
      : [...builds, { sha: target, builtAtIso: this.deps.nowIso() }].sort(compareBuilds);
    return shasToPrune(after, target, keep);
  }

  /** null when the build is verified and in place; the refusal otherwise. Nothing is repointed here. */
  private async build(request: ValidRequest, sha: string): Promise<ManageReleaseRefusal | null> {
    const source = request.source as string;
    const staging = await this.deps.store.prepare({ root: request.root, sha });
    if (staging.outcome !== 'prepared') {
      return 'store-unreadable';
    }
    const { buildId, buildDir, archivePath, homeDir } = staging;
    const baseEnv = this.deps.env();
    const buildEnv = { ...allowlisted(baseEnv, CHILD_ENV_ALLOWLIST), HOME: homeDir };
    const env: Record<string, string> = {
      ...buildEnv,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'none',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
    };
    const gitBudget = { timeoutMs: GIT_STEP_TIMEOUT_MS, maxBufferBytes: GIT_STEP_MAX_BUFFER_BYTES, killProcessTree: true };
    const yarnBudget = { timeoutMs: YARN_STEP_TIMEOUT_MS, maxBufferBytes: YARN_STEP_MAX_BUFFER_BYTES, killProcessTree: true };
    const steps: ReadonlyArray<{ argv: readonly string[]; options: CommandRunOptions }> = [
      {
        argv: [
          'git',
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-C',
          source,
          'archive',
          '--format=tar',
          '--output',
          archivePath,
          sha,
        ],
        options: { cwd: source, env, ...gitBudget },
      },
      { argv: ['tar', '-xf', archivePath, '-C', buildDir], options: { cwd: request.root, env: buildEnv, ...gitBudget } },
      { argv: ['yarn', 'install', '--immutable'], options: { cwd: buildDir, env: buildEnv, ...yarnBudget } },
      { argv: ['yarn', 'build'], options: { cwd: buildDir, env: buildEnv, ...yarnBudget } },
    ];
    for (const step of steps) {
      if (!(await this.stepSucceeds(step.argv, step.options))) {
        await this.discardBuild(request.root, buildId);
        return 'build-failed';
      }
    }
    const marked = await this.deps.store.markVerified({
      root: request.root,
      sha,
      buildId,
      builtAtIso: this.deps.nowIso(),
    });
    if (marked.outcome === 'ok') {
      return null;
    }
    await this.discardBuild(request.root, buildId);
    if (marked.outcome === 'not-verified') {
      return 'verify-failed';
    }
    return marked.outcome === 'not-found' ? 'build-failed' : 'store-unreadable';
  }

  /**
   * Cleanup of this run's staging directory. A failed cleanup is safe: the
   * directory's name is unique to this run, `prepare` never hands it out
   * again, and only `markVerified` with its build id moves it into place.
   */
  private async discardBuild(root: string, buildId: string): Promise<void> {
    try {
      await this.deps.store.discard({ root, buildId });
    } catch {
      // The refusal stands; the staging directory is never reused.
    }
  }

  private async stepSucceeds(argv: readonly string[], options: CommandRunOptions): Promise<boolean> {
    try {
      const result = await this.deps.executor.run(argv, options);
      return result.exitCode === 0 && result.signal === null && result.error === undefined;
    } catch {
      return false;
    }
  }
}

/** The fresh listing still has `current` where the plan saw it, and the target is still the action's target. */
function stillTargets(
  action: ReleaseAction,
  builds: readonly ReleaseBuildRecord[],
  current: string | null,
  plannedCurrent: string | null,
  target: string,
  isResume: boolean,
): boolean {
  if (current !== plannedCurrent) {
    return false;
  }
  if (action === 'rollback') {
    // CO14b fix round 8 (finding 2): a resumed rollback's target can already
    // equal `current` when the crashed attempt it resumes already repointed
    // for real before crashing. A fresh previousBuild(builds, current) could
    // never reproduce that: a build's own predecessor is never itself, so on
    // an ORDINARY (non-resumed) call this disjunct can never be the one that
    // makes the check pass -- `current !== plannedCurrent` above already
    // refused whenever current moved to anything else, and when it hasn't
    // moved at all, target (computed fresh from plannedCurrent) is never
    // equal to it either. It activates only for the resumed case, where
    // `resolveTarget` recovered `target` from the crashed attempt's own open
    // intent rather than recomputing it.
    //
    // CO14b fix round 9 (Luna): that "never for an ordinary call" argument
    // assumed the only way to reach this disjunct with current === target is
    // THIS call's own crashed-and-resumed attempt. It is not: a SEPARATE,
    // independently authorized rollback request can race in after a first
    // call already repointed to this same target and released its lease, but
    // before that first call's own intent completed. If this call's own
    // `peekOperation` runs only once the first call's intent is gone, this
    // call begins a genuinely fresh (`'started'`) operation under its own
    // opId, finds `current` already at `target`, and the un-gated disjunct
    // would wrongly let it claim that prior work as its own. `isResume` (true
    // only when `begun.outcome === 'resumed'` for THIS call) closes that: a
    // fresh operation gets no benefit from the disjunct and must pass the
    // ordinary `previousBuild` check instead, which is false here (a build's
    // own predecessor is never itself), so it is correctly refused.
    return (isResume && current === target) || previousBuild(builds, current) === target;
  }
  return builds.some((build) => build.sha === target);
}

function repointRefusal(outcome: 'fenced' | 'not-found' | 'not-verified' | 'unreadable'): ManageReleaseRefusal {
  if (outcome === 'fenced') {
    return 'driver-lease-live';
  }
  return outcome === 'not-found' ? 'not-found' : 'store-unreadable';
}

function allowlisted(
  source: Record<string, string | undefined>,
  keys: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') {
      picked[key] = value;
    }
  }
  return picked;
}

/**
 * One apply's operation: its unique id, whether the grant may have been
 * spent for it, and whether THIS call's own `beginOperation` resumed a
 * pre-existing intent (`'resumed'`) rather than starting a fresh one
 * (`'started'`). CO14b fix round 9: `isResume` is the only thing allowed to
 * unlock the "already at target" short-circuits in `fencedRepoint` and
 * `stillTargets` -- never `fresh.current === target` alone, which a freshly
 * started operation can observe too when a separate, independently
 * authorized call already did the work and released its lease first.
 */
interface OperationContext {
  readonly opId: string;
  consumed: boolean;
  readonly isResume: boolean;
}

/**
 * The release action kind and the action id one grant is bound to. The id
 * carries the operation id, which is unique per operation and is not derivable
 * from action and sha, so a new request can never look like a resume of an
 * earlier, completed one.
 */
function grantCoordinates(
  request: ValidRequest,
  target: string,
  opId: string,
): { readonly actionKind: ReleaseActionKind; readonly actionId: string } {
  const actionKind: ReleaseActionKind = `release-${request.action}`;
  return { actionKind, actionId: `${actionKind}-${target}-${opId}` };
}

function refuse(reason: ManageReleaseRefusal): ManageReleaseResult {
  return { outcome: 'refused', reason };
}

function compareBuilds(a: ReleaseBuildRecord, b: ReleaseBuildRecord): number {
  const byTime = Date.parse(a.builtAtIso) - Date.parse(b.builtAtIso);
  if (byTime !== 0) {
    return byTime;
  }
  if (a.sha < b.sha) {
    return -1;
  }
  return a.sha > b.sha ? 1 : 0;
}

/** The kept build immediately older than `current`; null when current is not a kept build or is the oldest. */
function previousBuild(builds: readonly ReleaseBuildRecord[], current: string | null): string | null {
  const index = current === null ? -1 : builds.findIndex((build) => build.sha === current);
  return index > 0 ? builds[index - 1].sha : null;
}

/** The shas outside the newest `keep` builds, never `current` nor the build just older than it; oldest first. */
function shasToPrune(builds: readonly ReleaseBuildRecord[], current: string, keep: number): string[] {
  const protectedShas = new Set(builds.slice(Math.max(0, builds.length - keep)).map((build) => build.sha));
  protectedShas.add(current);
  const previous = previousBuild(builds, current);
  if (previous !== null) {
    protectedShas.add(previous);
  }
  return builds.filter((build) => !protectedShas.has(build.sha)).map((build) => build.sha);
}

function readRequest(raw: unknown): ValidRequest | null {
  const snapshot = snapshotPlainDataRecord(raw);
  if (snapshot === null || !hasExactlyRequestKeys(snapshot)) {
    return null;
  }
  const { action, root, sha, source, keep, apply, projectId } = snapshot;
  if (
    !isAction(action) ||
    !isAbsolutePath(root) ||
    typeof apply !== 'boolean' ||
    !isKeep(keep) ||
    !isNullOr(sha, isSha) ||
    !isNullOr(source, isAbsolutePath) ||
    !isNullOr(projectId, isProjectId)
  ) {
    return null;
  }
  // install and swap name a sha, rollback never does; only install takes a source.
  if ((sha === null) !== (action === 'rollback') || (source === null) === (action === 'install')) {
    return null;
  }
  return { action, root, sha, source, keep, apply, projectId };
}

function hasExactlyRequestKeys(snapshot: Record<string, unknown>): boolean {
  const keys = Object.keys(snapshot);
  return keys.length === REQUEST_KEYS.length && REQUEST_KEYS.every((key) => keys.includes(key));
}

function isAction(value: unknown): value is ReleaseAction {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

function isKeep(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_KEEP && value <= MAX_KEEP;
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function isNullOr<T>(value: unknown, guard: (candidate: unknown) => candidate is T): value is T | null {
  return value === null || guard(value);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value !== '' && new TextEncoder().encode(value).length <= maxBytes;
}

function isProjectId(value: unknown): value is string {
  return isBoundedString(value, MAX_PROJECT_ID_BYTES) && value.trim() === value && !containsSecretShape(value);
}

function isAbsolutePath(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_PATH_BYTES) &&
    value.startsWith('/') &&
    !value.includes('\0') &&
    !value.split('/').includes('..') &&
    !containsSecretShape(value)
  );
}
