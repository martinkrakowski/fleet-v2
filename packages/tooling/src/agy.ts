import { interpretAccountSignIn } from './sign-in.js';
import type { ModelListResult, ToolDescriptor, ToolModel } from './types.js';

const TABLE_HEADER: readonly string[] = ['ID', 'PROVIDER', 'VARIANTS'];

function splitTableRow(line: string): readonly string[] {
  return line.replace(/[ \t]+$/, '').split(/[ \t]{2,}/);
}

function dropEmptyEnds(output: string): readonly string[] {
  const lines = output.split(/\r?\n/);
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines;
}

/**
 * `agy models` prints an aligned three-column table: `ID  PROVIDER  VARIANTS`
 * (columns separated by two or more spaces; a `-` variants cell means the
 * model takes no variant). A different header, a row with a missing or
 * extra column, or a table with no row is `'unknown'`.
 */
function parseAgyModels(output: string): ModelListResult {
  const lines = dropEmptyEnds(output);
  if (lines.length < 2) {
    return 'unknown';
  }
  const header = splitTableRow(lines[0]);
  if (
    header.length !== TABLE_HEADER.length ||
    header.some((column, index) => column !== TABLE_HEADER[index])
  ) {
    return 'unknown';
  }
  const result: ToolModel[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitTableRow(line);
    if (cells.length !== TABLE_HEADER.length) {
      return 'unknown';
    }
    const id = cells[0].trim();
    if (id === '') {
      return 'unknown';
    }
    const variantsCell = cells[2].trim();
    if (variantsCell === '') {
      return 'unknown';
    }
    if (variantsCell === '-') {
      result.push({ id });
      continue;
    }
    const variants = variantsCell.split(',').map((variant) => variant.trim());
    if (variants.some((variant) => variant === '')) {
      return 'unknown';
    }
    result.push({ id, variants });
  }
  return result.length === 0 ? 'unknown' : result;
}

/**
 * agy is an orchestrator CLI that edits files but cannot run shell
 * commands: an edit-only seat whose checks and commits the orchestrator
 * performs. It drives providers of every cost class, so `mixed`.
 */
export const AGY_TOOL: ToolDescriptor = {
  id: 'agy',
  displayName: 'agy',
  detect: { argv: ['agy', '--version'] },
  signIn: {
    argv: ['agy', 'auth', 'status'],
    interpret: interpretAccountSignIn,
  },
  models: {
    argv: ['agy', 'models'],
    parse: parseAgyModels,
  },
  capabilities: {
    canRunCommands: false,
    readOnlyMode: false,
    needsAllowRules: false,
    headless: true,
  },
  invocation: {
    argvTemplate: ['agy', 'run', '-m', '{model}', '--variant', '{variant}', '{prompt}'],
  },
  costSource: 'mixed',
};
