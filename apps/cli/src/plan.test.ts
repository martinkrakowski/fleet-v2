import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFleetCliRuntime, type FleetCliRuntime } from './composition.js';
import { planCommand, type PlanCliOptions } from './plan.js';
import { comparePlanMarkdownToSidecar, parsePlanMarkdownLanes } from './plan-check.js';
import type { CliIo } from './index.js';
import { parseLanePlanSidecar } from '@fleet/work-execution';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'fleet-plan-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createMockIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

const SIDECAR = {
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
      brief: 'brief-a2.md',
    },
  ],
  decisions: [{ id: 'D1', question: 'Which store?', default: 'A file store', state: 'open' }],
  exclusiveOrder: [{ file: '.architecture/manifest.yaml', lanes: ['A1', 'A2'] }],
};

const SIDECAR_JSON = JSON.stringify(SIDECAR);

const MARKDOWN = `# Example plan

Some prose.

| Lane | Tier | After |
| --- | --- | --- |
| A1 | 2 | — |
| A2 | 2 | A1 other-plan/B1 other-project/third-plan/C1 |

| Section |
| --- |
`;

function sidecarFile(): string {
  const file = join(tempDir, 'plan.workbook.json');
  writeFileSync(file, SIDECAR_JSON);
  return file;
}

function markdownFile(content: string = MARKDOWN): string {
  const file = join(tempDir, 'plan.md');
  writeFileSync(file, content);
  return file;
}

async function runPlan(
  argv: readonly string[],
  runtime: FleetCliRuntime,
  options: PlanCliOptions = {},
) {
  const { io, stdout, stderr } = createMockIo();
  const exitCode = await planCommand(argv, io, runtime, options);
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

function newRuntime(): FleetCliRuntime {
  return createFleetCliRuntime({ stateDir: tempDir });
}

function fakeRuntime(execution: unknown): FleetCliRuntime {
  return { execution } as unknown as FleetCliRuntime;
}

describe('plan command group', () => {
  it('prints help with exit 0', async () => {
    for (const argv of [['--help'], ['help'], ['-h'], ['check', '--help']]) {
      const { exitCode, stdout } = await runPlan(argv, newRuntime());
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: fleet-v2 plan');
    }
  });

  it('refuses malformed tokens and unknown flags with exit 2', async () => {
    const runtime = newRuntime();
    const bad = await runPlan(['link-pr', 'nope', 'owner/repo#1', '--project', 'p'], runtime);
    expect(bad.exitCode).toBe(2);
    const badRepo = await runPlan(
      ['link-pr', '2026-10-27_example/A1', 'owner#1', '--project', 'p'],
      runtime,
    );
    expect(badRepo.exitCode).toBe(2);
    const unknownFlag = await runPlan(
      ['import', sidecarFile(), '--project', 'p', '--forge', 'x'],
      runtime,
    );
    expect(unknownFlag.exitCode).toBe(2);
    const badStep = await runPlan(
      ['declare', '2026-10-27_example/A1', '--project', 'p', '--step', 'nonsense', '--seat-role', 'r', '--model', 'm', '--yes'],
      runtime,
    );
    expect(badStep.exitCode).toBe(2);
    const unknown = await runPlan(['nonsense'], runtime);
    expect(unknown.exitCode).toBe(2);
  });

  it('imports a sidecar, syncs decisions and exits 0, and repeats as unchanged', async () => {
    const runtime = newRuntime();
    const first = await runPlan(
      ['import', sidecarFile(), '--project', 'example-project', '--yes'],
      runtime,
    );
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('imported plan 2026-10-27_example');
    expect(first.stdout).toContain('synced 1 of 1 decision items (synced)');
    const second = await runPlan(
      ['import', sidecarFile(), '--project', 'example-project', '--yes'],
      runtime,
    );
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('unchanged plan 2026-10-27_example');
  });

  it('declining confirmation writes nothing and exits 1', async () => {
    const runtime = newRuntime();
    const file = sidecarFile();
    const declined = await runPlan(['import', file, '--project', 'example-project'], runtime, {
      confirm: async () => false,
    });
    expect(declined.exitCode).toBe(1);
    expect(declined.stderr).toContain('nothing changed');
    const listed = await runPlan(['list', '--project', 'example-project', '--json'], runtime);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    const linkDeclined = await runPlan(
      ['link-pr', '2026-10-27_example/A1', 'example-org/example-repo#7', '--project', 'example-project'],
      runtime,
      { confirm: async () => false },
    );
    expect(linkDeclined.exitCode).toBe(1);
    expect(linkDeclined.stderr).toContain('nothing changed');
  });

  it('returns exit 1 when sidecar or markdown file is unreadable', async () => {
    const runtime = newRuntime();
    const missing = await runPlan(
      ['import', join(tempDir, 'absent.workbook.json'), '--project', 'example-project', '--yes'],
      runtime,
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('absent.workbook.json');
    const checkMissing = await runPlan(
      ['check', join(tempDir, 'absent.workbook.json'), markdownFile()],
      runtime,
    );
    expect(checkMissing.exitCode).toBe(1);
    expect(checkMissing.stderr).toContain('absent.workbook.json');
    const checkMarkdownMissing = await runPlan(
      ['check', sidecarFile(), join(tempDir, 'absent.md')],
      runtime,
    );
    expect(checkMarkdownMissing.exitCode).toBe(1);
    expect(checkMarkdownMissing.stderr).toContain('absent.md');
  });

  it('refuses malformed JSON, null, and array sidecars with exit 1', async () => {
    const runtime = newRuntime();
    for (const content of ['{not json', 'null', '[]', '"text"']) {
      const file = join(tempDir, 'bad.workbook.json');
      writeFileSync(file, content);
      const result = await runPlan(['import', file, '--project', 'example-project', '--yes'], runtime);
      expect(result.exitCode).toBe(1);
      const check = await runPlan(['check', file, markdownFile()], runtime);
      expect(check.exitCode).toBe(1);
    }
  });

  it('checks an in-sync workbook with exit 0 and reports drift with exit 1', async () => {
    const runtime = newRuntime();
    const inSync = await runPlan(['check', sidecarFile(), markdownFile()], runtime);
    expect(inSync.exitCode).toBe(0);
    expect(inSync.stdout).toContain('plan in sync');
    const drifted = markdownFile(
      MARKDOWN.replace('| A1 | 2 |', '| A1 | 1 |').replace(
        '| A2 | 2 | A1 other-plan/B1 other-project/third-plan/C1 |',
        '| A2 | 2 | A1 |\n| A9 | 2 | — |',
      ),
    );
    const result = await runPlan(['check', sidecarFile(), drifted], runtime);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('tier-mismatch');
    expect(result.stdout).toContain('after-mismatch');
    expect(result.stdout).toContain('extra-in-markdown');
    const json = await runPlan(['check', sidecarFile(), drifted, '--json'], runtime);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.outcome).toBe('drift');
    expect(parsed.drifts.length).toBeGreaterThanOrEqual(3);
  });

  it('exits 1 and reports drift on tier or after mismatch (pure checker)', () => {
    const parsed = parseLanePlanSidecar(SIDECAR);
    if (!parsed.ok) {
      throw new Error('fixture sidecar must parse');
    }
    const tierDrift = comparePlanMarkdownToSidecar(
      parsed.sidecar,
      '| Lane | Tier | After |\n| --- | --- | --- |\n| A1 | 0 | — |\n| A2 | 2 | A1 other-plan/B1 other-project/third-plan/C1 |',
    );
    expect(tierDrift.outcome).toBe('drift');
    if (tierDrift.outcome !== 'drift') return;
    expect(tierDrift.drifts.some((drift) => drift.kind === 'tier-mismatch' && drift.laneId === 'A1')).toBe(true);
    const afterDrift = comparePlanMarkdownToSidecar(
      parsed.sidecar,
      '| Lane | Tier | After |\n| --- | --- | --- |\n| A1 | 2 | — |\n| A2 | 2 | A1 |',
    );
    expect(afterDrift.outcome).toBe('drift');
    if (afterDrift.outcome !== 'drift') return;
    expect(afterDrift.drifts.some((drift) => drift.kind === 'after-mismatch' && drift.laneId === 'A2')).toBe(true);
    const empty = comparePlanMarkdownToSidecar(parsed.sidecar, 'no table at all');
    expect(empty.outcome).toBe('drift');
    if (empty.outcome !== 'drift') return;
    expect(empty.drifts.every((drift) => drift.kind === 'missing-in-markdown')).toBe(true);
  });

  it('links a pull request with exit 0 and refuses a second link with exit 1', async () => {
    const runtime = newRuntime();
    await runPlan(['import', sidecarFile(), '--project', 'example-project', '--yes'], runtime);
    const linked = await runPlan(
      ['link-pr', '2026-10-27_example/A1', 'example-org/example-repo#7', '--project', 'example-project', '--yes'],
      runtime,
    );
    expect(linked.exitCode).toBe(0);
    expect(linked.stdout).toContain('linked');
    const again = await runPlan(
      ['link-pr', '2026-10-27_example/A2', 'example-org/example-repo#7', '--project', 'example-project', '--yes'],
      runtime,
    );
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain('linked');
    const unknownLane = await runPlan(
      ['link-pr', '2026-10-27_example/ZZ', 'example-org/example-repo#8', '--project', 'example-project', '--yes'],
      runtime,
    );
    expect(unknownLane.exitCode).toBe(1);
  });

  it('declares a lane step with exit 0 and refuses an unknown lane with exit 1', async () => {
    const runtime = newRuntime();
    await runPlan(['import', sidecarFile(), '--project', 'example-project', '--yes'], runtime);
    const declared = await runPlan(
      [
        'declare', '2026-10-27_example/A1',
        '--project', 'example-project',
        '--step', 'first-pass',
        '--seat-role', 'implementer',
        '--model', 'seat-model',
        '--yes',
      ],
      runtime,
    );
    expect(declared.exitCode).toBe(0);
    expect(declared.stdout).toContain('declared first-pass');
    // The declaration use case validates the body: a seat role with a
    // forbidden control character is refused, whatever lane it names.
    const refused = await runPlan(
      [
        'declare', '2026-10-27_example/A1',
        '--project', 'example-project',
        '--step', 'gate',
        '--seat-role', 'imper\tative seat',
        '--model', 'seat-model',
        '--yes',
      ],
      runtime,
    );
    expect(refused.exitCode).toBe(1);
  });

  it('refuses brief-check when plan is absent or lane has no brief', async () => {
    const runtime = newRuntime();
    await runPlan(['import', sidecarFile(), '--project', 'example-project', '--yes'], runtime);
    const absentPlan = await runPlan(
      ['brief-check', '2026-10-27_other/A1', '--project', 'example-project', '--yes'],
      runtime,
    );
    expect(absentPlan.exitCode).toBe(1);
    const noBrief = await runPlan(
      ['brief-check', '2026-10-27_example/A1', '--project', 'example-project', '--yes'],
      runtime,
    );
    expect(noBrief.exitCode).toBe(1);
  });

  it('records a brief read with sha256 and bytes and exits 0', async () => {
    const runtime = newRuntime();
    await runPlan(['import', sidecarFile(), '--project', 'example-project', '--yes'], runtime);
    writeFileSync(join(tempDir, 'brief-a2.md'), 'the brief body');
    const result = await runPlan(
      ['brief-check', '2026-10-27_example/A2', '--project', 'example-project', '--worktree', tempDir, '--yes'],
      runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('brief read of lane 2026-10-27_example/A2');
    const json = await runPlan(
      ['brief-check', '2026-10-27_example/A2', '--project', 'example-project', '--worktree', tempDir, '--yes', '--json'],
      runtime,
    );
    const parsed = JSON.parse(json.stdout);
    expect(parsed.outcome).toBe('recorded');
    expect(parsed.read.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.read.bytes).toBe('the brief body'.length);
  });

  it('records failed brief read and exits 1 when brief file is unreadable', async () => {
    const runtime = newRuntime();
    await runPlan(['import', sidecarFile(), '--project', 'example-project', '--yes'], runtime);
    const result = await runPlan(
      ['brief-check', '2026-10-27_example/A2', '--project', 'example-project', '--worktree', tempDir, '--yes'],
      runtime,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('brief-a2.md');
    const listed = await runPlan(['list', '--project', 'example-project'], runtime);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('2026-10-27_example');
  });

  it('handles throwing store or use-case errors with exit 1', async () => {
    const throwing = fakeRuntime({
      lanePlanRepository: {
        findLanePlan: () => {
          throw new Error('store unreadable');
        },
      },
    });
    const briefCheck = await runPlan(
      ['brief-check', '2026-10-27_example/A2', '--project', 'example-project', '--yes'],
      throwing,
    );
    expect(briefCheck.exitCode).toBe(1);
    expect(briefCheck.stderr).toContain('error:');
    const importing = fakeRuntime({
      lanePlanRepository: {
        findLanePlan: async () => null,
      },
      importLanePlan: {
        importLanePlan: () => {
          throw new Error('store unreadable');
        },
      },
      syncPlanDecisions: { execute: async () => ({ outcome: 'synced', decisions: [] }) },
    });
    const result = await runPlan(
      ['import', sidecarFile(), '--project', 'example-project', '--yes'],
      importing,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error:');
  });

  it('exits 1 when decision sync is partial or refused', async () => {
    const importedPlan = {
      projectId: 'example-project',
      planId: '2026-10-27_example',
      revision: 3,
      lanes: [],
      decisions: [{ id: 'D1', question: 'Which store?', default: 'A file store', state: 'open' }],
    };
    for (const syncOutcome of ['partial', 'refused'] as const) {
      const runtime = fakeRuntime({
        lanePlanRepository: { findLanePlan: async () => null },
        importLanePlan: { importLanePlan: async () => ({ outcome: 'imported', plan: importedPlan }) },
        syncPlanDecisions: {
          execute: async () => ({
            outcome: syncOutcome,
            ...(syncOutcome === 'refused' ? { code: 'all-refused', reason: 'every decision was refused' } : {}),
            decisions: [{ decisionId: 'D1', outcome: 'refused', code: 'refused' }],
          }),
        },
      });
      const result = await runPlan(
        ['import', sidecarFile(), '--project', 'example-project', '--yes'],
        runtime,
      );
      expect(result.exitCode).toBe(1);
    }
  });

  it('lists imported plans one line per plan or as JSON', async () => {
    const runtime = newRuntime();
    await runPlan(['import', sidecarFile(), '--project', 'example-project', '--yes'], runtime);
    const listed = await runPlan(['list'], runtime);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('example-project 2026-10-27_example revision 3');
    const json = await runPlan(['list', '--json'], runtime);
    const parsed = JSON.parse(json.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].planId).toBe('2026-10-27_example');
  });

  it('parses markdown lane rows and tolerates malformed tables', () => {
    const rows = parsePlanMarkdownLanes(
      '| Lane | Tier | After |\n| --- | --- | --- |\n| A1 | 2 | — |\n| A2 | 1 | A1, x/y/Z9 |\n| Section | | |',
      'proj',
      'plan',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].laneId).toBe('A1');
    expect(rows[1].after).toEqual(['proj/plan/A1', 'x/y/Z9']);
    const malformed = parsePlanMarkdownLanes('no table', 'proj', 'plan');
    expect(malformed).toEqual([]);
  });
});
