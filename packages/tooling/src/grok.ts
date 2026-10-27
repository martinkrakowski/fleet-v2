import { interpretAccountSignIn } from './sign-in.js';
import type { ModelListResult, ToolDescriptor, ToolModel } from './types.js';

const MODELS_HEADER = 'Available models:';
/**
 * One model row, anchored to the whole line: a readable id, optionally
 * followed by whitespace and a parenthesised annotation such as `(default)`.
 * Anything else after the id (bare prose, a second id, trailing junk) fails
 * the match and the whole list is `'unknown'`.
 */
const MODEL_ROW = /^([A-Za-z0-9][A-Za-z0-9._/-]*)(?:[ \t]+\([^()]*\))?$/;

function nonEmptyLines(output: string): readonly string[] {
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
 * `grok models` prints an `Available models:` header followed by one model
 * id a line, with optional annotations (such as `(default)`) after the id.
 * A missing header, a row without a readable id, or a header with no model
 * after it is `'unknown'`.
 */
function parseGrokModels(output: string): ModelListResult {
  const lines = nonEmptyLines(output);
  if (lines.length === 0 || lines[0].trim() !== MODELS_HEADER) {
    return 'unknown';
  }
  const result: ToolModel[] = [];
  for (const line of lines.slice(1)) {
    const match = MODEL_ROW.exec(line.trim());
    if (match === null) {
      return 'unknown';
    }
    result.push({ id: match[1] });
  }
  return result.length === 0 ? 'unknown' : result;
}

/**
 * The Grok CLI as fleet invokes it: a reviewer in `--permission-mode plan`,
 * which neither writes nor runs commands, and `--disable-web-search`, and `-p` (single-turn, prints and exits; a positional prompt would start the interactive session instead), which
 * removes web search and web fetch. The template pins plan mode, so a grok
 * seat is read-only (`canRunCommands: false`, `readOnlyMode: true`) and
 * needs no allow rules.
 */
export const GROK_TOOL: ToolDescriptor = {
  id: 'grok',
  displayName: 'Grok CLI',
  detect: { argv: ['grok', '--version'] },
  signIn: {
    argv: ['grok', 'auth', 'status'],
    interpret: interpretAccountSignIn,
  },
  models: {
    argv: ['grok', 'models'],
    parse: parseGrokModels,
  },
  capabilities: {
    canRunCommands: false,
    readOnlyMode: true,
    needsAllowRules: false,
    headless: true,
  },
  invocation: {
    argvTemplate: ['grok', '-m', '{model}', '--permission-mode', 'plan', '--disable-web-search', '-p', '{prompt}'],
  },
  costSource: 'pay-per-token',
};
