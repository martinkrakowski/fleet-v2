import { describe, expect, it } from 'vitest';

import {
  readCheckCoverage,
  readEslintJsonCoverage,
  readHexagenLintJsonCoverage,
  readVitestSummaryCoverage,
} from '../coverage-readers.js';
import { isCheckCoverage } from '../../../domain/check-coverage.js';

const VITEST_NORMAL = [
  ' RUN  v4.1.11 /work/packages/evidence-and-acceptance',
  '',
  ' ✓ src/domain/__tests__/check-coverage.test.ts (14 tests) 6ms',
  ' ✓ src/infrastructure/adapters/__tests__/VerificationExecutorAdapter.test.ts (22 tests) 120ms',
  '',
  ' Test Files  2 passed (2)',
  '      Tests  36 passed (36)',
  '   Start at  10:12:03',
  '   Duration  1.02s (transform 80ms, setup 0ms, import 300ms, tests 126ms, environment 0ms)',
].join('\n');
const VITEST_FAILURES = ' Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 30 passed | 1 expected fail | 3 skipped | 1 todo (37)\n';
const VITEST_ALL_SKIPPED = ' Test Files  1 skipped (1)\n      Tests  5 skipped (5)\n';
const VITEST_ZERO_TESTS = ' Test Files  1 passed (1)\n      Tests  no tests\n';
const VITEST_NO_FILES = 'No test files found, exiting with code 0\n\nfilter: no-such-test\n';
const VITEST_MISSING_SUMMARY = ' RUN  v4.1.11 /work\n\n ✓ src/a.test.ts (3 tests) 2ms\n';
const ESC = String.fromCodePoint(0x1b);
const VITEST_COLOURED = ESC + '[2m      Tests ' + ESC + '[22m ' + ESC + '[1m' + ESC + '[32m36 passed' + ESC + '[39m' + ESC + '[22m' + ESC + '[90m (36)' + ESC + '[39m\n';
const VITEST_TURBO = '@fleet/a:test:       Tests  10 passed (10)\n@fleet/b:test:       Tests  4 passed | 1 skipped (5)\n';

const HEXAGEN_NORMAL = '{"fresh":[],"baselined":[],"stale":[],"expired":[],"introduced":[],"baselineGrowth":[],"filesScanned":142}\n[arch-lint] Ratchet: 1 baseline entry no longer reproduces';
const HEXAGEN_NO_FILES = '{"fresh":[],"baselined":[],"stale":[],"expired":[],"introduced":[],"baselineGrowth":[],"filesScanned":0}\n';
const HEXAGEN_NULL_COUNT = '{"fresh":[],"baselined":[],"stale":[],"expired":[],"introduced":[],"baselineGrowth":[],"filesScanned":null}\n';
const HEXAGEN_MISSING = '[arch-lint] Could not find .architecture/manifest.yaml\n';

const ESLINT_FILE = (path: string) => `{"filePath":"${path}","messages":[],"suppressedMessages":[],"errorCount":0,"fatalErrorCount":0,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"usedDeprecatedRules":[]}`;
const ESLINT_NORMAL = '[' + ESLINT_FILE('/w/src/a.ts') + ',' + ESLINT_FILE('/w/src/b.ts') + ']\n';
const ESLINT_NO_FILES = '[]\n';
const ESLINT_IGNORED = '[{"filePath":"/w/dist/x.js","messages":[{"ruleId":null,"fatal":false,"severity":1,"message":"File ignored because of a matching ignore pattern. Use \\"--no-ignore\\" to disable file ignore settings."}],"suppressedMessages":[],"errorCount":0,"fatalErrorCount":0,"warningCount":1,"fixableErrorCount":0,"fixableWarningCount":0,"usedDeprecatedRules":[]},' + ESLINT_FILE('/w/src/a.ts') + ']\n';
const ESLINT_MISSING = '\nOops! Something went wrong! :(\n\nESLint: 9.39.5\n\nNo files matching the pattern "nope" were found.\n';

describe('readVitestSummaryCoverage', () => {
  it('counts executed tests from a normal summary', () => {
    expect(readVitestSummaryCoverage(VITEST_NORMAL)).toEqual({ ran: true, unitKind: 'tests', units: 36 });
  });

  it('sums failed, passed and expected fail, ignoring skipped and todo', () => {
    expect(readVitestSummaryCoverage(VITEST_FAILURES)).toEqual({ ran: true, unitKind: 'tests', units: 33 });
  });

  it('counts zero executed tests when every test is skipped', () => {
    expect(readVitestSummaryCoverage(VITEST_ALL_SKIPPED)).toEqual({ ran: true, unitKind: 'tests', units: 0 });
  });

  it('counts zero executed tests for the no tests line', () => {
    expect(readVitestSummaryCoverage(VITEST_ZERO_TESTS)).toEqual({ ran: true, unitKind: 'tests', units: 0 });
  });

  it('returns no count when there are no test files', () => {
    expect(readVitestSummaryCoverage(VITEST_NO_FILES)).toEqual({ ran: false, reason: 'no count in output' });
  });

  it('returns no count when the summary line is missing', () => {
    expect(readVitestSummaryCoverage(VITEST_MISSING_SUMMARY)).toEqual({ ran: false, reason: 'no count in output' });
  });

  it('strips ANSI colour codes before parsing', () => {
    expect(readVitestSummaryCoverage(VITEST_COLOURED)).toEqual({ ran: true, unitKind: 'tests', units: 36 });
  });

  it('sums executed tests across turbo workspace summaries', () => {
    expect(readVitestSummaryCoverage(VITEST_TURBO)).toEqual({ ran: true, unitKind: 'tests', units: 14 });
  });

  it('never treats the Test Files line as a Tests line', () => {
    expect(readVitestSummaryCoverage(' Test Files  2 passed (2)\n')).toEqual({ ran: false, reason: 'no count in output' });
  });
});

describe('readHexagenLintJsonCoverage', () => {
  it('reads filesScanned from the last accepted JSON line', () => {
    expect(readHexagenLintJsonCoverage(HEXAGEN_NORMAL)).toEqual({ ran: true, unitKind: 'files', units: 142 });
  });

  it('accepts a zero file count', () => {
    expect(readHexagenLintJsonCoverage(HEXAGEN_NO_FILES)).toEqual({ ran: true, unitKind: 'files', units: 0 });
  });

  it('rejects a null filesScanned', () => {
    expect(readHexagenLintJsonCoverage(HEXAGEN_NULL_COUNT)).toEqual({ ran: false, reason: 'no count in output' });
  });

  it('returns no count when no JSON line is present', () => {
    expect(readHexagenLintJsonCoverage(HEXAGEN_MISSING)).toEqual({ ran: false, reason: 'no count in output' });
  });
});

describe('readEslintJsonCoverage', () => {
  it('counts linted files', () => {
    expect(readEslintJsonCoverage(ESLINT_NORMAL)).toEqual({ ran: true, unitKind: 'files', units: 2 });
  });

  it('accepts an empty array as zero files', () => {
    expect(readEslintJsonCoverage(ESLINT_NO_FILES)).toEqual({ ran: true, unitKind: 'files', units: 0 });
  });

  it('excludes File ignored entries', () => {
    expect(readEslintJsonCoverage(ESLINT_IGNORED)).toEqual({ ran: true, unitKind: 'files', units: 1 });
  });

  it('returns no count when no JSON array is present', () => {
    expect(readEslintJsonCoverage(ESLINT_MISSING)).toEqual({ ran: false, reason: 'no count in output' });
  });
});

describe('readCheckCoverage', () => {
  it('returns a valid CheckCoverage for every fixture', () => {
    const fixtures = [
      ['vitest-summary', VITEST_NORMAL],
      ['vitest-summary', VITEST_FAILURES],
      ['vitest-summary', VITEST_ALL_SKIPPED],
      ['vitest-summary', VITEST_ZERO_TESTS],
      ['vitest-summary', VITEST_NO_FILES],
      ['vitest-summary', VITEST_MISSING_SUMMARY],
      ['vitest-summary', VITEST_COLOURED],
      ['vitest-summary', VITEST_TURBO],
      ['vitest-summary', ' Test Files  2 passed (2)\n'],
      ['hexagen-lint-json', HEXAGEN_NORMAL],
      ['hexagen-lint-json', HEXAGEN_NO_FILES],
      ['hexagen-lint-json', HEXAGEN_NULL_COUNT],
      ['hexagen-lint-json', HEXAGEN_MISSING],
      ['eslint-json', ESLINT_NORMAL],
      ['eslint-json', ESLINT_NO_FILES],
      ['eslint-json', ESLINT_IGNORED],
      ['eslint-json', ESLINT_MISSING],
    ] as const;
    for (const [reader, output] of fixtures) {
      expect(isCheckCoverage(readCheckCoverage(reader, output))).toBe(true);
    }
  });
});

describe('readVitestSummaryCoverage out-of-range counts (V2a, Luna minor)', () => {
  it('refuses a count beyond Number.MAX_SAFE_INTEGER instead of emitting unsafe units', () => {
    const coverage = readVitestSummaryCoverage('      Tests  9007199254740992 passed (9007199254740992)\n');
    expect(coverage).toEqual({ ran: false, reason: 'count out of range' });
  });
});
