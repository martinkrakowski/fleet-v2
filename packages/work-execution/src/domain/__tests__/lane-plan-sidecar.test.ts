import { describe, expect, it } from 'vitest';

import {
  canonicalLanePlanSidecarJson,
  parseLanePlanSidecar,
} from '../lane-plan-sidecar.js';

/**
 * Secret-shaped fakes are assembled at runtime from inert pieces so this file
 * never contains a credential-shaped literal.
 */
function fakeSecretShape(): string {
  return `gh${'p_'}${'A'.repeat(30)}`;
}

const VALID = {
  schemaVersion: 1,
  projectId: 'example-project',
  planId: '2026-10-27_example',
  revision: 3,
  doc: 'docs/planning/2026-10-27_example-plan.md',
  lanes: [
    {
      laneId: 'A1',
      scope: 'Records',
      packages: ['work-execution'],
      sharedFiles: ['.architecture/manifest.yaml'],
      tier: 2,
      after: [],
      decisions: ['D1'],
    },
    {
      laneId: 'A2',
      renamedFrom: 'A-two',
      scope: 'Stores',
      packages: ['work-execution'],
      tier: 2,
      after: ['A1', 'other-plan/B1', 'other-project/third-plan/C1'],
      brief: '.lane/brief-a2.md',
    },
    {
      laneId: 'A3',
      scope: 'Docs',
      packages: ['docs'],
      tier: 0,
      after: [],
      status: 'dropped',
      mergedPr: { repository: 'example-org/example-repo', number: 251 },
    },
  ],
  decisions: [{ id: 'D1', question: 'Which store?', default: 'A file store', state: 'open' }],
  exclusiveOrder: [{ file: '.architecture/manifest.yaml', lanes: ['A1', 'A2'] }],
};

function refusedErrors(input: unknown): readonly string[] {
  const result = parseLanePlanSidecar(input);
  if (result.ok) {
    throw new Error('expected parse failure');
  }
  return result.errors;
}

function cloneValid(): Record<string, unknown> {
  return structuredClone(VALID) as Record<string, unknown>;
}

function withLane(index: number, patch: Record<string, unknown>): unknown {
  const copy = cloneValid();
  const lanes = copy.lanes as Record<string, unknown>[];
  Object.assign(lanes[index], patch);
  return copy;
}

describe('parseLanePlanSidecar', () => {
  it('accepts VALID and normalises it', () => {
    const result = parseLanePlanSidecar(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sidecar).toEqual({
      schemaVersion: 1,
      projectId: 'example-project',
      planId: '2026-10-27_example',
      revision: 3,
      doc: 'docs/planning/2026-10-27_example-plan.md',
      lanes: [
        {
          laneId: 'A1',
          renamedFrom: null,
          scope: 'Records',
          packages: ['work-execution'],
          sharedFiles: ['.architecture/manifest.yaml'],
          tier: 2,
          after: [],
          decisions: ['D1'],
          status: 'planned',
          brief: null,
          mergedPr: null,
        },
        {
          laneId: 'A2',
          renamedFrom: 'A-two',
          scope: 'Stores',
          packages: ['work-execution'],
          sharedFiles: [],
          tier: 2,
          after: [
            { projectId: 'example-project', planId: '2026-10-27_example', laneId: 'A1' },
            { projectId: 'example-project', planId: 'other-plan', laneId: 'B1' },
            { projectId: 'other-project', planId: 'third-plan', laneId: 'C1' },
          ],
          decisions: [],
          status: 'planned',
          brief: '.lane/brief-a2.md',
          mergedPr: null,
        },
        {
          laneId: 'A3',
          renamedFrom: null,
          scope: 'Docs',
          packages: ['docs'],
          sharedFiles: [],
          tier: 0,
          after: [],
          decisions: [],
          status: 'dropped',
          brief: null,
          mergedPr: { repository: 'example-org/example-repo', number: 251 },
        },
      ],
      decisions: [{ id: 'D1', question: 'Which store?', default: 'A file store', state: 'open' }],
      exclusiveOrder: [{ file: '.architecture/manifest.yaml', lanes: ['A1', 'A2'] }],
    });
  });

  it('never mutates or aliases input', () => {
    const before = structuredClone(VALID);
    const result = parseLanePlanSidecar(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(VALID).toEqual(before);
    expect(result.sidecar.lanes).not.toBe(VALID.lanes);
    expect(result.sidecar.lanes[0]).not.toBe(VALID.lanes[0]);
    expect(result.sidecar.lanes[0].packages).not.toBe(VALID.lanes[0].packages);
    expect(result.sidecar.lanes[0].sharedFiles).not.toBe(VALID.lanes[0].sharedFiles);
    expect(result.sidecar.decisions).not.toBe(VALID.decisions);
    expect(result.sidecar.exclusiveOrder).not.toBe(VALID.exclusiveOrder);
  });

  it('refuses unknown root, lane and mergedPr keys', () => {
    expect(refusedErrors({ ...VALID, extraRoot: 1 })).toEqual(['sidecar: unknown key']);
    expect(refusedErrors(withLane(1, { extraLane: 1 }))).toEqual(['lanes[1]: unknown key']);
    const withPrKey = cloneValid();
    const pr = (withPrKey.lanes as Record<string, unknown>[])[2].mergedPr as Record<string, unknown>;
    pr.extraPr = 1;
    expect(refusedErrors(withPrKey)).toEqual(['lanes[2].mergedPr: unknown key']);
  });

  it('reports missing required keys in table order', () => {
    const withoutPlanIdAndLanes = cloneValid();
    delete (withoutPlanIdAndLanes as Record<string, unknown>).planId;
    delete (withoutPlanIdAndLanes as Record<string, unknown>).lanes;
    expect(refusedErrors(withoutPlanIdAndLanes)).toEqual([
      'sidecar.planId: required',
      'sidecar.lanes: required',
    ]);
  });

  it.each([
    [{ ...VALID, schemaVersion: 2 }, ['sidecar.schemaVersion: must be 1']],
    [{ ...VALID, revision: 0 }, ['sidecar.revision: must be a positive integer']],
    [{ ...VALID, revision: 1.5 }, ['sidecar.revision: must be a positive integer']],
    [{ ...VALID, revision: '3' }, ['sidecar.revision: must be a positive integer']],
    [withLane(0, { tier: 3 }), ['lanes[0].tier: must be 0, 1 or 2']],
    [withLane(0, { status: 'paused' }), ['lanes[0].status: must be one of planned, deferred, dropped']],
    [withDecisionState('maybe'), ['decisions[0].state: must be one of open, decided']],
    [{ ...VALID, lanes: [] }, ['sidecar.lanes: must not be empty']],
    [withLane(0, { packages: [] }), ['lanes[0].packages: must not be empty']],
    [withLane(0, { packages: ['Work_Execution'] }), ['lanes[0].packages[0]: must be a package name']],
  ])('refuses types and enums %j as %j', (input, expected) => {
    expect(refusedErrors(input)).toEqual(expected);
  });

  it.each([
    ['\n'],
    ['\u0007'],
    ['\u202e'],
    ['   '],
    ['x'.repeat(301)],
  ])('refuses scope %j', (scope) => {
    expect(refusedErrors(withLane(0, { scope }))).toEqual([
      'lanes[0].scope: must be plain text of at most 300 bytes',
    ]);
  });

  it('accepts a 300-byte scope and refuses a 301-byte one', () => {
    expect(parseLanePlanSidecar(withLane(0, { scope: 'é'.repeat(150) })).ok).toBe(true);
    expect(refusedErrors(withLane(0, { scope: 'é'.repeat(151) }))).toEqual([
      'lanes[0].scope: must be plain text of at most 300 bytes',
    ]);
  });

  it.each([
    ['/etc/x'],
    ['a/../b'],
    ['a//b'],
    ['./a'],
    ['a\\b'],
    ['a b'],
  ])('refuses doc %j', (doc) => {
    expect(refusedErrors({ ...VALID, doc })).toEqual(['sidecar.doc: must be a relative path']);
  });

  it('accepts a relative brief', () => {
    expect(parseLanePlanSidecar(withLane(1, { brief: '.lane/brief.md' })).ok).toBe(true);
  });

  it('refuses secret-shaped strings from both registries without echoing the value', () => {
    const scopeErrors = refusedErrors(withLane(0, { scope: fakeSecretShape() }));
    expect(scopeErrors).toEqual(['lanes[0].scope: contains a secret-shaped value and was refused']);
    expect(scopeErrors.join('\n')).not.toContain(fakeSecretShape());

    expect(refusedErrors({
      ...VALID,
      decisions: [{ id: 'D1', question: fakeSecretShape(), default: 'A file store', state: 'open' }],
    })).toEqual(['decisions[0].question: contains a secret-shaped value and was refused']);

    expect(refusedErrors(withLane(1, { after: [fakeSecretShape()] }))).toEqual([
      'lanes[1].after[0]: contains a secret-shaped value and was refused',
    ]);

    const githubPat = `github${'_pat_'}${'A'.repeat(24)}`;
    expect(refusedErrors(withLane(0, { scope: githubPat }))).toEqual([
      'lanes[0].scope: contains a secret-shaped value and was refused',
    ]);
    expect(parseLanePlanSidecar(withLane(0, { scope: 'plain scope' })).ok).toBe(true);
  });

  it.each([
    ['a/b/c/d'],
    [''],
    ['/A1'],
    ['A1/'],
  ])('refuses malformed after %j', (afterEntry) => {
    expect(refusedErrors(withLane(1, { after: [afterEntry] }))).toEqual([
      'lanes[1].after[0]: must be <laneId>, <planId>/<laneId> or <projectId>/<planId>/<laneId>',
    ]);
  });

  it('refuses a repeated after reference', () => {
    expect(refusedErrors(withLane(1, { after: ['A1', 'A1'] }))).toEqual([
      'lanes[1].after[1]: is a duplicate',
    ]);
  });

  it('accepts same-plan after forms resolving to A1', () => {
    for (const form of ['2026-10-27_example/A1', 'example-project/2026-10-27_example/A1']) {
      const result = parseLanePlanSidecar(withLane(1, { after: [form] }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.sidecar.lanes[1].after).toEqual([
        { projectId: 'example-project', planId: '2026-10-27_example', laneId: 'A1' },
      ]);
    }
  });

  it('refuses an after that names its own lane', () => {
    expect(refusedErrors(withLane(1, { after: ['A2'] }))).toEqual([
      'lanes[1].after[0]: names its own lane',
    ]);
  });

  it('refuses an after that names no lane in this plan', () => {
    expect(refusedErrors(withLane(1, { after: ['A9'] }))).toEqual([
      'lanes[1].after[0]: names no lane in this plan',
    ]);
  });

  it('accepts an after naming another plan', () => {
    expect(parseLanePlanSidecar(withLane(1, { after: ['other-plan/A9'] })).ok).toBe(true);
  });

  it('refuses a repeated lane id', () => {
    const twoLanes: Record<string, unknown> = {
      schemaVersion: 1,
      projectId: 'example-project',
      planId: '2026-10-27_example',
      revision: 1,
      doc: 'docs/planning/2026-10-27_example-plan.md',
      lanes: [
        { laneId: 'A1', scope: 'One', packages: ['work-execution'], tier: 2, after: [] },
        { laneId: 'A1', scope: 'Two', packages: ['work-execution'], tier: 2, after: [] },
      ],
    };
    expect(refusedErrors(twoLanes)).toEqual(['lanes[1].laneId: is a duplicate']);
  });

  it('refuses renamedFrom naming its own lane', () => {
    expect(refusedErrors(withLane(1, { renamedFrom: 'A2' }))).toEqual([
      'lanes[1].renamedFrom: names its own lane',
    ]);
  });

  it('refuses renamedFrom naming a current lane', () => {
    expect(refusedErrors(withLane(1, { renamedFrom: 'A1' }))).toEqual([
      'lanes[1].renamedFrom: names a current lane',
    ]);
  });

  it('refuses a lane decision naming no decision in this plan', () => {
    expect(refusedErrors(withLane(0, { decisions: ['D9'] }))).toEqual([
      'lanes[0].decisions[0]: names no decision in this plan',
    ]);
  });

  it('refuses a repeated decision id', () => {
    const copy = cloneValid();
    (copy.decisions as Record<string, unknown>[]).push({ id: 'D1', question: 'Q?', default: 'D', state: 'open' });
    expect(refusedErrors(copy)).toEqual(['decisions[1].id: is a duplicate']);
  });

  it('refuses a repeated mergedPr', () => {
    const copy = cloneValid();
    (copy.lanes as Record<string, unknown>[])[0].mergedPr = { repository: 'example-org/example-repo', number: 251 };
    expect(refusedErrors(copy)).toEqual(['lanes[2].mergedPr: is a duplicate']);
  });

  it('refuses an exclusiveOrder with one lane and a lane not in the plan', () => {
    expect(refusedErrors({ ...VALID, exclusiveOrder: [{ file: '.architecture/manifest.yaml', lanes: ['A1'] }] }))
      .toEqual(['exclusiveOrder[0].lanes: must name at least two lanes']);
    expect(refusedErrors({ ...VALID, exclusiveOrder: [{ file: '.architecture/manifest.yaml', lanes: ['A1', 'A9'] }] }))
      .toEqual(['exclusiveOrder[0].lanes[1]: names no lane in this plan']);
  });

  it('refuses a repeated exclusiveOrder file', () => {
    const copy = cloneValid();
    (copy.exclusiveOrder as Record<string, unknown>[]).push({ file: '.architecture/manifest.yaml', lanes: ['A2', 'A3'] });
    expect(refusedErrors(copy)).toEqual(['exclusiveOrder[1].file: is a duplicate']);
  });

  it('refuses too many lanes and too many after entries', () => {
    const manyLanes: Record<string, unknown> = {
      schemaVersion: 1,
      projectId: 'example-project',
      planId: '2026-10-27_example',
      revision: 3,
      doc: 'docs/planning/2026-10-27_example-plan.md',
      lanes: [],
    };
    const manyLanesList = manyLanes.lanes as unknown[];
    for (let index = 0; index < 301; index += 1) {
      manyLanesList.push({ laneId: `L${index}`, scope: 'S', packages: ['work-execution'], tier: 2, after: [] });
    }
    expect(refusedErrors(manyLanes)).toEqual(['sidecar.lanes: has too many entries']);

    const manyAfter = withLane(0, { after: Array(33).fill('A2') });
    expect(refusedErrors(manyAfter)).toEqual(['lanes[0].after: has too many entries']);
  });

  it('caps errors at 50 with a trailing marker', () => {
    const copy: Record<string, unknown> = {
      schemaVersion: 1,
      projectId: 'example-project',
      planId: '2026-10-27_example',
      revision: 3,
      doc: 'docs/planning/2026-10-27_example-plan.md',
      lanes: [],
    };
    const lanesList = copy.lanes as unknown[];
    for (let index = 0; index < 60; index += 1) {
      lanesList.push({ laneId: `L${index}`, scope: 'x'.repeat(301), packages: ['work-execution'], tier: 2, after: [] });
    }
    const errors = refusedErrors(copy);
    expect(errors).toHaveLength(50);
    expect(errors[49]).toBe('sidecar: more errors not shown');
    expect(errors.slice(0, 49).every((error) => error.endsWith('scope: must be plain text of at most 300 bytes'))).toBe(true);
  });

  it('handles hostile input without throwing or running getters', () => {
    let getterCalls = 0;
    const laneWithGetter = {
      get laneId() {
        getterCalls += 1;
        return 'A1';
      },
      scope: 'Records',
      packages: ['work-execution'],
      tier: 2,
      after: [],
    };
    const withHostileLane = cloneValid();
    (withHostileLane.lanes as unknown[])[1] = laneWithGetter;
    const getterResult = parseLanePlanSidecar(withHostileLane);
    expect(getterResult.ok).toBe(false);
    expect(getterCalls).toBe(0);

    const withProxyLane = cloneValid();
    (withProxyLane.lanes as unknown[])[1] = new Proxy({}, { ownKeys() { throw new Error('boom'); } });
    expect(parseLanePlanSidecar(withProxyLane).ok).toBe(false);

    const withCustomProto = cloneValid();
    (withCustomProto.lanes as unknown[])[1] = Object.create({ laneId: 'A1' });
    expect(parseLanePlanSidecar(withCustomProto).ok).toBe(false);

    expect(refusedErrors(null)).toEqual(['sidecar: must be an object']);
    expect(refusedErrors([])).toEqual(['sidecar: must be an object']);
    expect(refusedErrors('x')).toEqual(['sidecar: must be an object']);
  });

  it('produces canonical JSON independent of key order and defaults', () => {
    const result = parseLanePlanSidecar(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const canonical = canonicalLanePlanSidecarJson(result.sidecar);
    expect(canonical.startsWith('{"schemaVersion":1,"projectId":"example-project","planId":"2026-10-27_example","revision":3,')).toBe(true);
    const reversedResult = parseLanePlanSidecar(reversedSpelledOut());
    expect(reversedResult.ok).toBe(true);
    if (!reversedResult.ok) return;
    expect(canonical).toBe(canonicalLanePlanSidecarJson(reversedResult.sidecar));
    expect(canonicalLanePlanSidecarJson({ ...result.sidecar, revision: 4 })).not.toBe(canonical);
  });
});

function withDecisionState(state: string): unknown {
  const copy = cloneValid();
  const decisions = copy.decisions as Record<string, unknown>[];
  decisions[0].state = state;
  return copy;
}

function reversedSpelledOut(): unknown {
  return {
    exclusiveOrder: [{ lanes: ['A1', 'A2'], file: '.architecture/manifest.yaml' }],
    decisions: [{ state: 'open', default: 'A file store', question: 'Which store?', id: 'D1' }],
    lanes: [
      {
        mergedPr: null,
        brief: null,
        status: 'planned',
        decisions: ['D1'],
        after: [],
        tier: 2,
        sharedFiles: ['.architecture/manifest.yaml'],
        packages: ['work-execution'],
        scope: 'Records',
        renamedFrom: null,
        laneId: 'A1',
      },
      {
        mergedPr: null,
        brief: '.lane/brief-a2.md',
        status: 'planned',
        decisions: [],
        after: ['A1', 'other-plan/B1', 'other-project/third-plan/C1'],
        tier: 2,
        sharedFiles: [],
        packages: ['work-execution'],
        scope: 'Stores',
        renamedFrom: 'A-two',
        laneId: 'A2',
      },
      {
        mergedPr: { number: 251, repository: 'example-org/example-repo' },
        brief: null,
        status: 'dropped',
        decisions: [],
        after: [],
        tier: 0,
        sharedFiles: [],
        packages: ['docs'],
        scope: 'Docs',
        renamedFrom: null,
        laneId: 'A3',
      },
    ],
    doc: 'docs/planning/2026-10-27_example-plan.md',
    revision: 3,
    planId: '2026-10-27_example',
    projectId: 'example-project',
    schemaVersion: 1,
  };
}
