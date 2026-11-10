// Owner-items CLI tests — WB7a subset (add|list|resolve over the existing
// use cases). The CLI has no direct store access; items are seeded and read
// through the command handlers themselves against a temp --state-dir.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFleetCliRuntime, type FleetCliRuntime } from '../composition.js';
import { runCli } from '../index.js';
import type { CliIo } from '../index.js';

interface CapturedIo extends CliIo {
  readonly outLines: string[];
  readonly errLines: string[];
}

function captureIo(): CapturedIo {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (text: string) => {
      outLines.push(text);
    },
    stderr: (text: string) => {
      errLines.push(text);
    },
  };
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-v2-owner-items-'));
}

/** Run one `owner-items` invocation and return its exit code and captured streams. */
async function runOwnerItems(
  runtime: FleetCliRuntime,
  args: readonly string[],
  stateDir: string,
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const io = captureIo();
  const code = await runCli(
    ['owner-items', ...args],
    io,
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { now: () => '2026-10-27T10:00:00.000Z', stateDir },
  );
  return { code, stdout: io.outLines, stderr: io.errLines };
}

function parseDocument(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function parseLines(lines: readonly string[]): Array<Record<string, unknown>> {
  expect(lines.length).toBeGreaterThan(0);
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('owner-items add|list|resolve', () => {
  it('adds an other item with a subject and reports recorded', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 'owed'],
      stateDir,
    );
    expect(result.code).toBe(0);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('recorded');
    expect(typeof doc.itemId).toBe('string');
  });

  it('add other without a subject is refused with code invalid', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other'],
      stateDir,
    );
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('refused');
    expect(doc.code).toBe('invalid');
    expect(doc.reason).toBe('OwnerItem other requires a subject');
  });

  it('add decision with no ref is refused with code invalid', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'decision'],
      stateDir,
    );
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('refused');
    expect(doc.code).toBe('invalid');
    expect(doc.reason).toBe(
      'OwnerItem decision requires one question or plan-decision ref and at most one of each',
    );
  });

  it('add with an empty subject is refused as invalid', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', ''],
      stateDir,
    );
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('refused');
    expect(doc.code).toBe('invalid');
    expect(doc.reason).toBe(
      'OwnerItem subject must be single-line plain text of at most 120 characters',
    );
  });

  it('add with an over-long subject is refused as invalid', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'other',
        '--subject',
        'a'.repeat(121),
      ],
      stateDir,
    );
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('refused');
    expect(doc.code).toBe('invalid');
    expect(doc.reason).toBe(
      'OwnerItem subject must be single-line plain text of at most 120 characters',
    );
  });

  it('add with a subject containing a control character is refused as invalid', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'other',
        '--subject',
        'line\nbreak',
      ],
      stateDir,
    );
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('refused');
    expect(doc.code).toBe('invalid');
    expect(doc.reason).toBe(
      'OwnerItem subject must be single-line plain text of at most 120 characters',
    );
  });

  it('add --ref nope:x is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'other',
        '--subject',
        's',
        '--ref',
        'nope:x',
      ],
      stateDir,
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('add --ref pr:251 is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'other',
        '--subject',
        's',
        '--ref',
        'pr:251',
      ],
      stateDir,
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('add accepts a repeated --ref as an array', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'other',
        '--subject',
        's',
        '--ref',
        'question:q1',
        '--ref',
        'plan-decision:example-plan:D1',
      ],
      stateDir,
    );
    expect(result.code).toBe(0);
    expect(parseDocument(result.stdout).outcome).toBe('recorded');
    // Both refs must survive into the recorded item, by value: keeping only
    // the last ref would still print `recorded` above, so the assertion has
    // to read the persisted item.
    const stored = JSON.parse(
      readFileSync(join(stateDir, 'owner-items.json'), 'utf8'),
    ) as Array<{ item: { refs: unknown[] } }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.item.refs).toEqual([
      { kind: 'question', id: 'q1' },
      { kind: 'plan-decision', planId: 'example-plan', decisionId: 'D1' },
    ]);
  });

  it('a valueless --ref is a usage error, not a silent drop', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 's', '--ref'],
      stateDir,
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('a repeated --ref where one occurrence has no value is a usage error', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'other',
        '--subject',
        's',
        '--ref',
        'question:q1',
        '--ref',
      ],
      stateDir,
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('second add of the same plan-decision ref exists with the same itemId', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const first = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'decision',
        '--ref',
        'plan-decision:example-plan:D1',
      ],
      stateDir,
    );
    expect(first.code).toBe(0);
    const firstDoc = parseDocument(first.stdout);
    expect(firstDoc.outcome).toBe('recorded');

    const second = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'decision',
        '--ref',
        'plan-decision:example-plan:D1',
      ],
      stateDir,
    );
    expect(second.code).toBe(0);
    const secondDoc = parseDocument(second.stdout);
    expect(secondDoc.outcome).toBe('exists');
    expect(secondDoc.itemId).toBe(firstDoc.itemId);
  });

  it('decision add whose key an other item holds exits 1', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const other = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'other',
        '--subject',
        'holds key',
        '--ref',
        'plan-decision:example-plan:D1',
      ],
      stateDir,
    );
    expect(other.code).toBe(0);

    const decision = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'decision',
        '--ref',
        'plan-decision:example-plan:D1',
      ],
      stateDir,
    );
    expect(decision.code).toBe(1);
    const doc = parseDocument(decision.stdout);
    expect(doc.outcome).toBe('key-held');
    expect(typeof doc.heldByItemId).toBe('string');
  });

  it('resolve --as done on a decision exits 1 with code kind', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const added = await runOwnerItems(
      runtime,
      [
        'add',
        '--project-id',
        'example-project',
        '--kind',
        'decision',
        '--ref',
        'plan-decision:example-plan:D1',
      ],
      stateDir,
    );
    const { itemId } = parseDocument(added.stdout);
    const result = await runOwnerItems(runtime, ['resolve', itemId as string, '--as', 'done'], stateDir);
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('refused');
    expect(doc.code).toBe('kind');
  });

  it('resolve --as done on other closes it so --state open omits it', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const added = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 'owed'],
      stateDir,
    );
    const { itemId } = parseDocument(added.stdout);
    const resolved = await runOwnerItems(runtime, ['resolve', itemId as string, '--as', 'done'], stateDir);
    expect(resolved.code).toBe(0);
    expect(parseDocument(resolved.stdout).outcome).toBe('resolved');

    const open = await runOwnerItems(runtime, ['list', '--state', 'open'], stateDir);
    expect(open.code).toBe(0);
    const doc = parseDocument(open.stdout);
    expect(doc.outcome).toBe('listed');
    expect(doc.lines).toEqual([]);
  });

  it('second done is refused with code state', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const added = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 'owed'],
      stateDir,
    );
    const { itemId } = parseDocument(added.stdout);
    const first = await runOwnerItems(runtime, ['resolve', itemId as string, '--as', 'done'], stateDir);
    expect(first.code).toBe(0);
    const second = await runOwnerItems(runtime, ['resolve', itemId as string, '--as', 'done'], stateDir);
    expect(second.code).toBe(1);
    const doc = parseDocument(second.stdout);
    expect(doc.outcome).toBe('refused');
    expect(doc.code).toBe('state');
  });

  it('resolve missing id exits 1', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['resolve', 'oi-never-added', '--as', 'done'], stateDir);
    expect(result.code).toBe(1);
    expect(parseDocument(result.stdout).outcome).toBe('not-found');
  });

  it('resolve --as answered is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['resolve', 'oi-x', '--as', 'answered'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('resolve --as merged is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['resolve', 'oi-x', '--as', 'merged'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('resolve --as nope is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['resolve', 'oi-x', '--as', 'nope'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('resolve --why x is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      ['resolve', 'oi-x', '--as', 'done', '--why', 'x'],
      stateDir,
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('resolve with no id is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['resolve', '--as', 'done'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('resolve refuses an empty id as a usage error', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['resolve', '', '--as', 'done'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('resolve refuses a whitespace-only id as a usage error', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['resolve', '   ', '--as', 'done'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('resolve still accepts a valid id', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const added = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 'owed'],
      stateDir,
    );
    expect(added.code).toBe(0);
    const { itemId } = parseDocument(added.stdout);
    const result = await runOwnerItems(runtime, ['resolve', itemId as string, '--as', 'done'], stateDir);
    expect(result.code).toBe(0);
    expect(parseDocument(result.stdout).outcome).toBe('resolved');
  });

  it('resolve with two id positionals is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      ['resolve', 'oi-a', 'oi-b', '--as', 'done'],
      stateDir,
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('list of a missing store is an empty listed result', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['list'], stateDir);
    expect(result.code).toBe(0);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('listed');
    expect(doc.truncated).toBe(false);
    expect(doc.lines).toEqual([]);
  });

  it('list of a project with no items is an empty listed result', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 'x'],
      stateDir,
    );
    const result = await runOwnerItems(runtime, ['list', '--project-id', 'other-project'], stateDir);
    expect(result.code).toBe(0);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('listed');
    expect(doc.lines).toEqual([]);
  });

  it('list reports unknown and exits 1 when owner-items.json is not a JSON array', async () => {
    const stateDir = tempStateDir();
    writeFileSync(join(stateDir, 'owner-items.json'), '{}');
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['list'], stateDir);
    expect(result.code).toBe(1);
    const doc = parseDocument(result.stdout);
    expect(doc.outcome).toBe('unknown');
    expect(doc.lines).toBeUndefined();
  });

  it('list includes both open and closed items by default and filters by state', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const one = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 'one'],
      stateDir,
    );
    const two = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 'two'],
      stateDir,
    );
    const { itemId: idOne } = parseDocument(one.stdout);
    const { itemId: idTwo } = parseDocument(two.stdout);
    await runOwnerItems(runtime, ['resolve', idOne as string, '--as', 'done'], stateDir);

    const all = await runOwnerItems(runtime, ['list'], stateDir);
    expect(all.code).toBe(0);
    const allItems = parseLines(all.stdout);
    expect(allItems).toHaveLength(2);
    expect(allItems.find((i) => i.itemId === idOne)?.state).toBe('closed');
    expect(allItems.find((i) => i.itemId === idTwo)?.state).toBe('open');

    const open = await runOwnerItems(runtime, ['list', '--state', 'open'], stateDir);
    expect(open.code).toBe(0);
    const openItems = parseLines(open.stdout);
    expect(openItems.map((i) => i.itemId).sort()).toEqual([idTwo].sort());
  });

  it('list --gating true is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['list', '--gating', 'true'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('list --state bogus is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['list', '--state', 'bogus'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('list --state with no value is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(runtime, ['list', '--state'], stateDir);
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });

  it('add --blocks is usage', async () => {
    const stateDir = tempStateDir();
    const runtime = createFleetCliRuntime({ stateDir });
    const result = await runOwnerItems(
      runtime,
      ['add', '--project-id', 'example-project', '--kind', 'other', '--subject', 's', '--blocks', 'x'],
      stateDir,
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
  });
});
