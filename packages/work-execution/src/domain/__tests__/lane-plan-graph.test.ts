import { describe, expect, it } from 'vitest';

import {
  findLanePlanCycle,
  formatLanePlanCycle,
} from '../lane-plan-graph.js';
import type { LanePlanGraphLane, LanePlanGraphPlan } from '../lane-plan-graph.js';
import type { PlannedLaneRef } from '../lane-plan-records.js';

function refFromText(text: string): PlannedLaneRef {
  const [projectId, planId, laneId] = text.split('/');
  return { projectId, planId, laneId };
}

function lane(
  laneId: string,
  after: readonly string[] = [],
  extra: Partial<Omit<LanePlanGraphLane, 'laneId' | 'after'>> = {},
): LanePlanGraphLane {
  return { laneId, after: after.map(refFromText), ...extra };
}

function plan(
  projectId: string,
  planId: string,
  lanes: readonly LanePlanGraphLane[],
  exclusiveOrder?: readonly { readonly lanes: readonly string[] }[],
): LanePlanGraphPlan {
  return { projectId, planId, lanes, ...(exclusiveOrder === undefined ? {} : { exclusiveOrder }) };
}

describe('findLanePlanCycle', () => {
  it('returns null for an acyclic chain in one plan', () => {
    const lanes = [
      lane('A', ['example-project/plan-1/B']),
      lane('B', ['example-project/plan-1/C']),
      lane('C'),
    ];
    expect(findLanePlanCycle([plan('example-project', 'plan-1', lanes)])).toBeNull();
  });

  it('finds a two-lane cycle and formats it', () => {
    const lanes = [
      lane('A', ['example-project/plan-1/B']),
      lane('B', ['example-project/plan-1/A']),
    ];
    const cycle = findLanePlanCycle([plan('example-project', 'plan-1', lanes)]);
    expect(cycle).not.toBeNull();
    if (cycle === null) return;
    expect(cycle).toEqual([
      { projectId: 'example-project', planId: 'plan-1', laneId: 'A' },
      { projectId: 'example-project', planId: 'plan-1', laneId: 'B' },
    ]);
    expect(formatLanePlanCycle(cycle)).toBe(
      'example-project/plan-1/A -> example-project/plan-1/B -> example-project/plan-1/A',
    );
  });

  it('finds a cycle across plans', () => {
    const plan1 = plan('example-project', 'plan-1', [
      lane('X', ['example-project/plan-2/Y']),
    ]);
    const plan2 = plan('example-project', 'plan-2', [
      lane('Y', ['example-project/plan-1/X']),
    ]);
    const cycle = findLanePlanCycle([plan1, plan2]);
    expect(cycle).toEqual([
      { projectId: 'example-project', planId: 'plan-1', laneId: 'X' },
      { projectId: 'example-project', planId: 'plan-2', laneId: 'Y' },
    ]);
  });

  it('finds a cycle that closes across projects', () => {
    const plan2 = plan('example-project', 'plan-2', [
      lane('Y', ['other-project/plan-3/Z']),
    ]);
    const plan3 = plan('other-project', 'plan-3', [
      lane('Z', ['example-project/plan-2/Y']),
    ]);
    const cycle = findLanePlanCycle([plan2, plan3]);
    expect(cycle).toEqual([
      { projectId: 'example-project', planId: 'plan-2', laneId: 'Y' },
      { projectId: 'other-project', planId: 'plan-3', laneId: 'Z' },
    ]);
  });

  it('resolves an alias to its lane and names the current id in the cycle', () => {
    const plan1 = plan('example-project', 'plan-1', [
      lane('X', ['example-project/plan-2/Y'], { aliases: ['OLD'] }),
    ]);
    const plan2 = plan('example-project', 'plan-2', [
      lane('Y', ['example-project/plan-1/OLD']),
    ]);
    const cycle = findLanePlanCycle([plan1, plan2]);
    expect(cycle).toEqual([
      { projectId: 'example-project', planId: 'plan-1', laneId: 'X' },
      { projectId: 'example-project', planId: 'plan-2', laneId: 'Y' },
    ]);
  });

  it('resolves renamedFrom to its lane and names the current id in the cycle', () => {
    const plan1 = plan('example-project', 'plan-1', [
      lane('X', ['example-project/plan-2/Y'], { renamedFrom: 'OLD' }),
    ]);
    const plan2 = plan('example-project', 'plan-2', [
      lane('Y', ['example-project/plan-1/OLD']),
    ]);
    const cycle = findLanePlanCycle([plan1, plan2]);
    expect(cycle).toEqual([
      { projectId: 'example-project', planId: 'plan-1', laneId: 'X' },
      { projectId: 'example-project', planId: 'plan-2', laneId: 'Y' },
    ]);
  });

  it('lets a current lane id win over an alias', () => {
    const plan1 = plan('example-project', 'plan-1', [
      lane('X', ['example-project/plan-2/Z'], { aliases: ['Y'] }),
      lane('Y'),
    ]);
    const plan2 = plan('example-project', 'plan-2', [
      lane('Z', ['example-project/plan-1/Y']),
    ]);
    expect(findLanePlanCycle([plan1, plan2])).toBeNull();
  });

  it('ignores unresolved plans and lanes', () => {
    const withMissingPlan = plan('example-project', 'plan-1', [
      lane('X', ['example-project/missing-plan/Q']),
    ]);
    expect(findLanePlanCycle([withMissingPlan])).toBeNull();

    const withMissingLane = plan('example-project', 'plan-1', [
      lane('X', ['example-project/plan-2/NOPE']),
    ]);
    const plan2 = plan('example-project', 'plan-2', [lane('Y')]);
    expect(findLanePlanCycle([withMissingLane, plan2])).toBeNull();
  });

  it('finds a cycle closed by an exclusive order', () => {
    const lanes = [lane('A', ['example-project/plan-1/B']), lane('B')];
    const p = plan('example-project', 'plan-1', lanes, [{ lanes: ['A', 'B'] }]);
    const cycle = findLanePlanCycle([p]);
    expect(cycle).toEqual([
      { projectId: 'example-project', planId: 'plan-1', laneId: 'A' },
      { projectId: 'example-project', planId: 'plan-1', laneId: 'B' },
    ]);
  });

  it('finds a self-reference cycle', () => {
    const cycle = findLanePlanCycle([
      plan('example-project', 'plan-1', [lane('A', ['example-project/plan-1/A'])]),
    ]);
    expect(cycle).toEqual([
      { projectId: 'example-project', planId: 'plan-1', laneId: 'A' },
    ]);
    expect(cycle).not.toBeNull();
    if (cycle === null) return;
    expect(formatLanePlanCycle(cycle)).toBe('example-project/plan-1/A -> example-project/plan-1/A');
  });

  it('lets a later plan replace an earlier one with the same key', () => {
    const cyclic = plan('example-project', 'plan-1', [
      lane('A', ['example-project/plan-1/B']),
      lane('B', ['example-project/plan-1/A']),
    ]);
    const acyclic = plan('example-project', 'plan-1', [
      lane('A', ['example-project/plan-1/B']),
      lane('B'),
    ]);
    expect(findLanePlanCycle([cyclic, acyclic])).toBeNull();
    expect(findLanePlanCycle([acyclic, cyclic])).not.toBeNull();
  });

  it('is independent of input order for distinct plans', () => {
    const plan1 = plan('example-project', 'plan-1', [
      lane('X', ['example-project/plan-2/Y']),
    ]);
    const plan2 = plan('example-project', 'plan-2', [
      lane('Y', ['example-project/plan-1/X']),
    ]);
    expect(findLanePlanCycle([plan1, plan2])).not.toBeNull();
    expect(findLanePlanCycle([plan2, plan1])).not.toBeNull();
  });

  it('handles 300 lanes in a chain across three plans without recursion', () => {
    const plan1Lanes: LanePlanGraphLane[] = [];
    const plan2Lanes: LanePlanGraphLane[] = [];
    const plan3Lanes: LanePlanGraphLane[] = [];
    for (let index = 0; index < 99; index += 1) {
      plan1Lanes.push(lane(`L${index}`, [`example-project/plan-1/L${index + 1}`]));
      plan2Lanes.push(lane(`M${index}`, [`example-project/plan-2/M${index + 1}`]));
      plan3Lanes.push(lane(`N${index}`, [`example-project/plan-3/N${index + 1}`]));
    }
    plan1Lanes.push(lane('L99', ['example-project/plan-2/M0']));
    plan2Lanes.push(lane('M99', ['example-project/plan-3/N0']));
    plan3Lanes.push(lane('N99'));
    const result = findLanePlanCycle([
      plan('example-project', 'plan-1', plan1Lanes),
      plan('example-project', 'plan-2', plan2Lanes),
      plan('example-project', 'plan-3', plan3Lanes),
    ]);
    expect(result).toBeNull();
  });

  it('never mutates its inputs', () => {
    const input = [
      plan('example-project', 'plan-1', [
        lane('A', ['example-project/plan-1/B']),
        lane('B', ['example-project/plan-1/A']),
      ]),
      plan('example-project', 'plan-2', [
        lane('X', ['example-project/plan-1/OLD'], { aliases: ['NEW'] }),
      ]),
    ];
    const before = structuredClone(input);
    findLanePlanCycle(input);
    expect(input).toEqual(before);
  });
});
