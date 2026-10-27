import { describe, expect, it } from 'vitest';

import {
  AcceptanceSpec,
  GATE_COVERAGE_READER_UNIT_KINDS,
} from '../value-objects/AcceptanceSpec.vo.js';
import { BriefPackage, type BriefPackageProps } from '../value-objects/BriefPackage.vo.js';

const VALID = {
  commitRequired: true,
  diffCheck: true,
  commands: [
    { argv: ['corepack', 'yarn', 'build'] },
    {
      argv: ['corepack', 'yarn', 'test'],
      coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1 },
    },
  ],
};

describe('AcceptanceSpec', () => {
  it('accepts a valid spec and round-trips its canonical JSON form', () => {
    const result = AcceptanceSpec.create(VALID);
    expect(result.success).toBe(true);
    if (!result.success || result.value === undefined) return;

    expect(result.value.toJSON()).toEqual(VALID);

    const roundTripped = AcceptanceSpec.create(JSON.parse(JSON.stringify(result.value.toJSON())));
    expect(roundTripped.success).toBe(true);
    if (!roundTripped.success || roundTripped.value === undefined) return;
    expect(roundTripped.value.equals(result.value)).toBe(true);
  });

  it('emits canonical key order regardless of input key order', () => {
    const reordered = {
      commands: [
        {
          coverage: { minUnits: 1, unitKind: 'tests', reader: 'vitest-summary' },
          argv: ['corepack', 'yarn', 'test'],
        },
      ],
      diffCheck: true,
      commitRequired: true,
    };
    const result = AcceptanceSpec.create(reordered);
    expect(result.success).toBe(true);
    if (!result.success || result.value === undefined) return;

    const json = result.value.toJSON();
    expect(Object.keys(json)).toEqual(['commitRequired', 'diffCheck', 'commands']);
    expect(Object.keys(json.commands[0])).toEqual(['argv', 'coverage']);
    expect(Object.keys(json.commands[0].coverage!)).toEqual(['reader', 'unitKind', 'minUnits']);
  });

  it('keeps the stored spec independent of later input mutations', () => {
    const argv = ['corepack', 'yarn', 'build'];
    const input = { commitRequired: true, diffCheck: true, commands: [{ argv }] };
    const result = AcceptanceSpec.create(input);
    expect(result.success).toBe(true);
    if (!result.success || result.value === undefined) return;

    argv.push('mutated');
    input.commands.push({ argv: ['echo'] });

    expect(result.value.getCommands()).toHaveLength(1);
    expect(result.value.getCommands()[0].argv).toEqual(['corepack', 'yarn', 'build']);
  });

  const rows: Array<[string, unknown, string]> = [
    ['rejects non-object input', null, 'AcceptanceSpec must be an object'],
    ['rejects an array input', [], 'AcceptanceSpec must be an object'],
    [
      'rejects an unknown key',
      { ...VALID, extra: 1 },
      'AcceptanceSpec has an unknown key: extra',
    ],
    [
      'rejects commitRequired that is not true',
      { ...VALID, commitRequired: false },
      'AcceptanceSpec requires commitRequired: true',
    ],
    [
      'rejects diffCheck that is not true',
      { ...VALID, diffCheck: 'yes' },
      'AcceptanceSpec requires diffCheck: true',
    ],
    ['rejects empty commands', { ...VALID, commands: [] }, 'AcceptanceSpec requires 1 to 20 commands'],
    [
      'rejects more than 20 commands',
      { ...VALID, commands: Array.from({ length: 21 }, () => ({ argv: ['echo'] })) },
      'AcceptanceSpec requires 1 to 20 commands',
    ],
    [
      'rejects a command that is a string',
      { ...VALID, commands: ['yarn build'] },
      'AcceptanceSpec command 1 must be an object with argv and optional coverage',
    ],
    [
      'rejects a command with an unknown key',
      { ...VALID, commands: [{ argv: ['yarn'], timeout: 5 }] },
      'AcceptanceSpec command 1 has an unknown key: timeout',
    ],
    [
      'rejects empty argv',
      { ...VALID, commands: [{ argv: [] }] },
      'AcceptanceSpec command 1 argv must hold 1 to 64 strings',
    ],
    [
      'rejects argv with more than 64 entries',
      { ...VALID, commands: [{ argv: Array.from({ length: 65 }, () => 'x') }] },
      'AcceptanceSpec command 1 argv must hold 1 to 64 strings',
    ],
    [
      'rejects an argv entry over 4096 characters',
      { ...VALID, commands: [{ argv: ['x'.repeat(4097)] }] },
      'AcceptanceSpec command 1 argv entries must be strings of at most 4096 characters without NUL',
    ],
    [
      'rejects an argv entry containing NUL',
      { ...VALID, commands: [{ argv: ['ok', String.fromCodePoint(0)] }] },
      'AcceptanceSpec command 1 argv entries must be strings of at most 4096 characters without NUL',
    ],
    [
      'rejects an empty program',
      { ...VALID, commands: [{ argv: [''] }] },
      'AcceptanceSpec command 1 argv[0] must name a program',
    ],
    [
      'rejects a program with leading whitespace',
      { ...VALID, commands: [{ argv: [' yarn'] }] },
      'AcceptanceSpec command 1 argv[0] must name a program',
    ],
    [
      'rejects a program that starts with a dash',
      { ...VALID, commands: [{ argv: ['--help'] }] },
      'AcceptanceSpec command 1 argv[0] must name a program',
    ],
    [
      'rejects a single argv entry that looks like a shell string',
      { ...VALID, commands: [{ argv: ['yarn build'] }] },
      'AcceptanceSpec command 1 looks like a shell string; give each argument its own argv entry',
    ],
    [
      'rejects an absolute shell path',
      { ...VALID, commands: [{ argv: ['/bin/sh', '-c', 'x'] }] },
      'AcceptanceSpec command 1 must not run a shell',
    ],
    [
      'rejects a shell basename',
      { ...VALID, commands: [{ argv: ['bash', 'x.sh'] }] },
      'AcceptanceSpec command 1 must not run a shell',
    ],
    [
      'rejects coverage with an extra key',
      {
        ...VALID,
        commands: [
          {
            argv: ['x'],
            coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1, extra: true },
          },
        ],
      },
      'AcceptanceSpec command 1 coverage must be { reader, unitKind, minUnits }',
    ],
    [
      'rejects an unknown coverage reader',
      {
        ...VALID,
        commands: [{ argv: ['x'], coverage: { reader: 'jest', unitKind: 'tests', minUnits: 1 } }],
      },
      'AcceptanceSpec command 1 names an unknown coverage reader',
    ],
    [
      'rejects a coverage unitKind that does not match its reader',
      {
        ...VALID,
        commands: [
          { argv: ['x'], coverage: { reader: 'vitest-summary', unitKind: 'files', minUnits: 1 } },
        ],
      },
      'AcceptanceSpec command 1 coverage unitKind does not match its reader',
    ],
    [
      'rejects minUnits of zero',
      { ...VALID, commands: [{ argv: ['x'], coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 0 } }] },
      'AcceptanceSpec command 1 coverage minUnits must be a whole number of at least 1',
    ],
    [
      'rejects a fractional minUnits',
      { ...VALID, commands: [{ argv: ['x'], coverage: { reader: 'vitest-summary', unitKind: 'tests', minUnits: 1.5 } }] },
      'AcceptanceSpec command 1 coverage minUnits must be a whole number of at least 1',
    ],
  ];

  it.each(rows)('%s', (_name, input, message) => {
    const result = AcceptanceSpec.create(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.message).toBe(message);
    }
  });

  it('accepts multi-entry argv with a space-free program and spaces in later arguments', () => {
    const first = AcceptanceSpec.create({ ...VALID, commands: [{ argv: ['yarn', 'build'] }] });
    expect(first.success).toBe(true);

    const second = AcceptanceSpec.create({
      ...VALID,
      commands: [{ argv: ['scripts/lane-gate', 'x y'] }],
    });
    expect(second.success).toBe(true);
  });

  it('maps each coverage reader to its unit kind', () => {
    expect(GATE_COVERAGE_READER_UNIT_KINDS).toEqual({
      'vitest-summary': 'tests',
      'hexagen-lint-json': 'files',
      'eslint-json': 'files',
    });
  });
});

describe('BriefPackage acceptance spec', () => {
  const base = {
    attemptId: 'attempt-1',
    briefDigest: 'digest',
    prosePath: '.lane/brief.md',
    manifestPath: '.lane/brief-manifest.json',
    baseCommit: 'abc123',
    policyRevision: 'policy-7',
    independentReviewer: 'reviewer-model',
    ownedPaths: ['packages/app-a/**'],
  };

  it('requires an acceptance spec', () => {
    const result = BriefPackage.create(base as unknown as BriefPackageProps);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.message).toBe('BriefPackage requires an acceptance spec');
    }
  });

  it('keeps the acceptance spec and exposes it', () => {
    const specResult = AcceptanceSpec.create(VALID);
    expect(specResult.success).toBe(true);
    if (!specResult.success || specResult.value === undefined) return;
    const spec = specResult.value;

    const result = BriefPackage.create({ ...base, acceptanceSpec: spec });
    expect(result.success).toBe(true);
    if (!result.success || result.value === undefined) return;
    expect(result.value.getAcceptanceSpec().equals(spec)).toBe(true);
  });
});
