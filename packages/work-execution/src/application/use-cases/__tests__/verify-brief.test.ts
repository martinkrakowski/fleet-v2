// Lane CO18: VerifyBriefUseCase tests.
import { describe, expect, it } from 'vitest';

import { simpleDeterministicHexDigest } from '../PrepareBriefPackageUseCase.use-case.js';
import type {
  AttemptArtifactPort,
} from '../../ports/out/AttemptArtifactPort.out-port.js';
import type { ReviewRequest, ReviewRequestResult } from '../../ports/out/ReviewRequestPort.out-port.js';
import type { WorkOrderRecord } from '../../../domain/execution-records.js';
import type { VerifyBriefDependencies } from '../VerifyBriefUseCase.use-case.js';
import type { VerifyBriefRequest, VerifyBriefResult } from '../../ports/in/VerifyBriefPort.in-port.js';
import { VerifyBriefUseCase } from '../VerifyBriefUseCase.use-case.js';

const COMMIT = 'a'.repeat(40);
const ATTEMPT_ID = 'attempt-1';
const WORK_ORDER_ID = 'wo-1';
const WORKTREE = '/wt/repo';
const REVIEWER = 'reviewer-model';

const PROSE = [
  '# Lane brief',
  '## File list',
  '- src/a.ts',
  '## Commands',
  '- yarn test',
  '## Tier',
  'Tier 2',
  '## Size',
  'Size: about 45 minutes, one commit.',
  '## Commit',
  'Commit: one commit',
  '## Validity',
  'Valid at the base commit.',
  '## Hard to undo',
  'Nothing.',
  '## Assumptions',
  'None.',
  '## Challenge this',
  'The file list.',
].join('\n');

function validManifestRecord(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    workOrderId: WORK_ORDER_ID,
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'repo-1',
    baseCommit: COMMIT,
    policyRevision: 'policy-1',
    modelAssignment: { seatTool: 'opencode', model: 'impl-model' },
    independentReviewer: REVIEWER,
    ownedPaths: ['src/a.ts'],
    allowedPathPrefixes: ['src'],
    acceptanceSpec: {
      commitRequired: true,
      diffCheck: true,
      commands: [{ argv: ['yarn', 'test'] }],
    },
    stepLimit: 100,
    timeLimitSeconds: 600,
    resourceBounds: {},
    expectedArtifacts: [],
    ownerDecisionReferences: [],
    selectedKnowledgeVersions: [],
  };
}

function workOrderRecord(overrides: Partial<Record<string, unknown>> = {}): WorkOrderRecord {
  return {
    id: WORK_ORDER_ID,
    projectId: 'proj-1',
    taskId: 'task-1',
    laneId: 'lane-1',
    repository: 'repo-1',
    baseCommit: COMMIT,
    ownedPaths: ['src/a.ts'],
    policyRevision: 'policy-1',
    prerequisiteWorkOrderIds: [],
    state: 'approved',
    revision: 0,
    createdAtIso: '2026-11-14T00:00:00.000Z',
    updatedAtIso: '2026-11-14T00:00:00.000Z',
    ...overrides,
  } as WorkOrderRecord;
}

interface Fixture {
  readonly request: VerifyBriefRequest;
  readonly prose: string;
  readonly manifestJson: string;
  readonly briefDigest: string;
  readonly record: WorkOrderRecord;
}

/** A valid frozen package matching the record: the happy-path fixture. */
function fixture(
  mutate?: (manifest: Record<string, unknown>, request: Record<string, unknown>, prose: string) => void,
): Fixture {
  const manifest = validManifestRecord();
  const request: Record<string, unknown> = {
    workOrderId: WORK_ORDER_ID,
    attemptId: ATTEMPT_ID,
    worktreePath: WORKTREE,
    expectedBriefDigest: '',
  };
  const prose = PROSE.slice();
  if (mutate) {
    mutate(manifest, request, prose);
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  const briefDigest = simpleDeterministicHexDigest(`${prose}\n${manifestJson}`);
  request.expectedBriefDigest = briefDigest;
  return {
    request: request as unknown as VerifyBriefRequest,
    prose,
    manifestJson,
    briefDigest,
    record: workOrderRecord(),
  };
}

function depsWith(options: {
  record?: WorkOrderRecord | null | 'throw';
  manifest?: string | null | 'throw' | 7;
  prose?: string | null | 'throw' | 7;
  readManifest?: boolean;
  readFile?: boolean;
  findWorkOrderById?: boolean;
  computeDigest?: (content: string) => string;
  reviews?: (request: ReviewRequest) => Promise<ReviewRequestResult>;
}): VerifyBriefDependencies & { readonly reviewRequests: ReviewRequest[] } {
  const reviewRequests: ReviewRequest[] = [];
  const workOrderRepo = {
    ...(options.findWorkOrderById === false ? {} : {
      async findWorkOrderById() {
        if (options.record === 'throw') {
          throw new Error('database timeout');
        }
        return options.record === undefined ? workOrderRecord() : options.record;
      },
    }),
  };
  const artifactPort = {
    ...(options.readManifest === false ? {} : {
      async readBriefManifest() {
        if (options.manifest === 'throw') {
          throw new Error('permission denied');
        }
        return options.manifest === undefined ? fixture().manifestJson : options.manifest;
      },
    }),
    ...(options.readFile === false ? {} : {
      async readBriefFile() {
        if (options.prose === 'throw') {
          throw new Error('ssh timeout');
        }
        return options.prose === undefined ? PROSE : options.prose;
      },
    }),
  } as unknown as Pick<AttemptArtifactPort, 'readBriefManifest' | 'readBriefFile'>;
  const reviewsFn = options.reviews;
  return {
    workOrderRepo,
    artifactPort,
    ...(options.computeDigest !== undefined ? { computeDigest: options.computeDigest } : {}),
    ...(reviewsFn !== undefined ? {
      reviews: {
        async requestReview(request: ReviewRequest) {
          reviewRequests.push(request);
          return reviewsFn(request);
        },
      },
    } : {}),
    reviewRequests,
  } as VerifyBriefDependencies & { readonly reviewRequests: ReviewRequest[] };
}

async function verify(call: VerifyBriefDependencies): Promise<VerifyBriefResult> {
  const useCase = new VerifyBriefUseCase(call);
  return useCase.verifyBrief(fixture().request);
}

/** Verifies one fixture against deps that serve that fixture's own artifacts. */
async function verifyWith(
  f: Fixture,
  options: Parameters<typeof depsWith>[0] = {},
): Promise<VerifyBriefResult> {
  const useCase = new VerifyBriefUseCase(depsWith({
    ...options,
    manifest: options.manifest ?? f.manifestJson,
    prose: options.prose ?? f.prose,
    record: options.record ?? f.record,
  }));
  return useCase.verifyBrief(f.request);
}

/** A passing receipt bound to the fixture's digest. */
function receiptFor(briefDigest: string, verdict: string): unknown {
  return {
    requestId: `brief-verify:${WORK_ORDER_ID}:${briefDigest.slice(0, 12)}`,
    kind: 'brief-verify',
    verdict,
    findings: [],
  };
}

describe('VerifyBriefUseCase', () => {
  it('verifies a frozen package that matches the work order record', async () => {
    const base = fixture();
    const deps = depsWith({});
    const useCase = new VerifyBriefUseCase(deps);
    const result = await useCase.verifyBrief(base.request);
    expect(result).toEqual({
      outcome: 'verified',
      workOrderId: WORK_ORDER_ID,
      attemptId: ATTEMPT_ID,
      briefDigest: base.briefDigest,
      verificationKey: `brief-verify/${WORK_ORDER_ID}@${base.briefDigest.slice(0, 12)}`,
    });
  });

  it('verifies through execute() by delegation and with a passing brief-verify receipt', async () => {
    const base = fixture();
    const deps = depsWith({
      reviews: () => Promise.resolve({
        outcome: 'receipt',
        receipt: receiptFor(base.briefDigest, 'passed'),
      } as unknown as ReviewRequestResult),
    });
    const useCase = new VerifyBriefUseCase(deps);
    const result = await useCase.execute(base.request);
    expect(result).toEqual({
      outcome: 'verified',
      workOrderId: WORK_ORDER_ID,
      attemptId: ATTEMPT_ID,
      briefDigest: base.briefDigest,
      verificationKey: `brief-verify/${WORK_ORDER_ID}@${base.briefDigest.slice(0, 12)}`,
    });
    expect(deps.reviewRequests).toHaveLength(1);
    expect(deps.reviewRequests[0]?.kind).toBe('brief-verify');
    expect(deps.reviewRequests[0]?.subject).toEqual({
      kind: 'brief',
      projectId: 'proj-1',
      briefPackageDigest: base.briefDigest,
      baseCommit: COMMIT,
    });
  });

  it('refuses null, non-plain, getter-trapped, and malformed request fields with invalid-request', async () => {
    expect(await verify(depsWith({ record: null }))).toBeTruthy(); // sanity: harness works
    const cases: unknown[] = [
      null,
      undefined,
      42,
      'request',
      [],
      Object.create({ workOrderId: 'inherited' }),
      Object.defineProperties({}, {
        workOrderId: { get() { return WORK_ORDER_ID; }, enumerable: true },
      }),
    ];
    const base = fixture().request as unknown as Record<string, unknown>;
    cases.push(
      { ...base, workOrderId: '   ' },
      { ...base, workOrderId: 'x'.repeat(513) },
      { ...base, workOrderId: 'wo\0' },
      { ...base, attemptId: '' },
      { ...base, worktreePath: 'relative/path' },
      { ...base, worktreePath: '/wt/../secret' },
      { ...base, expectedBriefDigest: 'nothex' },
      { ...base, expectedBriefDigest: 'A'.repeat(64) },
      { ...base, prosePath: '../secret.md' },
      { ...base, manifestPath: '/absolute.json' },
      { ...base, recordedHost: '' },
      { ...base, recordedHost: 'h'.repeat(513) },
      { workOrderId: WORK_ORDER_ID },
    );
    for (const bad of cases) {
      const useCase = new VerifyBriefUseCase(depsWith({}));
      const result = await useCase.verifyBrief(bad as VerifyBriefRequest);
      expect(result).toEqual({ outcome: 'refused', reason: 'invalid-request', detail: expect.any(String) });
    }
  });

  it('returns unverified with work-order-unreadable when repository throws or returns a malformed record', async () => {
    const thrown = await verify(depsWith({ record: 'throw' }));
    expect(thrown).toEqual({
      outcome: 'unverified', reason: 'work-order-unreadable', detail: 'repository-error',
    });
    for (const malformed of [
      workOrderRecord({ ownedPaths: [] }),
      workOrderRecord({ ownedPaths: 'src/a.ts' as unknown as string[] }),
      workOrderRecord({ state: 'not-a-state' }),
      workOrderRecord({ revision: -1 }),
      workOrderRecord({ projectId: '' }),
    ]) {
      const result = await verify(depsWith({ record: malformed }));
      expect(result).toEqual({
        outcome: 'unverified',
        reason: 'work-order-unreadable',
        detail: 'invalid-work-order-record',
      });
    }
    const missingMethod = new VerifyBriefUseCase({
      artifactPort: depsWith({}).artifactPort,
      workOrderRepo: {} as VerifyBriefDependencies['workOrderRepo'],
    });
    const result = await missingMethod.verifyBrief(fixture().request);
    expect(result).toEqual({
      outcome: 'unverified',
      reason: 'work-order-unreadable',
      detail: 'missing-work-order-repository',
    });
  });

  it('returns unverified with work-order-missing when the work order does not exist', async () => {
    expect(await verify(depsWith({ record: null }))).toEqual({
      outcome: 'unverified', reason: 'work-order-missing', detail: null,
    });
  });

  it('refuses verification with work-order-terminal when the work order is merged or stopped', async () => {
    for (const state of ['merged', 'stopped']) {
      const result = await verify(depsWith({ record: workOrderRecord({ state }) }));
      expect(result).toEqual({ outcome: 'refused', reason: 'work-order-terminal', detail: state });
    }
  });

  it('returns unverified with artifact-reader-unavailable when optional artifact reader methods are absent', async () => {
    for (const partial of [
      depsWith({ readManifest: false }),
      depsWith({ readFile: false }),
    ]) {
      const useCase = new VerifyBriefUseCase(partial);
      expect(await useCase.verifyBrief(fixture().request)).toEqual({
        outcome: 'unverified', reason: 'artifact-reader-unavailable', detail: null,
      });
    }
  });

  it('refuses with missing-package when manifest or prose file is absent in the worktree', async () => {
    const manifestMissing = await verify(depsWith({ manifest: null }));
    expect(manifestMissing).toEqual({ outcome: 'refused', reason: 'missing-package', detail: 'missing-manifest' });
    const proseMissing = await verify(depsWith({ prose: null }));
    expect(proseMissing).toEqual({ outcome: 'refused', reason: 'missing-package', detail: 'missing-prose' });
  });

  it('refuses with unreadable-package when reading manifest or prose throws or returns a non-string', async () => {
    const manifestThrown = await verify(depsWith({ manifest: 'throw' }));
    expect(manifestThrown).toEqual({
      outcome: 'refused', reason: 'unreadable-package', detail: 'artifact-read-thrown',
    });
    const proseThrown = await verify(depsWith({ prose: 'throw' }));
    expect(proseThrown).toEqual({
      outcome: 'refused', reason: 'unreadable-package', detail: 'artifact-read-thrown',
    });
    const nonString = await verify(depsWith({ prose: 7 }));
    expect(nonString).toEqual({
      outcome: 'refused', reason: 'unreadable-package', detail: 'non-string-artifact',
    });
  });

  it('refuses with malformed-package on invalid JSON, digest mismatch, lint failure, same-family reviewer, or record metadata mismatch', async () => {
    const invalidJson = await verifyWith(fixture(), { manifest: '{"schemaVersion":2,' });
    expect(invalidJson).toEqual({ outcome: 'refused', reason: 'malformed-package', detail: 'invalid-json' });

    const emptyManifest = await verifyWith(fixture(), { manifest: '   \n  ' });
    expect(emptyManifest).toEqual({ outcome: 'refused', reason: 'malformed-package', detail: 'empty-manifest' });

    const oversized = await verifyWith(fixture(), { prose: `x\n${'y'.repeat(65_536)}` });
    expect(oversized).toEqual({ outcome: 'refused', reason: 'malformed-package', detail: 'oversized' });

    const digestMismatch = await verifyWith(
      fixture(),
      { manifest: `${fixture().manifestJson} ` }, // same JSON, different bytes: the digest no longer matches
    );
    expect(digestMismatch).toEqual({ outcome: 'refused', reason: 'malformed-package', detail: 'digest-mismatch' });

    const badProse = '# Not a brief\nJust some text.';
    const lintFixture = fixture(); // the manifest is unchanged, so only the prose digest is recomputed
    const badProseManifest = lintFixture.manifestJson;
    const lintResult = await verifyWith(
      {
        ...lintFixture,
        prose: badProse,
        request: {
          ...lintFixture.request,
          expectedBriefDigest: simpleDeterministicHexDigest(`${badProse}\n${badProseManifest}`),
        } as VerifyBriefRequest,
      },
      { prose: badProse },
    );
    expect(lintResult).toEqual({
      outcome: 'refused', reason: 'malformed-package', detail: expect.stringMatching(/^missing-/),
    });

    const recordMismatch = await verifyWith(
      fixture((manifest) => { manifest.laneId = 'other-lane'; }),
    );
    expect(recordMismatch).toEqual({ outcome: 'refused', reason: 'malformed-package', detail: 'record-mismatch' });

    const unknownSchema = await verifyWith(
      fixture((manifest) => { manifest.schemaVersion = 99; }),
    );
    expect(unknownSchema).toEqual({
      outcome: 'refused', reason: 'malformed-package', detail: 'unknown-schema-version',
    });

    const nonPlain = await verifyWith(
      fixture((manifest) => { delete manifest.attemptId; }),
    );
    expect(nonPlain).toEqual({ outcome: 'refused', reason: 'malformed-package', detail: 'non-plain-manifest' });

    const invalidLimits = await verifyWith(
      fixture((manifest) => { manifest.stepLimit = 0; }),
    );
    expect(invalidLimits).toEqual({ outcome: 'refused', reason: 'malformed-package', detail: 'invalid-limits' });
  });

  it('refuses with path-escapes-allowed-prefixes when an owned path escapes allowedPathPrefixes or targets a protected path', async () => {
    const noPrefixes = await verifyWith(
      fixture((manifest) => { manifest.allowedPathPrefixes = []; }),
    );
    expect(noPrefixes).toEqual({
      outcome: 'refused', reason: 'path-escapes-allowed-prefixes', detail: 'invalid-allowed-prefix',
    });

    const lanePrefix = await verifyWith(
      fixture((manifest) => { manifest.allowedPathPrefixes = ['.lane']; }),
    );
    expect(lanePrefix).toEqual({
      outcome: 'refused', reason: 'path-escapes-allowed-prefixes', detail: 'invalid-allowed-prefix',
    });

    const escapePath = await verifyWith(
      fixture((manifest) => {
        manifest.ownedPaths = ['../outside.ts'];
        manifest.allowedPathPrefixes = ['src', 'docs'];
      }),
    );
    expect(escapePath).toEqual({
      outcome: 'refused', reason: 'path-escapes-allowed-prefixes', detail: '../outside.ts',
    });

    const protectedPath = await verifyWith(
      fixture((manifest) => {
        manifest.ownedPaths = ['package.json'];
        manifest.allowedPathPrefixes = ['package.json'];
      }),
    );
    expect(protectedPath).toEqual({
      outcome: 'refused', reason: 'path-escapes-allowed-prefixes', detail: 'package.json',
    });

    const outsidePrefix = await verifyWith(
      fixture((manifest) => {
        manifest.ownedPaths = ['docs/readme.md'];
        manifest.allowedPathPrefixes = ['src'];
      }),
    );
    expect(outsidePrefix).toEqual({
      outcome: 'refused', reason: 'path-escapes-allowed-prefixes', detail: 'docs/readme.md',
    });
  });

  it('refuses with owned-paths-mismatch when package ownedPaths differ from the work order record', async () => {
    const extra = await verifyWith(
      fixture((manifest) => { manifest.ownedPaths = ['src/a.ts', 'src/b.ts']; }),
    );
    expect(extra).toEqual({ outcome: 'refused', reason: 'owned-paths-mismatch', detail: null });

    const different = await verifyWith(
      fixture((manifest) => { manifest.ownedPaths = ['src/b.ts']; }),
    );
    expect(different).toEqual({ outcome: 'refused', reason: 'owned-paths-mismatch', detail: null });

    const duplicated = await verifyWith(
      fixture((manifest) => { manifest.ownedPaths = ['src/a.ts', 'src/a.ts']; }),
    );
    expect(duplicated).toEqual({ outcome: 'refused', reason: 'owned-paths-mismatch', detail: null });

    const notAnArray = await verifyWith(
      fixture((manifest) => { manifest.ownedPaths = 'src/a.ts'; }),
    );
    expect(notAnArray).toEqual({ outcome: 'refused', reason: 'malformed-package', detail: 'invalid-owned-paths' });
  });

  it('returns unverified with digest-computation-failed when computeDigest throws', async () => {
    const result = await new VerifyBriefUseCase(depsWith({
      computeDigest: () => { throw new Error('digest exploded'); },
    })).verifyBrief(fixture().request);
    expect(result).toEqual({
      outcome: 'unverified', reason: 'digest-computation-failed', detail: null,
    });
  });

  it('returns unverified when ReviewRequestPort refuses with subject-not-implemented or returns unknown, and refuses with review-failed on a failed receipt', async () => {
    const base = fixture();
    const refused = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve({
        outcome: 'refused', reason: 'subject-not-implemented', detail: null,
      } as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(refused).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'subject-not-implemented',
    });

    const thrown = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.reject(new Error('transport down')),
    })).verifyBrief(base.request);
    expect(thrown).toEqual({ outcome: 'unverified', reason: 'review-unverified', detail: 'review-thrown' });

    const noReceipt = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve({
        outcome: 'no-receipt', reason: 'review-unavailable', detail: null,
      } as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(noReceipt).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'review-unavailable',
    });

    const unknown = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve({ outcome: 'unknown', reason: 'delegate-failed' } as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(unknown).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'delegate-failed',
    });

    const notPlain = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve('garbage' as unknown as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(notPlain).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'review-incomplete',
    });

    const mismatched = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve({
        outcome: 'receipt', receipt: receiptFor('b'.repeat(64), 'passed'),
      } as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(mismatched).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'receipt-mismatch',
    });

    const unknownVerdict = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve({
        outcome: 'receipt', receipt: receiptFor(base.briefDigest, 'unknown'),
      } as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(unknownVerdict).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'verdict-unknown',
    });

    const failed = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve({
        outcome: 'receipt', receipt: receiptFor(base.briefDigest, 'failed'),
      } as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(failed).toEqual({ outcome: 'refused', reason: 'review-failed', detail: null });

    const missingMethod = new VerifyBriefUseCase({
      ...depsWith({}),
      reviews: {} as VerifyBriefDependencies['reviews'],
    });
    expect(await missingMethod.verifyBrief(base.request)).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'missing-request-review',
    });
  });

  it('refuses a trailing-slash allowedPathPrefix such as src/ with path-escapes-allowed-prefixes', async () => {
    for (const prefix of ['src/', 'src//']) {
      const result = await verifyWith(fixture((manifest) => {
        manifest.allowedPathPrefixes = [prefix];
      }));
      expect(result).toEqual({
        outcome: 'refused', reason: 'path-escapes-allowed-prefixes', detail: 'invalid-allowed-prefix',
      });
    }
  });

  it('refuses a reviewer sharing a model family with the implementer, seat-plan, or author seat, and an unknown author model', async () => {
    // Same underlying family after provider path and tier suffix.
    const sameAsAssignment = await verifyWith(fixture((manifest) => {
      manifest.independentReviewer = 'provider/impl-model#low';
    }));
    expect(sameAsAssignment).toEqual({
      outcome: 'refused', reason: 'malformed-package', detail: 'reviewer-not-independent',
    });

    // Same family with a fix seat of the frozen plan.
    const sameAsSeatPlan = await verifyWith(fixture((manifest) => {
      manifest.seatPlan = {
        version: 1,
        'first-pass': [{ id: 'fp-1', model: 'impl-model', tool: 'opencode' }],
        fix: [{ id: 'fx-1', model: 'fixer-model', tool: 'agy' }],
        review: [{ id: 'rv-1', model: REVIEWER }],
      };
      manifest.independentReviewer = 'other/fixer-model@alt';
    }));
    expect(sameAsSeatPlan).toEqual({
      outcome: 'refused', reason: 'malformed-package', detail: 'reviewer-not-independent',
    });

    // Without the author model no independence is provable, so it refuses closed.
    const missingAssignment = await verifyWith(
      fixture((manifest) => { delete manifest.modelAssignment; }),
    );
    expect(missingAssignment).toEqual({
      outcome: 'refused', reason: 'malformed-package', detail: 'invalid-model-assignment',
    });

    // A distinct family still verifies.
    const independent = await verifyWith(fixture((manifest) => {
      manifest.seatPlan = {
        version: 1,
        'first-pass': [{ id: 'fp-1', model: 'impl-model', tool: 'opencode' }],
        fix: [{ id: 'fx-1', model: 'unrelated-model', tool: 'agy' }],
        review: [{ id: 'rv-1', model: REVIEWER }],
      };
    }));
    expect(independent.outcome).toBe('verified');
  });

  it('honours the manifest acceptance spec instead of an empty snapshot', async () => {
    // A manifest whose acceptance spec was removed (not merely emptied) is
    // refused as missing: with the spec read raw, the absence is what the
    // reader sees; the valid happy path above proves a real spec survives.
    const removed = await verifyWith(
      fixture((manifest) => { delete manifest.acceptanceSpec; }),
    );
    expect(removed).toEqual({
      outcome: 'refused', reason: 'malformed-package', detail: 'missing-acceptance-spec',
    });
  });

  it('returns unverified when the review result inherits outcome and receipt or traps a property access', async () => {
    const base = fixture();
    // Inherited outcome and receipt: `in` and property access would accept
    // this and reach verified; the plain-record read refuses it.
    const inherited = Object.create({
      outcome: 'receipt',
      receipt: receiptFor(base.briefDigest, 'passed'),
    });
    const inheritedResult = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve(inherited as unknown as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(inheritedResult).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'review-incomplete',
    });

    // A hostile proxy trap must never throw out of verifyBrief.
    const trapping = new Proxy({}, {
      get(_target, property) {
        if (property === 'outcome') {
          throw new Error('trap');
        }
        return undefined;
      },
    });
    const trappingResult = await new VerifyBriefUseCase(depsWith({
      reviews: () => Promise.resolve(trapping as unknown as ReviewRequestResult),
    })).verifyBrief(base.request);
    expect(trappingResult).toEqual({
      outcome: 'unverified', reason: 'review-unverified', detail: 'review-incomplete',
    });
  });
});
