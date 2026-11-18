// SH20: the one `releaseSha` source `record-day` composes. It derives the
// day's sha from the installed `current` verified release under the release
// root parsed from the configured `daemon.cliPath`, reading through
// `ReleaseStoreAdapter.list` (which never writes) and reusing the SAME
// adapter instance the one-time criteria inspect files through — so the sha
// recorded for the day is the one `inspectReleaseFiles` inspects.
//
// Every failure path is a `null` (the day then records as `release-unpinned`
// for S2/S10/S11): never a throw, never a guessed sha. Cost: linear in the
// verified-build listing the port returns (the adapter caps that listing);
// this helper adds no filesystem or subprocess access of its own.
import { SHADOW_RELEASE_SHA_PATTERN, type ReleaseStorePort } from '@fleet/work-execution';

export async function readCurrentReleaseSha(input: {
  readonly releaseStore: Pick<ReleaseStorePort, 'list'>;
  readonly releaseRoot: string;
}): Promise<string | null> {
  // Unconfigured `daemon.cliPath` parses to an empty root: refuse before any
  // port call at all.
  if (input.releaseRoot === '') {
    return null;
  }
  try {
    const listing = await input.releaseStore.list({ root: input.releaseRoot });
    if (listing.outcome !== 'read') {
      return null;
    }
    const current = listing.current;
    if (current === null || !SHADOW_RELEASE_SHA_PATTERN.test(current)) {
      return null;
    }
    // `current` must name a verified build the listing itself saw; an
    // unverified or missing directory is a refusal, never a sha.
    if (!listing.builds.some((build) => build.sha === current)) {
      return null;
    }
    return current;
  } catch {
    return null;
  }
}
