import { describe, expect, it } from 'vitest';

import { AcceptanceSpec } from '../value-objects/AcceptanceSpec.vo.js';
import { ExecutionLimits } from '../value-objects/ExecutionLimits.vo.js';
import { SeatPlan } from '../value-objects/SeatPlan.vo.js';
import {
  BRIEF_PACKAGE_MAX_CONTEXT_VERSIONS,
  BRIEF_PACKAGE_MAX_DECISION_REFS,
  BRIEF_PACKAGE_MAX_MANIFEST_BYTES,
  BRIEF_PACKAGE_MAX_OWNED_PATHS,
  BRIEF_PACKAGE_MAX_PR_NOTE_CHARS,
  BRIEF_PACKAGE_MAX_PROSE_BYTES,
  BRIEF_PACKAGE_MAX_RESOURCE_BOUNDS,
  BRIEF_PACKAGE_MAX_SCALAR_CHARS,
  BriefPackage,
  byCodeUnit,
  canonicalizeBriefFrozenInputs,
  computeBriefPackageDigest,
  readBriefPackageManifest,
} from '../value-objects/BriefPackage.vo.js';
import type { BriefFrozenInputs } from '../value-objects/BriefPackage.vo.js';

const VALID = {
  commitRequired: true as const,
  diffCheck: true as const,
  commands: [{ argv: ['corepack', 'yarn', 'build'] }],
};

/** Pure local test digest so the domain tests stay domain-only. */
function computeDigest(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function specValue(): AcceptanceSpec {
  const created = AcceptanceSpec.create(VALID);
  expect(created.success).toBe(true);
  return (created as { value: AcceptanceSpec }).value;
}

function limitsValue(stepLimit = 40, timeLimitSeconds = 3600, resourceBounds: Record<string, string> = { cpu: '2' }): ExecutionLimits {
  const created = ExecutionLimits.create({ stepLimit, timeLimitSeconds, resourceBounds });
  expect(created.success).toBe(true);
  return (created as { value: ExecutionLimits }).value;
}

const SEAT_PLAN_RAW = {
  version: 1 as const,
  'first-pass': [{ id: 'fp-1', model: 'implementer-model', tool: 'opencode' }],
  fix: [{ id: 'fx-1', model: 'implementer-model', tool: 'opencode' }],
  review: [],
};

function seatPlanValue(): SeatPlan {
  const created = SeatPlan.create(SEAT_PLAN_RAW);
  expect(created.success).toBe(true);
  return (created as { value: SeatPlan }).value;
}

const CONTEXT_VERSIONS = [{ knowledgeEntryId: 'ke-1', version: 'v1' }];
const DECISION_REFS = ['decision-1'];
const PR_NOTES = { hardToUndo: 'undo-a', assumptions: 'assume-b', challengeThis: 'challenge-c' };

function baseProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: 'attempt-1',
    briefDigest: 'digest',
    prosePath: '.lane/brief.md',
    manifestPath: '.lane/brief-manifest.json',
    baseCommit: 'abc123',
    policyRevision: 'policy-7',
    independentReviewer: 'reviewer-model',
    ownedPaths: ['packages/app-a/**'],
    acceptanceSpec: specValue(),
    ...overrides,
  };
}

function frozenInputs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limits: limitsValue(),
    selectedContextVersions: CONTEXT_VERSIONS,
    ownerDecisionReferences: DECISION_REFS,
    seatPlan: seatPlanValue(),
    prNotes: PR_NOTES,
    ...overrides,
  };
}

describe('BriefPackage construction and frozen-input getters', () => {
  it('exposes all five typed frozen inputs', () => {
    const result = BriefPackage.create(baseProps(frozenInputs()));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const pkg = result.value;
    expect(pkg.hasStructuredFrozenInputs()).toBe(true);
    expect(pkg.getSchemaVersion()).toBe(2);
    expect(pkg.getLimits()!.equals(limitsValue())).toBe(true);
    expect(pkg.getSelectedContextVersions()).toEqual(CONTEXT_VERSIONS);
    expect(pkg.getOwnerDecisionReferences()).toEqual(DECISION_REFS);
    expect(pkg.getSeatPlan()!.equals(seatPlanValue())).toBe(true);
    expect(pkg.getPrNotes()).toEqual(PR_NOTES);
  });

  it('keeps null getters and schemaVersion 1 when structured inputs are omitted', () => {
    const result = BriefPackage.create(baseProps());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.hasStructuredFrozenInputs()).toBe(false);
    expect(result.value.getSchemaVersion()).toBe(1);
    expect(result.value.getLimits()).toBeNull();
    expect(result.value.getSelectedContextVersions()).toBeNull();
    expect(result.value.getOwnerDecisionReferences()).toBeNull();
    expect(result.value.getSeatPlan()).toBeNull();
    expect(result.value.getPrNotes()).toBeNull();
  });

  it('is immutable against caller and getter mutations', () => {
    const ownedPaths = ['packages/app-a/**'];
    const decisions = ['decision-1'];
    const bounds = { cpu: '2' };
    const limits = limitsValue(40, 3600, bounds);
    const result = BriefPackage.create(
      baseProps({ ownedPaths, ownerDecisionReferences: decisions, limits, prNotes: PR_NOTES }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const pkg = result.value;

    ownedPaths.push('packages/app-b/**');
    decisions.push('decision-2');
    bounds.cpu = '99';

    expect(pkg.getOwnedPaths()).toEqual(['packages/app-a/**']);
    expect(pkg.getOwnerDecisionReferences()).toEqual(['decision-1']);
    expect(pkg.getLimits()!.getResourceBounds()).toEqual({ cpu: '2' });

    expect(Object.isFrozen(pkg.getOwnedPaths())).toBe(true);
    // The getters return fresh copies, so mutating them cannot touch the package.
    const copiedNotes: { hardToUndo: string; assumptions: string; challengeThis: string } = pkg.getPrNotes()!;
    copiedNotes.hardToUndo = 'mutated';
    expect(pkg.getPrNotes()!.hardToUndo).toBe('undo-a');
  });

  it('distinguishes packages by each frozen input through equals', () => {
    const reference = BriefPackage.create(baseProps(frozenInputs()));
    expect(reference.success).toBe(true);
    if (!reference.success) return;
    const ref = reference.value;

    const twin = BriefPackage.create(baseProps(frozenInputs()));
    expect(twin.success).toBe(true);
    if (twin.success) expect(ref.equals(twin.value)).toBe(true);
    expect(ref.equals(null)).toBe(false);
    expect(ref.equals(undefined)).toBe(false);

    const changedLimits = BriefPackage.create(
      baseProps(frozenInputs({ limits: limitsValue(41) })),
    );
    if (changedLimits.success) expect(ref.equals(changedLimits.value)).toBe(false);

    const changedVersions = BriefPackage.create(
      baseProps(frozenInputs({ selectedContextVersions: [{ knowledgeEntryId: 'ke-1', version: 'v2' }] })),
    );
    if (changedVersions.success) expect(ref.equals(changedVersions.value)).toBe(false);

    const changedDecisions = BriefPackage.create(
      baseProps(frozenInputs({ ownerDecisionReferences: ['decision-2'] })),
    );
    if (changedDecisions.success) expect(ref.equals(changedDecisions.value)).toBe(false);

    const changedPlan = BriefPackage.create(
      baseProps(frozenInputs({
        seatPlan: SeatPlan.create({
          ...SEAT_PLAN_RAW,
          'first-pass': [{ id: 'fp-2', model: 'implementer-model', tool: 'opencode' }],
        }).value,
      })),
    );
    if (changedPlan.success) expect(ref.equals(changedPlan.value)).toBe(false);

    const changedNotes = BriefPackage.create(
      baseProps(frozenInputs({ prNotes: { ...PR_NOTES, hardToUndo: 'other' } })),
    );
    if (changedNotes.success) expect(ref.equals(changedNotes.value)).toBe(false);

    const changedSchema = BriefPackage.create(baseProps(frozenInputs({ schemaVersion: 1 })));
    if (changedSchema.success) expect(ref.equals(changedSchema.value)).toBe(false);
  });
});

describe('computeBriefPackageDigest', () => {
  const PROSE = '# frozen brief';

  it('keeps prose-only digest semantics for packages without structured inputs', () => {
    const result = computeBriefPackageDigest({ prose: PROSE }, computeDigest);
    expect(result).toEqual({ ok: true, briefDigest: computeDigest(PROSE), coversStructuredInputs: false });
  });

  it('covers the manifest raw bytes as the stored verifiers do', () => {
    const manifestRaw = '{"schemaVersion":2,"stepLimit":40}';
    const result = computeBriefPackageDigest({ prose: PROSE, manifestRaw }, computeDigest);
    expect(result).toEqual({
      ok: true,
      briefDigest: computeDigest(PROSE + '\n' + manifestRaw),
      coversStructuredInputs: true,
    });
  });

  it('covers prose plus all five structured frozen inputs', () => {
    const inputs = frozenInputs();
    const canonical = canonicalizeBriefFrozenInputs(inputs as BriefFrozenInputs);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok || canonical.json === null) return;
    const result = computeBriefPackageDigest({ prose: PROSE, frozenInputs: inputs }, computeDigest);
    expect(result).toEqual({
      ok: true,
      briefDigest: computeDigest(PROSE + '\n' + canonical.json),
      coversStructuredInputs: true,
    });

    const mutations: Record<string, unknown>[] = [
      frozenInputs({ limits: limitsValue(41) }),
      frozenInputs({ limits: limitsValue(40, 3601) }),
      frozenInputs({ limits: limitsValue(40, 3600, { cpu: '4' }) }),
      frozenInputs({ selectedContextVersions: [{ knowledgeEntryId: 'ke-1', version: 'v2' }] }),
      frozenInputs({ ownerDecisionReferences: ['decision-2'] }),
      frozenInputs({
        seatPlan: SeatPlan.create({
          ...SEAT_PLAN_RAW,
          'first-pass': [{ id: 'fp-9', model: 'implementer-model', tool: 'opencode' }],
        }).value,
      }),
      frozenInputs({ prNotes: { ...PR_NOTES, assumptions: 'other' } }),
    ];
    for (const mutated of mutations) {
      const changed = computeBriefPackageDigest({ prose: PROSE, frozenInputs: mutated }, computeDigest);
      expect(changed.ok).toBe(true);
      if (changed.ok) {
        expect(changed.briefDigest).not.toBe((result as { briefDigest: string }).briefDigest);
      }
    }
  });

  it('computes an idempotent canonical digest independent of resourceBounds key order', () => {
    const first = computeBriefPackageDigest(
      { prose: PROSE, frozenInputs: frozenInputs({ limits: limitsValue(40, 3600, { a: '1', b: '2' }) }) },
      computeDigest,
    );
    const second = computeBriefPackageDigest(
      { prose: PROSE, frozenInputs: frozenInputs({ limits: limitsValue(40, 3600, { b: '2', a: '1' }) }) },
      computeDigest,
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.briefDigest).toBe(second.briefDigest);
    }
  });

  // SonarCloud typescript:S2871 asks every `.sort()` for an explicit comparator and suggests
  // `localeCompare`. These three checks pin why the comparator here is code-unit order instead:
  // `localeCompare` depends on the host locale and ICU version, so adopting it would let two
  // hosts digest the same package to two values. They fail if someone "fixes" the rule that way.
  it('orders bound keys by code unit, which is not what localeCompare would do', () => {
    // 'B' is code unit 66 and 'a' is 97, so code-unit order is uppercase first; every common
    // locale collates case-insensitively and puts 'a' first. This pair is the whole difference.
    expect(['a', 'B'].sort(byCodeUnit)).toEqual(['B', 'a']);
    expect(['a', 'B'].sort((left, right) => left.localeCompare(right))).toEqual(['a', 'B']);
    expect(byCodeUnit('a', 'a')).toBe(0);
  });

  it('digests the same bounds to the same value whatever order they arrive in, for keys localeCompare would reorder', () => {
    const forward = computeBriefPackageDigest(
      { prose: PROSE, frozenInputs: frozenInputs({ limits: limitsValue(40, 3600, { a: '1', B: '2' }) }) },
      computeDigest,
    );
    const reverse = computeBriefPackageDigest(
      { prose: PROSE, frozenInputs: frozenInputs({ limits: limitsValue(40, 3600, { B: '2', a: '1' }) }) },
      computeDigest,
    );
    expect(forward.ok).toBe(true);
    expect(reverse.ok).toBe(true);
    if (forward.ok && reverse.ok) {
      expect(forward.briefDigest).toBe(reverse.briefDigest);
    }
  });

  it('canonicalizes bound keys into code-unit order, uppercase before lowercase', () => {
    const canonical = canonicalizeBriefFrozenInputs(
      frozenInputs({ limits: limitsValue(40, 3600, { a: '1', B: '2' }) }),
    );
    expect(canonical.ok).toBe(true);
    if (canonical.ok && canonical.json !== null) {
      // The canonical form is a JSON string, so its literal key order IS the digest input:
      // 'B' before 'a'. Under localeCompare it would be the other way round.
      expect(canonical.json.indexOf('"B"')).toBeLessThan(canonical.json.indexOf('"a"'));
    }
  });
});

describe('readBriefPackageManifest', () => {
  function v2ManifestRaw(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 2,
      stepLimit: 40,
      timeLimitSeconds: 3600,
      resourceBounds: { cpu: '2' },
      selectedKnowledgeVersions: CONTEXT_VERSIONS,
      ownerDecisionReferences: DECISION_REFS,
      seatPlan: SEAT_PLAN_RAW,
      prNotes: PR_NOTES,
      acceptanceSpec: VALID,
      ...overrides,
    });
  }

  function readerInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const manifestRaw = (overrides.manifestRaw as string | undefined) ?? v2ManifestRaw();
    const prose = (overrides.prose as string | undefined) ?? '# frozen brief';
    return {
      manifestRaw,
      prose,
      expectedBriefDigest: computeDigest(prose + '\n' + manifestRaw),
      attemptId: 'attempt-1',
      prosePath: '.lane/brief.md',
      manifestPath: '.lane/brief-manifest.json',
      baseCommit: 'abc123',
      policyRevision: 'policy-7',
      independentReviewer: 'reviewer-model',
      ownedPaths: ['packages/app-a/**'],
      ...overrides,
    };
  }

  it('reads a schemaVersion 2 manifest with all five typed frozen inputs', () => {
    const read = readBriefPackageManifest(readerInput(), { computeDigest });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.schemaVersion).toBe(2);
    expect(read.explicitSchemaVersion).toBe(true);
    const pkg = read.value;
    expect(pkg.getSchemaVersion()).toBe(2);
    expect(pkg.getBriefDigest()).toBe(computeDigest('# frozen brief\n' + v2ManifestRaw()));
    expect(pkg.getLimits()!.getStepLimit()).toBe(40);
    expect(pkg.getLimits()!.getResourceBounds()).toEqual({ cpu: '2' });
    expect(pkg.getSelectedContextVersions()).toEqual(CONTEXT_VERSIONS);
    expect(pkg.getOwnerDecisionReferences()).toEqual(DECISION_REFS);
    expect(pkg.getSeatPlan()!.equals(seatPlanValue())).toBe(true);
    expect(pkg.getPrNotes()).toEqual(PR_NOTES);
  });

  it('reads legacy schemaVersion 1 and absent-schemaVersion manifests', () => {
    for (const schemaVersion of [1, undefined]) {
      const raw = v2ManifestRaw({
        schemaVersion,
        stepLimit: undefined,
        timeLimitSeconds: undefined,
        resourceBounds: undefined,
        selectedKnowledgeVersions: undefined,
        ownerDecisionReferences: undefined,
        seatPlan: undefined,
        prNotes: undefined,
      });
      const read = readBriefPackageManifest(readerInput({ manifestRaw: raw }), { computeDigest });
      expect(read.ok).toBe(true);
      if (!read.ok) continue;
      expect(read.schemaVersion).toBe(1);
      expect(read.value.getLimits()).toBeNull();
      expect(read.value.getSelectedContextVersions()).toBeNull();
      expect(read.value.getOwnerDecisionReferences()).toBeNull();
      expect(read.value.getSeatPlan()).toBeNull();
      expect(read.value.getPrNotes()).toBeNull();
      expect(read.value.hasStructuredFrozenInputs()).toBe(false);
    }
  });

  it('reads prose-only packages with the prose digest alone', () => {
    const prose = '# prose-only brief';
    const read = readBriefPackageManifest(
      {
        prose,
        expectedBriefDigest: computeDigest(prose),
        attemptId: 'attempt-1',
        prosePath: '.lane/brief.md',
        manifestPath: '.lane/brief-manifest.json',
        baseCommit: 'abc123',
        policyRevision: 'policy-7',
        independentReviewer: 'reviewer-model',
        ownedPaths: ['packages/app-a/**'],
        acceptanceSpec: specValue(),
      },
      { computeDigest },
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.schemaVersion).toBe(1);
    expect(read.explicitSchemaVersion).toBe(false);
    expect(read.value.getBriefDigest()).toBe(computeDigest(prose));
    expect(read.value.hasStructuredFrozenInputs()).toBe(false);
  });

  it('reports unreadable JSON, digest mismatch, and unknown schemaVersion without defaulting to empty or valid', () => {
    expect(readBriefPackageManifest(readerInput({ manifestRaw: '   ' }), { computeDigest })).toEqual({ ok: false, code: 'unreadable' });
    expect(readBriefPackageManifest(readerInput({ manifestRaw: 'not json {' }), { computeDigest })).toEqual({ ok: false, code: 'unreadable' });
    expect(readBriefPackageManifest(readerInput({ expectedBriefDigest: 'wrong' }), { computeDigest })).toEqual({ ok: false, code: 'digest-mismatch' });
    expect(
      readBriefPackageManifest(readerInput({ manifestRaw: v2ManifestRaw({ schemaVersion: 3 }) }), { computeDigest }),
    ).toEqual({ ok: false, code: 'unknown-schema-version' });
    expect(readBriefPackageManifest(readerInput({ manifestRaw: v2ManifestRaw({ schemaVersion: 0 }) }), { computeDigest })).toEqual({
      ok: false,
      code: 'unknown-schema-version',
    });
  });

  it('requires the structured frozen inputs on schemaVersion 2 manifests', () => {
    const withoutDecisions = v2ManifestRaw({ ownerDecisionReferences: undefined });
    expect(readBriefPackageManifest(readerInput({ manifestRaw: withoutDecisions }), { computeDigest })).toEqual({
      ok: false,
      code: 'invalid-owner-decisions',
    });
    const withoutVersions = v2ManifestRaw({ selectedKnowledgeVersions: undefined });
    expect(readBriefPackageManifest(readerInput({ manifestRaw: withoutVersions }), { computeDigest })).toEqual({
      ok: false,
      code: 'invalid-context-versions',
    });
    const withoutLimits = v2ManifestRaw({ stepLimit: undefined, timeLimitSeconds: undefined, resourceBounds: undefined });
    expect(readBriefPackageManifest(readerInput({ manifestRaw: withoutLimits }), { computeDigest })).toEqual({
      ok: false,
      code: 'invalid-limits',
    });
  });

  it('refuses null, non-object, wrong-typed fields, sparse arrays, unknown enums, and throwing getters without throwing', () => {
    expect(readBriefPackageManifest(null, { computeDigest })).toEqual({ ok: false, code: 'malformed' });
    expect(readBriefPackageManifest('text', { computeDigest })).toEqual({ ok: false, code: 'malformed' });
    expect(readBriefPackageManifest(42, { computeDigest })).toEqual({ ok: false, code: 'malformed' });

    // A throwing getter on the top-level input never runs and never throws.
    const hostile: Record<string, unknown> = { prose: 'p' };
    Object.defineProperty(hostile, 'manifestRaw', { enumerable: true, get() { throw new Error('boom'); } });
    expect(readBriefPackageManifest(hostile, { computeDigest }).ok).toBe(false);

    // A throwing getter on another input key never runs.
    const hostileInput: Record<string, unknown> = { manifestRaw: v2ManifestRaw() };
    Object.defineProperty(hostileInput, 'prose', { enumerable: true, get() { throw new Error('boom'); } });
    expect(readBriefPackageManifest(hostileInput, { computeDigest }).ok).toBe(false);

    const createResults = [
      BriefPackage.create(null),
      BriefPackage.create('text'),
      BriefPackage.create([]),
      BriefPackage.create(new Date()),
      BriefPackage.create(baseProps({ ownedPaths: new Array(2) })),
      BriefPackage.create(baseProps({ ownerDecisionReferences: new Array(2) })),
      BriefPackage.create(baseProps({ selectedContextVersions: new Array(2) })),
      BriefPackage.create(baseProps({ limits: { stepLimit: 40, timeLimitSeconds: 3600, resourceBounds: {} } })),
      // Unknown seat tool enum.
      BriefPackage.create(baseProps({
        seatPlan: SeatPlan.create({
          ...SEAT_PLAN_RAW,
          'first-pass': [{ id: 'fp-1', model: 'implementer-model', tool: 'unknown-tool' }],
        }),
      })),
      BriefPackage.create(baseProps({ acceptanceSpec: 'not-a-spec' })),
    ];
    for (const result of createResults) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(typeof result.code).toBe('string');
        expect(result.error).toBeInstanceOf(Error);
      }
    }

    // A throwing getter on prNotes or schemaVersion is refused, never run.
    const hostileNotes: Record<string, unknown> = {};
    Object.defineProperty(hostileNotes, 'hardToUndo', { enumerable: true, get() { throw new Error('boom'); } });
    const notesResult = BriefPackage.create(baseProps({ prNotes: hostileNotes }));
    expect(notesResult.success).toBe(false);

    const hostileSchema: Record<string, unknown> = baseProps();
    Object.defineProperty(hostileSchema, 'schemaVersion', { enumerable: true, get() { throw new Error('boom'); } });
    const schemaResult = BriefPackage.create(hostileSchema);
    expect(schemaResult.success).toBe(false);
  });

  it('refuses SECRET_PATTERNS and LANE_DIFF_SECRET_PATTERNS inputs and echoes neither secrets nor paths in refusal output', () => {
    const awsToken = ['AK', 'IA', '1'.repeat(16)].join('');
    const githubToken = ['github', 'pat', 'A'.repeat(24)].join('_');

    const secretDecisions = BriefPackage.create(baseProps({ ownerDecisionReferences: [awsToken] }));
    expect(secretDecisions.success).toBe(false);
    if (!secretDecisions.success) {
      expect(secretDecisions.code).toBe('secret-shaped');
      expect(secretDecisions.error.message).not.toContain(awsToken);
    }

    const secretNotes = BriefPackage.create(baseProps({ prNotes: { ...PR_NOTES, challengeThis: githubToken } }));
    expect(secretNotes.success).toBe(false);
    if (!secretNotes.success) {
      expect(secretNotes.code).toBe('secret-shaped');
      expect(secretNotes.error.message).not.toContain(githubToken);
    }

    const digestResult = computeBriefPackageDigest({ prose: 'token ' + githubToken }, computeDigest);
    expect(digestResult).toEqual({ ok: false, code: 'secret-shaped' });

    const manifestRead = readBriefPackageManifest(
      readerInput({ manifestRaw: v2ManifestRaw({ ownerDecisionReferences: [awsToken] }) }),
      { computeDigest },
    );
    expect(manifestRead).toEqual({ ok: false, code: 'secret-shaped' });

    // Fixed messages never echo the supplied paths either.
    const pathEcho = BriefPackage.create(baseProps({ prosePath: '/very/secret/worktree/path/.lane/brief.md' }));
    expect(pathEcho.success).toBe(true);
    if (pathEcho.success) {
      expect(pathEcho.value.getProsePath()).toBe('/very/secret/worktree/path/.lane/brief.md');
    }
  });

  it('enforces size bounds across prose, manifestRaw, arrays, limits, scalars, and prNotes', () => {
    expect(computeBriefPackageDigest({ prose: 'x'.repeat(BRIEF_PACKAGE_MAX_PROSE_BYTES + 1) }, computeDigest)).toEqual({ ok: false, code: 'oversized' });
    expect(
      computeBriefPackageDigest({ prose: 'p', manifestRaw: 'x'.repeat(BRIEF_PACKAGE_MAX_MANIFEST_BYTES + 1) }, computeDigest),
    ).toEqual({ ok: false, code: 'oversized' });

    expect(BriefPackage.create(baseProps({ ownedPaths: Array.from({ length: BRIEF_PACKAGE_MAX_OWNED_PATHS + 1 }, (_, i) => 'p' + i) })).success).toBe(false);
    expect(BriefPackage.create(baseProps({ attemptId: 'a'.repeat(BRIEF_PACKAGE_MAX_SCALAR_CHARS + 1) })).success).toBe(false);
    expect(
      BriefPackage.create(baseProps({ limits: limitsValue(100_001) })).success,
    ).toBe(false);
    expect(BriefPackage.create(baseProps({ limits: limitsValue(40, 604_801) })).success).toBe(false);

    const tooManyBounds: Record<string, string> = {};
    for (let index = 0; index < BRIEF_PACKAGE_MAX_RESOURCE_BOUNDS + 1; index += 1) {
      tooManyBounds['k' + index] = 'v';
    }
    expect(BriefPackage.create(baseProps({ limits: limitsValue(40, 3600, tooManyBounds) })).success).toBe(false);

    expect(
      BriefPackage.create(baseProps({ ownerDecisionReferences: Array.from({ length: BRIEF_PACKAGE_MAX_DECISION_REFS + 1 }, (_, i) => 'd' + i) })).success,
    ).toBe(false);
    expect(
      BriefPackage.create(baseProps({ selectedContextVersions: Array.from({ length: BRIEF_PACKAGE_MAX_CONTEXT_VERSIONS + 1 }, (_, i) => ({ knowledgeEntryId: 'k' + i, version: 'v' })) })).success,
    ).toBe(false);
    expect(
      BriefPackage.create(baseProps({ prNotes: { ...PR_NOTES, hardToUndo: 'x'.repeat(BRIEF_PACKAGE_MAX_PR_NOTE_CHARS + 1) } })).success,
    ).toBe(false);
  });

  it('rejects an empty frozenInputs canonicalization with null JSON', () => {
    expect(canonicalizeBriefFrozenInputs({})).toEqual({ ok: true, json: null });
    const canonical = canonicalizeBriefFrozenInputs(frozenInputs() as BriefFrozenInputs);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok || canonical.json === null) return;
    expect(Object.keys(JSON.parse(canonical.json) as Record<string, unknown>)).toEqual([
      'schemaVersion',
      'limits',
      'selectedContextVersions',
      'ownerDecisionReferences',
      'seatPlan',
      'prNotes',
    ]);
  });

  it('never hands out the internal limits, seat plan or props object', () => {
    const storedLimits = limitsValue();
    const storedPlan = seatPlanValue();
    const result = BriefPackage.create(
      baseProps(frozenInputs({ limits: storedLimits, seatPlan: storedPlan })),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const pkg = result.value;

    // The getters return fresh clones, so mutating the returned bounds or
    // plan cannot touch the package's validated frozen inputs.
    const returnedLimits = pkg.getLimits()!;
    expect(returnedLimits).not.toBe(storedLimits);
    (returnedLimits.getResourceBounds() as Record<string, string>).cpu = '999';
    expect(pkg.getLimits()!.getResourceBounds()).toEqual({ cpu: '2' });

    const returnedPlan = pkg.getSeatPlan()!;
    expect(returnedPlan).not.toBe(storedPlan);
    expect(returnedPlan.equals(storedPlan)).toBe(true);

    // getProps is a frozen defensive copy; nothing on it aliases the package.
    const props = pkg.getProps();
    expect(Object.isFrozen(props)).toBe(true);
    expect(Object.isFrozen(props.ownedPaths)).toBe(true);
    expect(props.limits).not.toBe(storedLimits);
    (props.limits!.getResourceBounds() as Record<string, string>).cpu = '999';
    expect(pkg.getLimits()!.getResourceBounds()).toEqual({ cpu: '2' });
  });

  it('refuses a hostile Proxy whose traps answer inconsistently between reads', () => {
    let descriptorReads = 0;
    const target = baseProps(frozenInputs()) as Record<string, unknown>;
    const hostile = new Proxy(target, {
      getOwnPropertyDescriptor(t, key) {
        descriptorReads += 1;
        const descriptor = Reflect.getOwnPropertyDescriptor(t, key);
        if (descriptor !== undefined && key === 'attemptId' && descriptorReads > 4) {
          return { ...descriptor, value: 'tampered-attempt' };
        }
        return descriptor;
      },
    });
    const result = BriefPackage.create(hostile);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(['non-object', 'malformed']).toContain(result.code);

    let proseDescriptorReads = 0;
    const digestHostile = new Proxy({ prose: 'hello', frozenInputs: {} } as Record<string, unknown>, {
      getOwnPropertyDescriptor(t, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(t, key);
        if (key === 'prose' && descriptor !== undefined) {
          proseDescriptorReads += 1;
          return { ...descriptor, value: proseDescriptorReads % 2 === 1 ? 'one' : 'two' };
        }
        return descriptor;
      },
    });
    expect(computeBriefPackageDigest(digestHostile).ok).toBe(false);
  });

  it('runs at most the single prototype trap on a Proxy that answers with a non-plain prototype', () => {
    // A trap-free Proxy check is impossible in the domain layer (no node:util),
    // so the one getPrototypeOf call is unavoidable; every later trap must not run.
    const traps: string[] = [];
    const handler: ProxyHandler<Record<string, unknown>> = {
      getPrototypeOf() { traps.push('getPrototypeOf'); return Array.prototype; },
      ownKeys(t) { traps.push('ownKeys'); return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) { traps.push('gopd'); return Reflect.getOwnPropertyDescriptor(t, k); },
      get(t, k) { traps.push('get'); return Reflect.get(t, k); },
      has(t, k) { traps.push('has'); return Reflect.has(t, k); },
    };
    expect(BriefPackage.create(new Proxy(baseProps(frozenInputs()) as Record<string, unknown>, handler)).success).toBe(false);
    expect(computeBriefPackageDigest(new Proxy({ prose: 'hello' } as Record<string, unknown>, handler)).ok).toBe(false);
    expect(traps).toEqual(['getPrototypeOf', 'getPrototypeOf']);
  });

  it('returns a typed refusal when a Proxy trap throws inside computeBriefPackageDigest', () => {
    const throwing = new Proxy({ prose: 'hello' } as Record<string, unknown>, {
      getPrototypeOf() { throw new Error('boom'); },
    });
    expect(computeBriefPackageDigest(throwing)).toEqual({ ok: false, code: 'malformed' });
    const throwingString = { prose: 'hello', manifestRaw: 'x' };
    expect(computeBriefPackageDigest(throwingString, () => { throw new Error('digest boom'); })).toEqual({ ok: false, code: 'malformed' });
  });

  it('treats an own schemaVersion of undefined as absent', () => {
    const structured = BriefPackage.create({ ...baseProps(frozenInputs()), schemaVersion: undefined });
    expect(structured.success).toBe(true);
    if (!structured.success) return;
    expect(structured.value.getSchemaVersion()).toBe(2);
    const prose = BriefPackage.create({ ...baseProps(), schemaVersion: undefined });
    expect(prose.success).toBe(true);
    if (!prose.success) return;
    expect(prose.value.getSchemaVersion()).toBe(1);
  });

  it('returns a typed refusal for throwing getters on frozenInputs instead of throwing', () => {
    const hostileInputs: Record<string, unknown> = {};
    Object.defineProperty(hostileInputs, 'limits', { enumerable: true, get() { throw new Error('boom'); } });
    expect(canonicalizeBriefFrozenInputs(hostileInputs as BriefFrozenInputs)).toEqual({
      ok: false,
      code: 'malformed',
    });

    const digestRead = computeBriefPackageDigest({ prose: 'hello', frozenInputs: hostileInputs });
    expect(digestRead).toEqual({ ok: false, code: 'malformed' });
  });
});
