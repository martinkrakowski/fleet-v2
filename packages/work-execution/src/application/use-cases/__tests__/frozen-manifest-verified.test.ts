/**
 * SEC-5a: `readVerifiedFrozenManifest` returns the frozen brief manifest only
 * after verifying it against the attempt's recorded `briefDigest`. Every
 * missing, throwing, unreadable, mismatched or non-object input reads null
 * (fail-closed); only the exact digest match returns the parsed manifest.
 * SEC-5b: `readFrozenManifestVerified` classifies the same read three ways —
 * `verified`, `absent` (nothing recorded to read) and `unverified` (read made
 * and not verified) — so callers can distinguish a skip from a fail-closed
 * refusal. `readFrozenManifest` stays the unverified reader (regression
 * guard).
 */

import { describe, expect, it } from 'vitest';

import type { AttemptRecord, AttemptRunnerRecord } from '../../../domain/execution-records.js';
import type { AdvanceLaneRunDependencies } from '../AdvanceLaneRunUseCase.use-case.js';
import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import { readFrozenManifest, readFrozenManifestVerified, readVerifiedFrozenManifest } from '../advance-lane-run/frozen-manifest.js';

const PROSE = '# brief\n';
const WORKTREE_PATH = '/tmp/opencode/wo-example-1/wt-example-1';
const BRIEF_PATH = '.lane/brief.md';
const MANIFEST_PATH = '.lane/brief-manifest.json';
const MANIFEST = { timeLimitSeconds: 3600 };
const DEFAULT_MANIFEST_JSON = JSON.stringify(MANIFEST);

const digestFor = (json: string): string =>
  simpleDeterministicHexDigest(PROSE + '\n' + json);

const CONDUCTED_RUNNER: AttemptRunnerRecord = {
  kind: 'opencode',
  remotePort: 4166,
  host: 'lane-alias-example',
  hostName: 'lane-host-example',
  agent: null,
  model: null,
  variant: null,
};

function attemptFixture(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-example-1',
    workOrderId: 'wo-example-1',
    kind: 'initial',
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: WORKTREE_PATH,
    baseCommit: 'a'.repeat(40),
    state: 'running',
    outcome: null,
    briefDigest: digestFor(DEFAULT_MANIFEST_JSON),
    briefPackagePath: BRIEF_PATH,
    sessionId: 'session-example-1',
    completionReceipt: null,
    artifacts: null,
    runner: CONDUCTED_RUNNER,
    seatPlan: null,
    seatSelection: null,
    stopReason: 'none',
    createdAtIso: '2026-10-27T10:00:00.000Z',
    updatedAtIso: '2026-10-27T10:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  readonly artifactPort: AdvanceLaneRunDependencies['artifactPort'];
  readonly briefReads: Array<[worktreePath: string, relativePath: string, recordedHost: AttemptRunnerRecord | null]>;
  readonly manifestReads: Array<[worktreePath: string, manifestPath: string, recordedHost: AttemptRunnerRecord | null]>;
  setProse(prose: string | null): void;
  setManifest(json: string | null): void;
  setReadsThrow(): void;
}

function makeHarness(options: { readonly readBriefFile?: boolean; readonly readBriefManifest?: boolean } = {}): Harness {
  let prose: string | null = PROSE;
  let manifestJson: string | null = DEFAULT_MANIFEST_JSON;
  let readsThrow = false;
  const briefReads: Harness['briefReads'] = [];
  const manifestReads: Harness['manifestReads'] = [];
  const artifactPort: AdvanceLaneRunDependencies['artifactPort'] = {
    ...(options.readBriefFile === false
      ? {}
      : {
          readBriefFile: async (
            worktreePath: string,
            relativePath: string,
            recordedHost?: AttemptRunnerRecord | null,
          ): Promise<string | null> => {
            briefReads.push([worktreePath, relativePath, recordedHost ?? null]);
            if (readsThrow) {
              throw new Error('brief read failed');
            }
            return prose;
          },
        }),
    ...(options.readBriefManifest === false
      ? {}
      : {
          readBriefManifest: async (
            worktreePath: string,
            manifestPath?: string,
            recordedHost?: AttemptRunnerRecord | null,
          ): Promise<string | null> => {
            manifestReads.push([worktreePath, manifestPath ?? '', recordedHost ?? null]);
            if (readsThrow) {
              throw new Error('manifest read failed');
            }
            return manifestJson;
          },
        }),
    verifyArtifactManifest: async () => ({ outcome: 'missing' }),
  };
  return {
    artifactPort,
    briefReads,
    manifestReads,
    setProse: (value) => {
      prose = value;
    },
    setManifest: (json) => {
      manifestJson = json;
    },
    setReadsThrow: () => {
      readsThrow = true;
    },
  };
}

describe('readVerifiedFrozenManifest (SEC-5a)', () => {
  it('returns the manifest when the prose and manifest match the recorded digest', async () => {
    const harness = makeHarness();
    const attempt = attemptFixture();
    await expect(readVerifiedFrozenManifest(attempt, harness.artifactPort)).resolves.toEqual(MANIFEST);
    expect(harness.briefReads).toEqual([[WORKTREE_PATH, BRIEF_PATH, CONDUCTED_RUNNER]]);
    expect(harness.manifestReads).toEqual([[WORKTREE_PATH, MANIFEST_PATH, CONDUCTED_RUNNER]]);
  });

  it('returns null on a mismatching manifest', async () => {
    const harness = makeHarness();
    harness.setManifest(JSON.stringify({ timeLimitSeconds: 3333 }));
    await expect(readVerifiedFrozenManifest(attemptFixture(), harness.artifactPort)).resolves.toBeNull();
  });

  it('returns null when briefDigest is null', async () => {
    const harness = makeHarness();
    await expect(readVerifiedFrozenManifest(attemptFixture({ briefDigest: null }), harness.artifactPort)).resolves.toBeNull();
    // refused before any remote read
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('returns null when briefDigest is empty', async () => {
    const harness = makeHarness();
    await expect(readVerifiedFrozenManifest(attemptFixture({ briefDigest: '' }), harness.artifactPort)).resolves.toBeNull();
    // refused before any remote read
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('returns null when no briefPackagePath is recorded', async () => {
    const harness = makeHarness();
    await expect(readVerifiedFrozenManifest(attemptFixture({ briefPackagePath: null }), harness.artifactPort)).resolves.toBeNull();
    // refused before any remote read
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('returns null when readBriefFile is missing', async () => {
    const harness = makeHarness({ readBriefFile: false });
    await expect(readVerifiedFrozenManifest(attemptFixture(), harness.artifactPort)).resolves.toBeNull();
    // refused before any remote read
    expect(harness.manifestReads).toEqual([]);
  });

  it('returns null when a read throws', async () => {
    const harness = makeHarness();
    harness.setReadsThrow();
    await expect(readVerifiedFrozenManifest(attemptFixture(), harness.artifactPort)).resolves.toBeNull();
  });

  it('returns null when prose is null', async () => {
    const harness = makeHarness();
    harness.setProse(null);
    const digestCalls: string[] = [];
    const recordingDigest = (content: string): string => {
      digestCalls.push(content);
      return 'never-matches';
    };
    await expect(readVerifiedFrozenManifest(attemptFixture(), harness.artifactPort, recordingDigest)).resolves.toBeNull();
    // a missing file is refused before any digest is computed
    expect(digestCalls).toEqual([]);
  });

  it('returns null when the manifest is missing', async () => {
    const harness = makeHarness();
    harness.setManifest(null);
    const digestCalls: string[] = [];
    const recordingDigest = (content: string): string => {
      digestCalls.push(content);
      return 'never-matches';
    };
    await expect(readVerifiedFrozenManifest(attemptFixture(), harness.artifactPort, recordingDigest)).resolves.toBeNull();
    // a missing file is refused before any digest is computed
    expect(digestCalls).toEqual([]);
  });

  it('returns null when the manifest is not an object', async () => {
    const harness = makeHarness();
    harness.setManifest(JSON.stringify([1, 2]));
    await expect(readVerifiedFrozenManifest(attemptFixture(), harness.artifactPort)).resolves.toBeNull();
  });

  it('returns null when the manifest is not valid JSON', async () => {
    const harness = makeHarness();
    harness.setManifest('not json');
    await expect(readVerifiedFrozenManifest(attemptFixture(), harness.artifactPort)).resolves.toBeNull();
  });

  it('returns null when the attempt records no host', async () => {
    const harness = makeHarness();
    await expect(readVerifiedFrozenManifest(attemptFixture({ runner: null }), harness.artifactPort)).resolves.toBeNull();
  });
});

describe('readFrozenManifestVerified (SEC-5b)', () => {
  it('classifies a matching prose and manifest as verified and carries the manifest', async () => {
    const harness = makeHarness();
    const attempt = attemptFixture();
    await expect(readFrozenManifestVerified(attempt, harness.artifactPort)).resolves.toEqual({
      kind: 'verified',
      manifest: MANIFEST,
    });
    expect(harness.briefReads).toEqual([[WORKTREE_PATH, BRIEF_PATH, CONDUCTED_RUNNER]]);
    expect(harness.manifestReads).toEqual([[WORKTREE_PATH, MANIFEST_PATH, CONDUCTED_RUNNER]]);
  });

  it('reads absent when no briefPackagePath is recorded, before any read', async () => {
    const harness = makeHarness();
    await expect(readFrozenManifestVerified(attemptFixture({ briefPackagePath: null }), harness.artifactPort)).resolves.toEqual({
      kind: 'absent',
    });
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('reads absent when briefPackagePath is empty, before any read', async () => {
    const harness = makeHarness();
    await expect(readFrozenManifestVerified(attemptFixture({ briefPackagePath: '' }), harness.artifactPort)).resolves.toEqual({
      kind: 'absent',
    });
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('reads absent when the port has no readBriefManifest, before any read', async () => {
    const harness = makeHarness({ readBriefManifest: false });
    await expect(readFrozenManifestVerified(attemptFixture(), harness.artifactPort)).resolves.toEqual({ kind: 'absent' });
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('reads unverified when briefDigest is null', async () => {
    const harness = makeHarness();
    await expect(readFrozenManifestVerified(attemptFixture({ briefDigest: null }), harness.artifactPort)).resolves.toEqual({
      kind: 'unverified',
    });
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('reads unverified when briefDigest is empty', async () => {
    const harness = makeHarness();
    await expect(readFrozenManifestVerified(attemptFixture({ briefDigest: '' }), harness.artifactPort)).resolves.toEqual({
      kind: 'unverified',
    });
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('reads unverified when the port has no readBriefFile, before any read', async () => {
    const harness = makeHarness({ readBriefFile: false });
    await expect(readFrozenManifestVerified(attemptFixture(), harness.artifactPort)).resolves.toEqual({ kind: 'unverified' });
    expect(harness.manifestReads).toEqual([]);
  });

  it('reads unverified when the attempt records no host', async () => {
    const harness = makeHarness();
    await expect(readFrozenManifestVerified(attemptFixture({ runner: null }), harness.artifactPort)).resolves.toEqual({
      kind: 'unverified',
    });
    expect(harness.briefReads).toEqual([]);
    expect(harness.manifestReads).toEqual([]);
  });

  it('reads unverified when a read throws', async () => {
    const harness = makeHarness();
    harness.setReadsThrow();
    await expect(readFrozenManifestVerified(attemptFixture(), harness.artifactPort)).resolves.toEqual({ kind: 'unverified' });
  });

  it('reads unverified when the prose is missing on disk', async () => {
    const harness = makeHarness();
    harness.setProse(null);
    await expect(readFrozenManifestVerified(attemptFixture(), harness.artifactPort)).resolves.toEqual({ kind: 'unverified' });
  });

  it('reads unverified when the manifest is missing on disk', async () => {
    const harness = makeHarness();
    harness.setManifest(null);
    await expect(readFrozenManifestVerified(attemptFixture(), harness.artifactPort)).resolves.toEqual({ kind: 'unverified' });
  });

  it('reads unverified on a digest mismatch', async () => {
    const harness = makeHarness();
    harness.setManifest(JSON.stringify({ timeLimitSeconds: 3333 }));
    await expect(readFrozenManifestVerified(attemptFixture(), harness.artifactPort)).resolves.toEqual({ kind: 'unverified' });
  });

  it('reads unverified when the manifest is not valid JSON', async () => {
    const harness = makeHarness();
    harness.setManifest('not json');
    await expect(readFrozenManifestVerified(attemptFixture(), harness.artifactPort)).resolves.toEqual({ kind: 'unverified' });
  });

  it('reads unverified when the manifest is not an object', async () => {
    const harness = makeHarness();
    harness.setManifest(JSON.stringify([1, 2]));
    await expect(readFrozenManifestVerified(attemptFixture(), harness.artifactPort)).resolves.toEqual({ kind: 'unverified' });
  });
});

describe('readFrozenManifest regression guard (SEC-5a)', () => {
  it('readFrozenManifest stays the unverified reader', async () => {
    const harness = makeHarness();
    // A mismatching on-disk manifest is still read and parsed by the legacy
    // reader; only readVerifiedFrozenManifest fail-closes on it.
    harness.setManifest(JSON.stringify({ timeLimitSeconds: 3333 }));
    await expect(readFrozenManifest(attemptFixture(), harness.artifactPort)).resolves.toEqual({ timeLimitSeconds: 3333 });
  });
});
