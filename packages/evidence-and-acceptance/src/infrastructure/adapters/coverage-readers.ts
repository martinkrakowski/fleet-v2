/**
 * Coverage readers turn a check's full combined output into `CheckCoverage`.
 * A reader that finds no count returns `{ ran: false, reason: 'no count in
 * output' }`; they never run anything.
 */

import type { CheckCoverage, CoverageUnitKind } from '../../domain/check-coverage.js';

export type CoverageReaderName = 'vitest-summary' | 'hexagen-lint-json' | 'eslint-json';

/** The one unit kind each reader produces; a declaration with another kind is malformed. */
export const COVERAGE_READER_UNIT_KINDS: Readonly<Record<CoverageReaderName, CoverageUnitKind>> = {
  'vitest-summary': 'tests',
  'hexagen-lint-json': 'files',
  'eslint-json': 'files',
};

export const COVERAGE_READER_NAMES: readonly CoverageReaderName[] = [
  'vitest-summary', 'hexagen-lint-json', 'eslint-json',
];

const NO_COUNT: CheckCoverage = { ran: false, reason: 'no count in output' };

const ESC = String.fromCodePoint(0x1b);
const ANSI_SGR = new RegExp(ESC + '\\[[0-9;]*m', 'g');

export function isCoverageReaderName(value: unknown): value is CoverageReaderName {
  return COVERAGE_READER_NAMES.includes(value as CoverageReaderName);
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR, '');
}

export function readVitestSummaryCoverage(output: string): CheckCoverage {
  let found = false;
  let total = 0;
  for (const rawLine of stripAnsi(output).split('\n')) {
    const line = rawLine.trimEnd();
    const at = line.indexOf('Tests  ');
    if (at === -1 || (at > 0 && line[at - 1] !== ' ')) {
      continue;
    }
    const rest = line.slice(at + 'Tests  '.length).trim();
    if (rest === 'no tests') {
      found = true;
      continue;
    }
    if (!rest.endsWith(')')) {
      continue;
    }
    const open = rest.lastIndexOf(' (');
    if (open === -1) {
      continue;
    }
    const totalText = rest.slice(open + 2, rest.length - 1);
    if (!/^\d+$/.test(totalText)) {
      continue;
    }
    const parts = rest.slice(0, open).split(' | ');
    let lineExecuted = 0;
    let lineValid = true;
    for (const part of parts) {
      const match = /^(\d+) (failed|passed|expected fail|skipped|todo)$/.exec(part);
      if (match === null) {
        lineValid = false;
        break;
      }
      if (match[2] !== 'skipped' && match[2] !== 'todo') {
        lineExecuted += Number(match[1]);
      }
    }
    if (!lineValid) {
      continue;
    }
    found = true;
    total += lineExecuted;
  }
  if (!found) {
    return { ...NO_COUNT };
  }
  if (!Number.isSafeInteger(total)) {
    return { ran: false, reason: 'count out of range' };
  }
  return { ran: true, unitKind: 'tests', units: total };
}

export function readHexagenLintJsonCoverage(output: string): CheckCoverage {
  let filesScanned: number | undefined;
  for (const rawLine of stripAnsi(output).split('\n')) {
    const open = rawLine.indexOf('{');
    if (open === -1) {
      continue;
    }
    const candidate = rawLine.slice(open).trim();
    if (!candidate.endsWith('}')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (!Array.isArray(record.introduced) || !Array.isArray(record.fresh)) {
      continue;
    }
    const scanned = record.filesScanned;
    if (typeof scanned !== 'number' || !Number.isSafeInteger(scanned) || scanned < 0) {
      continue;
    }
    filesScanned = scanned;
  }
  return filesScanned === undefined
    ? { ...NO_COUNT }
    : { ran: true, unitKind: 'files', units: filesScanned };
}

export function readEslintJsonCoverage(output: string): CheckCoverage {
  let accepted: unknown[] | undefined;
  for (const rawLine of stripAnsi(output).split('\n')) {
    const open = rawLine.indexOf('[');
    if (open === -1) {
      continue;
    }
    const candidate = rawLine.slice(open).trim();
    if (!candidate.endsWith(']')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    let valid = true;
    for (const element of parsed) {
      if (
        typeof element !== 'object' ||
        element === null ||
        typeof (element as { filePath?: unknown }).filePath !== 'string' ||
        !Array.isArray((element as { messages?: unknown }).messages)
      ) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      continue;
    }
    accepted = parsed;
  }
  if (accepted === undefined) {
    return { ...NO_COUNT };
  }
  let units = 0;
  for (const element of accepted) {
    const messages = (element as { messages: unknown[] }).messages;
    if (
      messages.length === 1 &&
      (messages[0] as { ruleId?: unknown }).ruleId === null &&
      typeof (messages[0] as { message?: unknown }).message === 'string' &&
      (messages[0] as { message: string }).message.startsWith('File ignored')
    ) {
      continue;
    }
    units += 1;
  }
  return { ran: true, unitKind: 'files', units };
}

export function readCheckCoverage(reader: CoverageReaderName, output: string): CheckCoverage {
  try {
    switch (reader) {
      case 'vitest-summary':
        return readVitestSummaryCoverage(output);
      case 'hexagen-lint-json':
        return readHexagenLintJsonCoverage(output);
      case 'eslint-json':
        return readEslintJsonCoverage(output);
    }
  } catch {
    return { ran: false, reason: 'coverage reader failed' };
  }
}
