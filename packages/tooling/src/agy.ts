import { interpretAccountSignIn } from './sign-in.js';
import type {
  AgyMode,
  ModelListResult,
  ToolCapabilities,
  ToolDescriptor,
  ToolInvocationSpec,
  ToolModel,
} from './types.js';

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
 * agy's two fixed invocations, one per runner mode (plan D7). The flag
 * names are verified against `agy --help` (2026-10-16): `--print <prompt>`,
 * `--model <id>`, `--output-format json`, `--mode accept-edits|auto` and,
 * for `full` only, `--dangerously-skip-permissions`. There is no `agy run`
 * subcommand and no `--variant` flag, and no other flag is ever passed:
 * each template is the whole argv, placeholder substitution aside.
 */
const AGY_INVOCATION_BY_MODE: Readonly<Record<AgyMode, ToolInvocationSpec>> = {
  'edit-only': {
    argvTemplate: [
      'agy',
      '--print',
      '{prompt}',
      '--model',
      '{model}',
      '--output-format',
      'json',
      '--mode',
      'accept-edits',
    ],
  },
  full: {
    argvTemplate: [
      'agy',
      '--print',
      '{prompt}',
      '--model',
      '{model}',
      '--output-format',
      'json',
      '--mode',
      'auto',
      '--dangerously-skip-permissions',
    ],
  },
};

/**
 * agy's capabilities follow the mode (plan D7). An `edit-only` seat edits
 * files but cannot run shell commands: the orchestrator runs the lane's
 * checks and commits. A `full` seat runs commands, like an opencode lane.
 * Both run headless, and both need allow rules: headless agy denies tools
 * outside its allow-list until the seat's configuration grants them.
 */
const AGY_CAPABILITIES_BY_MODE: Readonly<Record<AgyMode, ToolCapabilities>> = {
  'edit-only': {
    canRunCommands: false,
    readOnlyMode: false,
    needsAllowRules: true,
    headless: true,
  },
  full: {
    canRunCommands: true,
    readOnlyMode: false,
    needsAllowRules: true,
    headless: true,
  },
};

/**
 * The capabilities of a seat on agy under one runner mode (plan D7). Every
 * consumer — the recommender, the seat checks, dispatch — resolves agy's
 * capabilities through this helper, never through a modeless assumption.
 */
export function agyCapabilitiesFor(mode: AgyMode): ToolCapabilities {
  return AGY_CAPABILITIES_BY_MODE[mode];
}

/**
 * agy is an orchestrator CLI run headless in one of two modes (plan D7):
 * `edit-only` (the default) edits files but cannot run shell commands,
 * while `full` runs commands like an opencode lane. It drives providers of
 * every cost class, so `mixed`.
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
  // Conservative default: with no mode resolved, an agy seat is edit-only.
  capabilities: AGY_CAPABILITIES_BY_MODE['edit-only'],
  capabilitiesByMode: AGY_CAPABILITIES_BY_MODE,
  invocationByMode: AGY_INVOCATION_BY_MODE,
  costSource: 'mixed',
};
