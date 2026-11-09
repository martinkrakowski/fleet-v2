import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  LanePlanRecord,
  PullRequestLinkConflictRecord,
  PullRequestLinkRecord,
} from '../../domain/lane-plan-records.js';
import type { ChangeSignal, ChangeSignalPort } from '../../application/ports/out/ChangeSignalPort.out-port.js';
import {
  LanePlanRepositoryAdapter,
  parsePullRequestLinkConflictStateRecord,
  PULL_REQUEST_LINK_CONFLICT_STORE_VERSION_POLICY,
} from './LanePlanRepositoryAdapter.adapter.js';
import {
  ReadOnlyStateStoreError,
  StateFileUnreadableError,
  StateFileUnknownVersionError,
} from './file-store.js';

class RecordingChangeSignalPort implements ChangeSignalPort {
  readonly signals: ChangeSignal[] = [];

  emit(signal: ChangeSignal): void {
    this.signals.push(signal);
  }
}

function lanePlan(overrides: Partial<LanePlanRecord> = {}): LanePlanRecord {
  return {
    version: 1,
    projectId: 'proj-1',
    planId: 'plan-1',
    revision: 1,
    digest: 'a'.repeat(64),
    doc: 'docs/plan.md',
    lanes: [
      {
        laneId: 'L1',
        aliases: [],
        scope: 'scope one',
        packages: ['pkg-a'],
        sharedFiles: [],
        tier: 0,
        after: [],
        decisions: [],
        status: 'planned',
        brief: null,
        mergedPr: null,
      },
    ],
    decisions: [],
    exclusiveOrder: [],
    importedAtIso: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

function linkRecord(overrides: Partial<PullRequestLinkRecord> = {}): PullRequestLinkRecord {
  return {
    version: 1,
    repository: 'acme/app',
    number: 251,
    projectId: 'proj-1',
    planId: 'plan-1',
    laneId: 'L1',
    source: 'cli',
    linkedAtIso: '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
}

function conflictRecord(overrides: Partial<PullRequestLinkConflictRecord> = {}): PullRequestLinkConflictRecord {
  return {
    schemaVersion: PULL_REQUEST_LINK_CONFLICT_STORE_VERSION_POLICY.writerVersion,
    repository: 'acme/app',
    number: 42,
    linkedLane: { projectId: 'proj-1', planId: 'plan-1', laneId: 'L1' },
    refusedLane: { projectId: 'proj-1', planId: 'plan-1', laneId: 'L2' },
    recordedAtIso: '2026-11-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('LanePlanRepositoryAdapter pull-request link conflicts (WB5b)', () => {
  it('saves, lists and narrows conflicts in memory; the same conflict twice is unchanged', async () => {
    const adapter = new LanePlanRepositoryAdapter();
    const first = await adapter.savePullRequestLinkConflict!(conflictRecord());
    expect(first).toEqual({ outcome: 'saved', conflict: conflictRecord() });
    const again = await adapter.savePullRequestLinkConflict!(conflictRecord());
    expect(again.outcome).toBe('unchanged');
    if (again.outcome === 'unchanged') {
      expect(again.conflict).toEqual(conflictRecord());
    }
    expect(await adapter.listPullRequestLinkConflicts!()).toHaveLength(1);
    expect(await adapter.listPullRequestLinkConflicts!('proj-1')).toHaveLength(1);
    expect(await adapter.listPullRequestLinkConflicts!('other-project')).toHaveLength(0);
    // The refused lane's project narrows too.
    const otherSide = await adapter.savePullRequestLinkConflict!(
      conflictRecord({
        repository: 'acme/other',
        linkedLane: { projectId: 'proj-2', planId: null, laneId: 'L9' },
        refusedLane: { projectId: 'proj-3', planId: null, laneId: 'L8' },
      }),
    );
    expect(otherSide.outcome).toBe('saved');
    expect(await adapter.listPullRequestLinkConflicts!('proj-2')).toHaveLength(1);
    expect(await adapter.listPullRequestLinkConflicts!('proj-1')).toHaveLength(1);
  });

  it('refuses an invalid conflict record without throwing', async () => {
    const adapter = new LanePlanRepositoryAdapter();
    const refused = await adapter.savePullRequestLinkConflict!({
      ...conflictRecord(),
      refusedLane: { projectId: 'proj-1', planId: 'plan-1', laneId: 'L1' },
    } as PullRequestLinkConflictRecord);
    expect(refused.outcome).toBe('refused');
    if (refused.outcome === 'refused') {
      expect(refused.code).toBe('invalid');
      expect(typeof refused.message).toBe('string');
    }
  });

  it('a read-only store refuses to save a conflict', async () => {
    const adapter = new LanePlanRepositoryAdapter({ readOnly: true });
    await expect(adapter.savePullRequestLinkConflict!(conflictRecord())).rejects.toBeInstanceOf(
      ReadOnlyStateStoreError,
    );
  });

  describe('file store', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-link-conflicts-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    });

    it('writes link-conflicts.json with schemaVersion 1 and reopens it', async () => {
      const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
      expect((await adapter.savePullRequestLinkConflict!(conflictRecord())).outcome).toBe('saved');
      const onDisk = JSON.parse(
        await fs.readFile(path.join(tempDir, 'link-conflicts.json'), 'utf8'),
      ) as Array<Record<string, unknown>>;
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0]!.schemaVersion).toBe(1);

      const reopened = new LanePlanRepositoryAdapter({ stateDir: tempDir });
      expect(await reopened.listPullRequestLinkConflicts!()).toEqual([conflictRecord()]);
      expect(await reopened.listPullRequestLinkConflicts!('proj-1')).toHaveLength(1);
    });

    it('saving the same conflict twice is unchanged and does not rewrite link-conflicts.json', async () => {
      const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
      await adapter.savePullRequestLinkConflict!(conflictRecord());
      const before = await fs.readFile(path.join(tempDir, 'link-conflicts.json'), 'utf8');
      const again = await adapter.savePullRequestLinkConflict!(conflictRecord());
      expect(again.outcome).toBe('unchanged');
      const after = await fs.readFile(path.join(tempDir, 'link-conflicts.json'), 'utf8');
      expect(after).toBe(before);
    });

    it('fails closed with StateFileUnreadableError / StateFileUnknownVersionError on corrupt or unknown-schemaVersion link-conflicts.json instead of returning empty', async () => {
      await fs.writeFile(path.join(tempDir, 'link-conflicts.json'), '{ not valid json', 'utf8');
      const corrupt = new LanePlanRepositoryAdapter({ stateDir: tempDir });
      await expect(corrupt.listPullRequestLinkConflicts!()).rejects.toBeInstanceOf(StateFileUnreadableError);

      await fs.writeFile(
        path.join(tempDir, 'link-conflicts.json'),
        JSON.stringify([{ ...conflictRecord(), schemaVersion: 2 }]),
        'utf8',
      );
      const unknownVersion = new LanePlanRepositoryAdapter({ stateDir: tempDir });
      await expect(unknownVersion.listPullRequestLinkConflicts!()).rejects.toBeInstanceOf(
        StateFileUnknownVersionError,
      );

      // A structurally invalid record is also unreadable, never silence.
      await fs.writeFile(
        path.join(tempDir, 'link-conflicts.json'),
        JSON.stringify([{ ...conflictRecord(), recordedAtIso: 'not-a-timestamp' }]),
        'utf8',
      );
      const invalid = new LanePlanRepositoryAdapter({ stateDir: tempDir });
      await expect(invalid.listPullRequestLinkConflicts!()).rejects.toBeInstanceOf(StateFileUnreadableError);
      expect(parsePullRequestLinkConflictStateRecord({ ...conflictRecord(), recordedAtIso: 'oops' })).toBeUndefined();
    });

    it('a read-only store refuses writes to link-conflicts.json', async () => {
      const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir, readOnly: true });
      await expect(adapter.savePullRequestLinkConflict!(conflictRecord())).rejects.toBeInstanceOf(
        ReadOnlyStateStoreError,
      );
      await expect(fs.stat(path.join(tempDir, 'link-conflicts.json'))).rejects.toThrow();
    });
  });
});

describe('LanePlanRepositoryAdapter memory store', () => {
  it('saves, finds and lists in memory', async () => {
    const adapter = new LanePlanRepositoryAdapter();
    await adapter.saveLanePlan(lanePlan());
    expect(await adapter.findLanePlan('proj-1', 'plan-1')).not.toBeNull();
    expect(await adapter.findLanePlan('proj-1', 'missing-plan')).toBeNull();
    expect(await adapter.listLanePlans()).toHaveLength(1);
    expect(await adapter.listLanePlans('proj-1')).toHaveLength(1);
    expect(await adapter.listLanePlans('other-project')).toHaveLength(0);
  });

  it('refuses a stale revision in memory (revision >= stored throws)', async () => {
    const adapter = new LanePlanRepositoryAdapter();
    await adapter.saveLanePlan(lanePlan({ revision: 2 }));
    await expect(adapter.saveLanePlan(lanePlan({ revision: 2 }))).rejects.toThrow(
      'Stale lane plan revision for proj-1/plan-1',
    );
    await expect(adapter.saveLanePlan(lanePlan({ revision: 1 }))).rejects.toThrow(
      'Stale lane plan revision for proj-1/plan-1',
    );
  });
});

describe('LanePlanRepositoryAdapter file store', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-plan-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('a save writes lane-plans.json records carrying schemaVersion 1; a reopen finds and lists them', async () => {
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await adapter.saveLanePlan(lanePlan());
    const onDisk = JSON.parse(await fs.readFile(path.join(tempDir, 'lane-plans.json'), 'utf8')) as unknown[];
    expect(onDisk).toHaveLength(1);
    expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);

    const reopened = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    const found = await reopened.findLanePlan('proj-1', 'plan-1');
    expect(found?.planId).toBe('plan-1');
    expect('schemaVersion' in (found as object)).toBe(false);
    expect(await reopened.listLanePlans()).toHaveLength(1);
  });

  it('a second save at the same revision throws', async () => {
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await adapter.saveLanePlan(lanePlan());
    await expect(adapter.saveLanePlan(lanePlan())).rejects.toThrow('Stale lane plan revision');
  });

  it('saving a second plan preserves schemaVersion on previously stored plans', async () => {
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await adapter.saveLanePlan(lanePlan({ planId: 'plan-1' }));
    await adapter.saveLanePlan(
      lanePlan({
        planId: 'plan-2',
        lanes: [
          {
            laneId: 'L2',
            aliases: [],
            scope: 'second plan lane',
            packages: ['pkg-b'],
            sharedFiles: [],
            tier: 0,
            after: [],
            decisions: [],
            status: 'planned',
            brief: null,
            mergedPr: null,
          },
        ],
      }),
    );

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tempDir, 'lane-plans.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    expect(onDisk).toHaveLength(2);
    expect(onDisk[0]!.schemaVersion).toBe(1);
    expect(onDisk[1]!.schemaVersion).toBe(1);
    expect(onDisk[0]!.planId).toBe('plan-1');
    expect(onDisk[1]!.planId).toBe('plan-2');
  });

  it('the change signal fires with kind plan and a non-null stateFile', async () => {
    const target = path.resolve(path.join(tempDir, 'lane-plans.json'));
    const signals = new RecordingChangeSignalPort();
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir, changeSignal: signals });
    await adapter.saveLanePlan(lanePlan());
    expect(signals.signals).toHaveLength(1);
    expect(signals.signals[0]!.kind).toBe('plan');
    expect(signals.signals[0]!.id).toBe('proj-1/plan-1');
    expect(signals.signals[0]!.stateFile).toBe(target);
    expect(signals.signals[0]!.written).not.toBeNull();
  });

  it('a link save writes pull-request-links.json records carrying schemaVersion 1; a reopen finds and lists them', async () => {
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    const saved = await adapter.savePullRequestLink(linkRecord());
    expect(saved.outcome).toBe('saved');
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tempDir, 'pull-request-links.json'), 'utf8'),
    ) as unknown[];
    expect(onDisk).toHaveLength(1);
    expect((onDisk[0] as Record<string, unknown>).schemaVersion).toBe(1);

    const reopened = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    const found = await reopened.findPullRequestLink('acme/app', 251);
    expect(found?.laneId).toBe('L1');
    expect('schemaVersion' in (found as object)).toBe(false);
    expect(await reopened.listPullRequestLinks()).toHaveLength(1);
    expect(await reopened.listPullRequestLinks('proj-1')).toHaveLength(1);
    expect(await reopened.listPullRequestLinks('other-project')).toHaveLength(0);
  });

  it('finds a stored mixed-case link by a lower-case lookup; the same PR in another case is the same link (WB5b3)', async () => {
    const writer = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    const mixed = linkRecord({ repository: 'Acme/App' });
    expect(await writer.savePullRequestLink(mixed)).toEqual({ outcome: 'saved', link: mixed });

    const reader = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    expect(await reader.findPullRequestLink('acme/app', 251)).toEqual(mixed);
    expect(await reader.findPullRequestLink('ACME/APP', 251)).toEqual(mixed);
    // The stored file keeps the case it was written with.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(tempDir, 'pull-request-links.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.repository).toBe('Acme/App');
  });

  it('the same PR sighted again in another case is unchanged, not a new record or a false conflict (WB5b3)', async () => {
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    const first = linkRecord({ repository: 'Acme/App' });
    await adapter.savePullRequestLink(first);
    const again = await adapter.savePullRequestLink(linkRecord({ repository: 'ACME/APP' }));
    expect(again.outcome).toBe('unchanged');
    expect(await adapter.listPullRequestLinks()).toEqual([first]);
    const otherLane = await adapter.savePullRequestLink(linkRecord({ repository: 'aCmE/aPp', laneId: 'L2' }));
    expect(otherLane.outcome).toBe('refused');
    if (otherLane.outcome === 'refused') {
      expect(otherLane.code).toBe('pr-already-linked');
    }
  });

  it('a second link save for the same repository#number with another lane is refused pr-already-linked and the file is unchanged', async () => {
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await adapter.savePullRequestLink(linkRecord());
    const before = await fs.readFile(path.join(tempDir, 'pull-request-links.json'), 'utf8');
    const second = await adapter.savePullRequestLink(linkRecord({ laneId: 'L2' }));
    expect(second.outcome).toBe('refused');
    if (second.outcome === 'refused') {
      expect(second.code).toBe('pr-already-linked');
      expect(second.linkedLaneId).toBe('L1');
    }
    const after = await fs.readFile(path.join(tempDir, 'pull-request-links.json'), 'utf8');
    expect(after).toBe(before);
  });

  it('the same lane again returns unchanged and does not rewrite the file; in memory the same three rules hold', async () => {
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await adapter.savePullRequestLink(linkRecord());
    const before = await fs.readFile(path.join(tempDir, 'pull-request-links.json'), 'utf8');
    const again = await adapter.savePullRequestLink(linkRecord());
    expect(again.outcome).toBe('unchanged');
    const after = await fs.readFile(path.join(tempDir, 'pull-request-links.json'), 'utf8');
    expect(after).toBe(before);

    const memory = new LanePlanRepositoryAdapter();
    const memSaved = await memory.savePullRequestLink(linkRecord());
    expect(memSaved.outcome).toBe('saved');
    const memAgain = await memory.savePullRequestLink(linkRecord());
    expect(memAgain.outcome).toBe('unchanged');
    const memRefused = await memory.savePullRequestLink(linkRecord({ laneId: 'L2' }));
    expect(memRefused.outcome).toBe('refused');
    if (memRefused.outcome === 'refused') {
      expect(memRefused.code).toBe('pr-already-linked');
      expect(memRefused.linkedLaneId).toBe('L1');
    }
    expect(await memory.findPullRequestLink('acme/app', 251)).not.toBeNull();
    expect(await memory.listPullRequestLinks('proj-1')).toHaveLength(1);
    expect(await memory.listPullRequestLinks('other-project')).toHaveLength(0);
  });
});

describe('LanePlanRepositoryAdapter fail closed', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-plan-failclosed-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('an unknown schemaVersion is a read error, never null, without quarantine', async () => {
    const bad = { ...lanePlan(), schemaVersion: 2 };
    await fs.writeFile(path.join(tempDir, 'lane-plans.json'), JSON.stringify([bad]));
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.findLanePlan('proj-1', 'plan-1')).rejects.toBeInstanceOf(
      StateFileUnknownVersionError,
    );
    await expect(adapter.listLanePlans()).rejects.toBeInstanceOf(StateFileUnknownVersionError);
    await expect(fs.stat(path.join(tempDir, 'quarantine'))).rejects.toThrow();
  });

  it('a corrupt JSON file is an error, never absence', async () => {
    await fs.writeFile(path.join(tempDir, 'lane-plans.json'), '{ not valid json', 'utf8');
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.findLanePlan('proj-1', 'plan-1')).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    await expect(adapter.listLanePlans()).rejects.toBeInstanceOf(StateFileUnreadableError);
  });

  it('rejects pull-request-links.json containing conflicting links for the same pull request', async () => {
    const recordA = {
      version: 1,
      repository: 'acme/app',
      number: 42,
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'lane-A',
      source: 'sidecar',
      linkedAtIso: '2026-10-25T00:00:00.000Z',
      schemaVersion: 1,
    };
    const recordB = {
      version: 1,
      repository: 'acme/app',
      number: 42,
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'lane-B',
      source: 'sidecar',
      linkedAtIso: '2026-10-26T00:00:00.000Z',
      schemaVersion: 1,
    };
    await fs.writeFile(
      path.join(tempDir, 'pull-request-links.json'),
      JSON.stringify([recordA, recordB]),
    );
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.findPullRequestLink('acme/app', 42)).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    await expect(adapter.listPullRequestLinks()).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
  });

  it('rejects pull-request-links.json holding duplicate entries for the same pull request and lane with different source or timestamp, writing nothing', async () => {
    const recordA = {
      version: 1,
      repository: 'acme/app',
      number: 42,
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'lane-A',
      source: 'sidecar',
      linkedAtIso: '2026-10-25T00:00:00.000Z',
      schemaVersion: 1,
    };
    const recordB = {
      version: 1,
      repository: 'acme/app',
      number: 42,
      projectId: 'proj-1',
      planId: 'plan-1',
      laneId: 'lane-A',
      source: 'cli',
      linkedAtIso: '2026-10-26T00:00:00.000Z',
      schemaVersion: 1,
    };
    const filePath = path.join(tempDir, 'pull-request-links.json');
    const content = JSON.stringify([recordA, recordB]);
    await fs.writeFile(filePath, content, 'utf8');

    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir });
    await expect(adapter.findPullRequestLink('acme/app', 42)).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );
    await expect(adapter.listPullRequestLinks()).rejects.toBeInstanceOf(
      StateFileUnreadableError,
    );

    const afterRead = await fs.readFile(filePath, 'utf8');
    expect(afterRead).toBe(content);
  });
});

describe('LanePlanRepositoryAdapter read-only', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-lane-plan-readonly-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses every save', async () => {
    const adapter = new LanePlanRepositoryAdapter({ stateDir: tempDir, readOnly: true });
    await expect(adapter.saveLanePlan(lanePlan())).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
    const memory = new LanePlanRepositoryAdapter({ readOnly: true });
    await expect(memory.saveLanePlan(lanePlan())).rejects.toBeInstanceOf(ReadOnlyStateStoreError);
  });
});
