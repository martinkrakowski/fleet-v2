// Lane SHT3 (shadow one-time criterion S11): compare fleet-v2's `lintBrief`
// and `parseBriefAnswer` against real shell verdicts captured from live runs
// of `brief-lint.sh` and the `sol-brief-run.sh` inline splitter. The captured
// fixture is read-only provenance; every place where fleet-v2 and the shell
// verdicts disagree is an owner-accepted exception recorded in the frozen
// `ACCEPTED_DIVERGENCES` map below with a typed reason. No production code is
// changed in this lane.
//
// Cost bounds of the functions under test (pure domain code): `parseBriefAnswer`
// and `lintBrief` are linear in the size of their string input (there is no
// other cap; the input is the whole answer or brief text); the secret-shape
// scans are linear in the registry sizes. Neither parse nor lint may be
// satisfied by a constant or the identity function: the corpus below asserts
// both accept and refuse verdicts and structured outputs that echo no input
// verbatim.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { lintBrief, parseBriefAnswer } from '../brief-answer.js';
import {
  compareShadowBriefVerdicts,
  SHADOW_DIVERGENCE_MAX,
  type ShadowBriefVerdictItem,
} from '../shadow-comparators.js';

/** Minimal typed shape of the captured fixture (never written by this lane). */
interface FixtureTool {
  readonly name: string;
  readonly sourcePath: string;
  readonly sha256: string;
}
interface FixtureEntry {
  readonly id: string;
  readonly tool: string;
  readonly exitCode: number;
  readonly verdict: string;
  readonly rules: readonly string[];
  readonly fleetVerdict: string;
  readonly agrees: boolean;
}
interface Fixture {
  readonly provenance: { readonly capturedAt: string; readonly tools: readonly FixtureTool[]; readonly note: string };
  readonly entries: readonly FixtureEntry[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/shell-brief-verdicts.json', import.meta.url), 'utf8'),
) as Fixture;

/**
 * The owner-accepted divergence classes between fleet-v2 and the shell tools.
 * Frozen: a divergence not listed here (or a stale entry) fails the corpus.
 */
type AcceptedDivergenceReason =
  | 'shell-stricter-checklist'
  | 'shell-splitter-notes-marker-optional'
  | 'shell-splitter-no-duplicate-marker-check'
  | 'shell-splitter-tolerates-leading-text'
  | 'shell-splitter-no-secret-scan'
  | 'shell-splitter-accepts-empty-dispatch';

const ACCEPTED_DIVERGENCES: Readonly<Record<string, AcceptedDivergenceReason>> = Object.freeze({
  'lint-01-full': 'shell-stricter-checklist',
  'lint-05-lowercase-heading': 'shell-stricter-checklist',
  'lint-07-inline-lines': 'shell-stricter-checklist',
  'lint-15-compact-line': 'shell-stricter-checklist',
  'parse-03-missing-notes-marker': 'shell-splitter-notes-marker-optional',
  'parse-05-duplicate-notes': 'shell-splitter-no-duplicate-marker-check',
  'parse-06-duplicate-dispatch': 'shell-splitter-no-duplicate-marker-check',
  'parse-07-text-before-notes': 'shell-splitter-tolerates-leading-text',
  'parse-08-dispatch-first': 'shell-splitter-tolerates-leading-text',
  'parse-09-github-pat': 'shell-splitter-no-secret-scan',
  'parse-10-empty-dispatch': 'shell-splitter-accepts-empty-dispatch',
  'parse-12-ghp-secret': 'shell-splitter-no-secret-scan',
  'parse-13-fine-grained-pat': 'shell-splitter-no-secret-scan',
});

// Secret-shaped literals are never written here: each token is assembled at
// runtime from unremarkable fragments, exactly as brief-answer.test.ts does.
const ghpToken = 'gh' + 'p_' + 'a'.repeat(30);
const githubPatToken = 'github' + '_pat_' + 'A'.repeat(24);
const githubPatTokenLower = 'github' + '_pat_' + 'a'.repeat(24);

// The full brief used verbatim by brief-answer.test.ts.
const fullBrief = [
  '# File list',
  '- packages/a.ts',
  '# Commands',
  'yarn build',
  '# Tier',
  '1',
  '# Size',
  'about 45 minutes',
  '# Commit',
  'one commit',
  '# Validity',
  'base branch: main',
  '## Hard to undo',
  'None',
  '## Assumptions',
  'Assume X',
  '## Challenge this',
  'Challenge Y',
].join('\n');

const imperativeProse = ['Please commit.', "Don't commit.", 'Never commit.', 'Do not commit changes.', 'Commit early and often.'];

/**
 * All 27 corpus inputs, rebuilt verbatim from brief-answer.test.ts (the
 * `lintBrief(42)` non-string case is not file-representable and is omitted
 * from the shell capture; the `{ nope: true }` non-string parse case likewise).
 */
const CORPUS_INPUTS: Readonly<Record<string, unknown>> = Object.freeze({
  // --- lintBrief corpus (run by brief-lint.sh) ---
  'lint-01-full': fullBrief,
  'lint-02-missing-hard-to-undo': fullBrief.replace('## Hard to undo\nNone\n', ''),
  'lint-03-four-missing': fullBrief
    .replace('# File list\n- packages/a.ts\n', '')
    .replace('# Tier\n1\n', '')
    .replace('# Validity\nbase branch: main\n', '')
    .replace('## Assumptions\nAssume X\n', ''),
  'lint-04-tier-empty-body': fullBrief.replace('# Tier\n1\n', '# Tier\n'),
  'lint-05-lowercase-heading': fullBrief.replace('## Hard to undo', '## hard to undo'),
  'lint-06-secret-ghp': fullBrief + '\n' + ghpToken,
  'lint-07-inline-lines': [
    '# File list',
    '- packages/a.ts',
    '# Commands',
    'yarn build',
    'Tier: 1',
    'Size: about 45 minutes',
    'Commit: one commit',
    '# Validity',
    'base branch: main',
    '## Hard to undo',
    'None',
    '## Assumptions',
    'Assume X',
    '## Challenge this',
    'Challenge Y',
  ].join('\n'),
  'lint-08-avoid-commit-prose': [
    '# File list',
    '- packages/a.ts',
    '# Commands',
    'yarn build',
    '# Tier',
    '1',
    '# Size',
    'about 45 minutes',
    'Avoid commit.',
    '# Validity',
    'base branch: main',
    '## Hard to undo',
    'None',
    '## Assumptions',
    'Assume X',
    '## Challenge this',
    'Challenge Y',
  ].join('\n'),
  'lint-09-imperative-prose-1': fullBrief.replace('# Commit\none commit\n', `${imperativeProse[0]}\n`),
  'lint-10-imperative-prose-2': fullBrief.replace('# Commit\none commit\n', `${imperativeProse[1]}\n`),
  'lint-11-imperative-prose-3': fullBrief.replace('# Commit\none commit\n', `${imperativeProse[2]}\n`),
  'lint-12-imperative-prose-4': fullBrief.replace('# Commit\none commit\n', `${imperativeProse[3]}\n`),
  'lint-13-imperative-prose-5': fullBrief.replace('# Commit\none commit\n', `${imperativeProse[4]}\n`),
  'lint-15-compact-line': [
    '# File list',
    '- packages/a.ts',
    '# Commands',
    'yarn build',
    'Tier 1. Size: about 45 minutes, one commit.',
    '# Validity',
    'base branch: main',
    '## Hard to undo',
    'None',
    '## Assumptions',
    'Assume X',
    '## Challenge this',
    'Challenge Y',
  ].join('\n'),

  // --- parseBriefAnswer corpus (run by the sol-brief-run.sh inline splitter) ---
  'parse-01-wellformed': [
    '===NOTES===',
    'Candidate notes paragraph one.',
    '',
    'Candidate notes paragraph two.',
    '===DISPATCH===',
    '# CO15',
    '',
    'Tier 1. Size: about 45 minutes, one commit.',
  ].join('\n'),
  'parse-02-notes-not-in-dispatch': [
    '===NOTES===',
    'Distinctive notes sentence xyzzy-frobnicate-thud.',
    '===DISPATCH===',
    'Dispatch body.',
  ].join('\n'),
  'parse-03-missing-notes-marker': '===DISPATCH===\ndispatch',
  'parse-04-missing-dispatch-marker': '===NOTES===\nnotes',
  'parse-05-duplicate-notes': ['===NOTES===', '===NOTES===', '===DISPATCH===', 'dispatch'].join('\n'),
  'parse-06-duplicate-dispatch': ['===NOTES===', '===DISPATCH===', '===DISPATCH===', 'dispatch'].join('\n'),
  'parse-07-text-before-notes': ['preamble', '===NOTES===', 'notes', '===DISPATCH===', 'dispatch'].join('\n'),
  'parse-08-dispatch-first': ['===DISPATCH===', 'dispatch', '===NOTES===', 'notes'].join('\n'),
  'parse-09-github-pat': ['===NOTES===', 'notes', '===DISPATCH===', `brief ${githubPatToken}`].join('\n'),
  'parse-10-empty-dispatch': ['===NOTES===', 'notes', '===DISPATCH==='].join('\n'),
  'parse-11-empty-answer': '   \n  ',
  'parse-12-ghp-secret': ['===NOTES===', ghpToken, '===DISPATCH===', 'dispatch'].join('\n'),
  'parse-13-fine-grained-pat': ['===NOTES===', 'notes', '===DISPATCH===', 'token ' + githubPatTokenLower].join('\n'),
});

/** The binary verdict fed to `compareShadowBriefVerdicts` (its pattern is `[a-z0-9][a-z0-9-]*`). */
type BinaryVerdict = 'accept' | 'refuse';

interface FleetOutcome {
  readonly binary: BinaryVerdict;
  readonly detailed: string;
}

function fleetParseOutcome(input: unknown): FleetOutcome {
  const result = parseBriefAnswer(input);
  if (result.ok) return { binary: 'accept', detailed: 'accept' };
  return { binary: 'refuse', detailed: 'refuse:' + result.reason };
}

function fleetLintOutcome(input: unknown): FleetOutcome {
  const result = lintBrief(input);
  if (result.ok) return { binary: 'accept', detailed: 'accept' };
  return { binary: 'refuse', detailed: 'refuse:' + result.findings.map((finding) => finding.rule).join(',') };
}

function corpusOutcome(id: string): FleetOutcome {
  const input = CORPUS_INPUTS[id];
  if (input === undefined) {
    throw new Error(`corpus input missing for ${id}`);
  }
  return id.startsWith('lint-') ? fleetLintOutcome(input) : fleetParseOutcome(input);
}

const fixtureById = new Map(fixture.entries.map((entry) => [entry.id, entry]));

describe('shadow brief corpus (S11)', () => {
  it('covers every fixture entry id with no missing or extra corpus inputs', () => {
    const fixtureIds = fixture.entries.map((entry) => entry.id).sort();
    const corpusIds = Object.keys(CORPUS_INPUTS).sort();
    expect(corpusIds).toEqual(fixtureIds);
    expect(corpusIds.length).toBe(fixture.entries.length);
    expect(fixture.entries.length).toBe(27);
  });

  it('records fixture provenance with tool names and sha256 digests', () => {
    expect(typeof fixture.provenance.capturedAt).toBe('string');
    expect(fixture.provenance.capturedAt.length).toBeGreaterThan(0);
    const tools = new Map(fixture.provenance.tools.map((tool) => [tool.name, tool.sha256]));
    expect(tools.get('fleet:orchestrator/brief-lint.sh')).toBe(
      'bbe902438437ede2be893c718354c2db83ba972775cb80897736fb86dd092002',
    );
    expect(tools.get('fleet:orchestrator/sol-brief-run.sh#inline-splitter')).toBe(
      '4a8bdaca8d32024e8668b1b9ce1ebfff1c6b622c059fc5172143e2e2d5c7975d',
    );
    expect(tools.get('fleet:tools/fleet-v2-orchestrator/lane/split-agy-brief.py')).toBe(
      '19028449982d2612cf176036dd9d938dad0f2ef436368bed6852723df6f7e867',
    );
    expect(tools.size).toBe(3);
    for (const digest of tools.values()) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('matches fixture fleetVerdict for every corpus entry', () => {
    for (const entry of fixture.entries) {
      expect(corpusOutcome(entry.id).detailed, entry.id).toBe(entry.fleetVerdict);
    }
  });

  it('compares fleet and shell verdicts through compareShadowBriefVerdicts', () => {
    const fleet = fixture.entries.map((entry) => ({ briefId: entry.id, verdict: corpusOutcome(entry.id).binary }));
    const shell = fixture.entries.map((entry) => ({ briefId: entry.id, verdict: entry.verdict as BinaryVerdict }));
    const comparison = compareShadowBriefVerdicts({ fleet, shell });
    expect(comparison.kind).toBe('brief-verdict');
    expect(comparison.compared).toBe(fixture.entries.length);
    expect(comparison.fleetCount).toBe(fixture.entries.length);
    expect(comparison.shellCount).toBe(fixture.entries.length);
    expect(comparison.truncated).toBe(false);
    expect(comparison.divergences.length).toBe(Object.keys(ACCEPTED_DIVERGENCES).length);
    expect(Object.keys(ACCEPTED_DIVERGENCES).length).toBe(13);
  });

  it('records every disagreeing entry in ACCEPTED_DIVERGENCES', () => {
    const fleet = fixture.entries.map((entry) => ({ briefId: entry.id, verdict: corpusOutcome(entry.id).binary }));
    const shell = fixture.entries.map((entry) => ({ briefId: entry.id, verdict: entry.verdict as BinaryVerdict }));
    const divergences = compareShadowBriefVerdicts({ fleet, shell }).divergences;
    for (const divergence of divergences) {
      expect(ACCEPTED_DIVERGENCES[divergence.key], divergence.key).toBeTruthy();
    }
    for (const entry of fixture.entries) {
      if (entry.agrees === false) {
        const reason = ACCEPTED_DIVERGENCES[entry.id];
        expect(reason, entry.id).toBeTruthy();
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(0);
      }
    }
  });

  it('contains no stale exceptions in ACCEPTED_DIVERGENCES', () => {
    const fleet = fixture.entries.map((entry) => ({ briefId: entry.id, verdict: corpusOutcome(entry.id).binary }));
    const shell = fixture.entries.map((entry) => ({ briefId: entry.id, verdict: entry.verdict as BinaryVerdict }));
    const divergenceKeys = new Set(compareShadowBriefVerdicts({ fleet, shell }).divergences.map((d) => d.key));
    for (const id of Object.keys(ACCEPTED_DIVERGENCES)) {
      expect(divergenceKeys.has(id), id).toBe(true);
      const entry = fixtureById.get(id);
      expect(entry, id).toBeDefined();
      expect(entry?.agrees).toBe(false);
    }
  });

  it('confirms every agreeing entry agrees across fleet and shell', () => {
    const divergenceKeys = new Set(
      compareShadowBriefVerdicts({
        fleet: fixture.entries.map((entry) => ({ briefId: entry.id, verdict: corpusOutcome(entry.id).binary })),
        shell: fixture.entries.map((entry) => ({ briefId: entry.id, verdict: entry.verdict as BinaryVerdict })),
      }).divergences.map((d) => d.key),
    );
    for (const entry of fixture.entries) {
      if (entry.agrees === true) {
        expect(corpusOutcome(entry.id).binary, entry.id).toBe(entry.verdict);
        expect(divergenceKeys.has(entry.id), entry.id).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Refusals and hostile input. All three functions are pure domain functions:
// no filesystem, subprocess, network, clock, or optional port methods exist
// here. Every refusal below is a typed value; nothing throws, and an unknown
// state is never treated as success. Each test names its hostile case and
// asserts the specific code, not merely that nothing threw.
// ---------------------------------------------------------------------------

/** Getter object with a call counter: the getter must never run. */
function getterBearing(value: unknown): { target: Record<string, unknown>; counter: () => number } {
  let calls = 0;
  const target: Record<string, unknown> = {};
  Object.defineProperty(target, 'hostile', {
    enumerable: true,
    get() {
      calls += 1;
      return value;
    },
  });
  return { target, counter: () => calls };
}

/** Proxy over `target` with a get-trap counter. */
function countingProxy(target: unknown): { proxy: unknown; counter: () => number } {
  let gets = 0;
  const proxy = new Proxy(target as object, {
    get() {
      gets += 1;
      return Reflect.get(target as object, 'hostile');
    },
  });
  return { proxy, counter: () => gets };
}

/** Cast a hostile side value to the comparator's item-list type for the call. */
function asItems(value: unknown): readonly ShadowBriefVerdictItem[] {
  return value as unknown as readonly ShadowBriefVerdictItem[];
}

function prototypePolluted(): Record<string, unknown> {
  // `JSON.parse` materialises `__proto__` as an ordinary own key.
  return JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as Record<string, unknown>;
}

function hugeSparseArray(): unknown[] {
  const sparse: unknown[] = [];
  sparse.length = 2 ** 32 - 1; // refused before any traversal
  return sparse;
}

describe('parseBriefAnswer hostile input', () => {
  it('refuses null with not-a-string', () => {
    expect(parseBriefAnswer(null)).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('refuses undefined with not-a-string', () => {
    expect(parseBriefAnswer(undefined)).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('refuses a number where a string is due with not-a-string', () => {
    expect(parseBriefAnswer(42)).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('refuses a sparse array with not-a-string', () => {
    const sparse: unknown[] = [];
    sparse.length = 3;
    expect(parseBriefAnswer(sparse)).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('refuses an array-like object with not-a-string', () => {
    expect(parseBriefAnswer({ length: 1, 0: '===NOTES===' })).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('refuses an enormous-length sparse array with not-a-string', () => {
    expect(parseBriefAnswer(hugeSparseArray())).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('refuses a getter-bearing object without running the getter', () => {
    const { target, counter } = getterBearing('===NOTES===');
    expect(parseBriefAnswer(target)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(counter()).toBe(0);
  });

  it('refuses a Proxy over a valid input with not-a-string and no get trap ran', () => {
    // A Proxy target must be an object, so the closest hostile analogue for a
    // string input is a Proxy over a boxed string: an object at the boundary,
    // refused as not-a-string, with no get trap read.
    const { proxy, counter } = countingProxy(Object('===NOTES===\nnotes\n===DISPATCH===\ndispatch'));
    expect(parseBriefAnswer(proxy)).toEqual({ ok: false, reason: 'not-a-string' });
    expect(counter()).toBe(0);
  });

  it('refuses prototype-polluting keys from JSON.parse with not-a-string', () => {
    expect(parseBriefAnswer(prototypePolluted())).toEqual({ ok: false, reason: 'not-a-string' });
  });

  it('is not satisfiable by a constant verdict', () => {
    // A function that always returned accept would fail parse-03; one that
    // always returned refuse would fail parse-01.
    expect(fleetParseOutcome(CORPUS_INPUTS['parse-03-missing-notes-marker']).binary).toBe('refuse');
    expect(fleetParseOutcome(CORPUS_INPUTS['parse-01-wellformed']).binary).toBe('accept');
  });

  it('does not echo its input back (non-identity)', () => {
    const input = CORPUS_INPUTS['parse-01-wellformed'];
    const result = parseBriefAnswer(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).not.toEqual(input);
    expect(result.dispatch).not.toBe(input);
    expect(result.dispatch).toBe('# CO15\n\nTier 1. Size: about 45 minutes, one commit.');
    expect(result.notes).toBe('Candidate notes paragraph one.\n\nCandidate notes paragraph two.');
  });
});

describe('lintBrief hostile input', () => {
  const notABrief = { ok: false, findings: [{ rule: 'not-a-brief', label: '' }] };

  it('refuses null with not-a-brief', () => {
    expect(lintBrief(null)).toEqual(notABrief);
  });

  it('refuses undefined with not-a-brief', () => {
    expect(lintBrief(undefined)).toEqual(notABrief);
  });

  it('refuses a number where a string is due with not-a-brief', () => {
    expect(lintBrief(42)).toEqual(notABrief);
  });

  it('refuses a non-iterable object where a brief is due with not-a-brief', () => {
    expect(lintBrief({ sections: 'nope' })).toEqual(notABrief);
  });

  it('refuses a sparse array with not-a-brief', () => {
    const sparse: unknown[] = [];
    sparse.length = 3;
    expect(lintBrief(sparse)).toEqual(notABrief);
  });

  it('refuses an array-like object with not-a-brief', () => {
    expect(lintBrief({ length: 1, 0: '# File list' })).toEqual(notABrief);
  });

  it('refuses an enormous-length sparse array with not-a-brief', () => {
    expect(lintBrief(hugeSparseArray())).toEqual(notABrief);
  });

  it('refuses a getter-bearing object without running the getter', () => {
    const { target, counter } = getterBearing(fullBrief);
    expect(lintBrief(target)).toEqual(notABrief);
    expect(counter()).toBe(0);
  });

  it('refuses a Proxy over a valid input with not-a-brief and no get trap ran', () => {
    const { proxy, counter } = countingProxy(Object(fullBrief));
    expect(lintBrief(proxy)).toEqual(notABrief);
    expect(counter()).toBe(0);
  });

  it('refuses prototype-polluting keys from JSON.parse with not-a-brief', () => {
    expect(lintBrief(prototypePolluted())).toEqual(notABrief);
  });

  it('is not satisfiable by a constant verdict', () => {
    // A constant accept fails lint-02; a constant refuse fails lint-01.
    expect(fleetLintOutcome(CORPUS_INPUTS['lint-02-missing-hard-to-undo']).binary).toBe('refuse');
    expect(fleetLintOutcome(CORPUS_INPUTS['lint-01-full']).binary).toBe('accept');
  });

  it('does not echo its input back (non-identity)', () => {
    const input = CORPUS_INPUTS['lint-01-full'];
    const result = lintBrief(input);
    expect(result.ok).toBe(true);
    expect(result).not.toEqual(input);
    expect(result.findings).toEqual([]);
    // An identity echo of lint-02 would claim ok without the missing section.
    expect(lintBrief(CORPUS_INPUTS['lint-02-missing-hard-to-undo'])).toEqual({
      ok: false,
      findings: [{ rule: 'missing-hard-to-undo', label: 'Hard to undo' }],
    });
  });
});

describe('compareShadowBriefVerdicts hostile input', () => {
  const validItem = { briefId: 'CO15', verdict: 'accept' };
  const validInput = { fleet: [validItem], shell: [validItem] };

  it('refuses a non-array side with invalid-item', () => {
    const result = compareShadowBriefVerdicts({ fleet: asItems('not-a-list'), shell: [] });
    expect(result.equal).toBe(false);
    expect(result.divergences).toEqual([{ key: 'invalid-fleet-list', code: 'invalid-item', fleet: null, shell: null }]);
  });

  it('refuses a non-array shell side with invalid-item', () => {
    const result = compareShadowBriefVerdicts({ fleet: asItems(7), shell: asItems('not-a-list') });
    expect(result.equal).toBe(false);
    expect(result.divergences).toEqual([
      { key: 'invalid-fleet-list', code: 'invalid-item', fleet: null, shell: null },
      { key: 'invalid-shell-list', code: 'invalid-item', fleet: null, shell: null },
    ]);
  });

  it('refuses an invalid item with invalid-item', () => {
    const result = compareShadowBriefVerdicts({ fleet: asItems(['nope']), shell: [] });
    expect(result.equal).toBe(false);
    expect(result.divergences).toEqual([{ key: 'invalid-fleet-0', code: 'invalid-item', fleet: null, shell: null }]);
  });

  it('yields exactly the plain-data result for a Proxy item with a get counter of 0', () => {
    const { proxy, counter } = countingProxy(validItem);
    const proxied = compareShadowBriefVerdicts({ fleet: asItems([proxy]), shell: [validItem] });
    const plain = compareShadowBriefVerdicts({ fleet: [validItem], shell: [validItem] });
    expect(proxied).toEqual(plain);
    expect(proxied.equal).toBe(true);
    expect(counter()).toBe(0);
  });

  it('caps listed divergences at SHADOW_DIVERGENCE_MAX and reports truncation', () => {
    const fleet: Array<{ briefId: string; verdict: string }> = [];
    for (let i = 0; i < SHADOW_DIVERGENCE_MAX + 5; i += 1) {
      fleet.push({ briefId: `b${i}`, verdict: 'accept' });
    }
    const shell = fleet.map((item) => ({ briefId: item.briefId, verdict: 'refuse' }));
    const result = compareShadowBriefVerdicts({ fleet, shell });
    expect(result.truncated).toBe(true);
    expect(result.divergences.length).toBe(SHADOW_DIVERGENCE_MAX);
  });

  it('is not satisfiable by a constant verdict', () => {
    // A constant equal:true fails a value-differs pair; a constant false
    // fails a matched pair.
    const differing = compareShadowBriefVerdicts({
      fleet: [{ briefId: 'a', verdict: 'accept' }],
      shell: [{ briefId: 'a', verdict: 'refuse' }],
    });
    expect(differing.equal).toBe(false);
    expect(differing.divergences[0]?.code).toBe('value-differs');
    expect(compareShadowBriefVerdicts(validInput).equal).toBe(true);
  });

  it('does not echo its input back (non-identity)', () => {
    const result = compareShadowBriefVerdicts(validInput);
    expect(result).not.toEqual(validInput);
    expect(result.kind).toBe('brief-verdict');
    expect(result.compared).toBe(1);
    expect(result.divergences).toEqual([]);
  });
});
