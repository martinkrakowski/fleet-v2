// PT1ca: registration reads the open pull requests through the production
// forge read port (ForgeReadAdapter behind the fixture's fake gh runner). The
// fake forge lists NO open PR by default, so every conducted scenario registers;
// a fake open PR whose changed files overlap the work order's owned paths holds
// the registration (`open-pr-overlap`), listed by `work-order held`. Skipped
// unless FLEET_E2E_SSH=1, like the other conducted scenarios.

import { afterEach, describe, expect, it } from 'vitest';

import { FORGE_REPOSITORY, startConductedFixture, type ConductedFixture } from './conducted.js';

const TEST_TIMEOUT_MS = 120000;

const liveFixtures = new Set<ConductedFixture>();

afterEach(async () => {
  const current = [...liveFixtures];
  liveFixtures.clear();
  for (const instance of current.reverse()) {
    await instance.stop();
  }
});

describe.skipIf(process.env.FLEET_E2E_SSH !== '1')('conducted held registration (PT1ca)', () => {
  it(
    'holds a registration that overlaps an open PR, and lists it with work-order held',
    async () => {
      // The fixture's own registration passes with the empty default open-PR list.
      const current = await startConductedFixture();
      liveFixtures.add(current);

      current.setOpenPullRequests({ 42: ['packages/example-held/src/x.ts', 'docs/other.md'] });
      const refused = await current.runtime.execution.registerWorkOrder.execute({
        workOrderId: 'wo-held-e2e',
        projectId: 'project-example-1',
        taskId: 'task-held-e2e',
        laneId: 'lane-held-e2e',
        repository: FORGE_REPOSITORY,
        baseCommit: current.baseCommit,
        policyRevision: 'policy-example-1',
        ownedPaths: ['packages/example-held'],
        briefRequestRef: 'brief-req-held-e2e',
      });
      expect(refused).toMatchObject({
        outcome: 'refused',
        reason: 'open-pr-overlap',
        pullRequestNumber: 42,
        blockerKind: 'open-pr',
        blockerId: '42',
        held: true,
      });

      const listed = await current.runCommand(['work-order', 'held']);
      expect(listed.code).toBe(0);
      const document = JSON.parse(listed.stdout.join('')) as { outcome: string; held: Record<string, unknown>[] };
      expect(document.outcome).toBe('listed');
      expect(document.held).toHaveLength(1);
      expect(document.held[0]).toMatchObject({
        workOrderId: 'wo-held-e2e',
        blockerKind: 'open-pr',
        blockerId: '42',
      });
    },
    TEST_TIMEOUT_MS,
  );
});
