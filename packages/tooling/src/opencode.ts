import type { ModelListResult, SignInStatus, ToolDescriptor, ToolModel } from './types.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROVIDER_ROW = /^[ \t]*(\S+)[ \t]{2,}(signed in|signed out)[ \t]*$/;

/**
 * `opencode auth` prints a provider table; any provider row signed in is
 * enough for a seat, because the model list already shows what is usable.
 * The listing itself failing, or a table with no readable row, is
 * `'unknown'`: fleet never guesses a provider's state from prose.
 */
function interpretOpenCodeSignIn(stdout: string, exitCode: number): SignInStatus {
  if (exitCode !== 0) {
    return 'unknown';
  }
  let parsedRows = 0;
  let signedInRows = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const match = PROVIDER_ROW.exec(line);
    if (match === null) {
      continue;
    }
    parsedRows += 1;
    if (match[2] === 'signed in') {
      signedInRows += 1;
    }
  }
  if (parsedRows === 0) {
    return 'unknown';
  }
  return signedInRows > 0 ? 'signed-in' : 'signed-out';
}

/**
 * `GET /api/model` of a running opencode 2.x server answers
 * `{ "data": { "current": <id>, "models": { <id>: { variants? } } } }`.
 * Unknown members at any level are tolerated (servers grow fields); the
 * `data.models` record itself and every entry read for the result must have
 * the documented shape, or the whole answer is `'unknown'`.
 */
function parseOpenCodeModels(output: string): ModelListResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return 'unknown';
  }
  if (!isPlainObject(parsed)) {
    return 'unknown';
  }
  const data = parsed['data'];
  if (!isPlainObject(data)) {
    return 'unknown';
  }
  const models = data['models'];
  if (!isPlainObject(models)) {
    return 'unknown';
  }
  const result: ToolModel[] = [];
  for (const [rawId, entry] of Object.entries(models)) {
    const id = rawId.trim();
    if (id === '') {
      return 'unknown';
    }
    if (!isPlainObject(entry)) {
      return 'unknown';
    }
    let variants: readonly string[] | undefined = undefined;
    if ('variants' in entry) {
      const rawVariants = entry['variants'];
      if (!Array.isArray(rawVariants)) {
        return 'unknown';
      }
      const parsedVariants: string[] = [];
      for (const variant of rawVariants) {
        if (typeof variant !== 'string' || variant.trim() === '') {
          return 'unknown';
        }
        parsedVariants.push(variant.trim());
      }
      variants = parsedVariants;
    }
    result.push(variants === undefined ? { id } : { id, variants });
  }
  return result.length === 0 ? 'unknown' : result;
}

/**
 * opencode is the default lane runner. One install can serve free, plan and
 * pay-per-token providers at once, so its cost source is `mixed`. Model
 * selection takes `<model>#<variant>`, the form `bin/ocm-run` folds for
 * seats that name a variant.
 */
export const OPENCODE_TOOL: ToolDescriptor = {
  id: 'opencode',
  displayName: 'OpenCode',
  detect: { argv: ['opencode', '--version'] },
  signIn: {
    argv: ['opencode', 'auth'],
    interpret: interpretOpenCodeSignIn,
  },
  models: {
    http: { path: '/api/model' },
    parse: parseOpenCodeModels,
  },
  capabilities: {
    canRunCommands: true,
    readOnlyMode: false,
    needsAllowRules: false,
    headless: true,
  },
  invocation: {
    argvTemplate: ['opencode', 'run', '-m', '{model}#{variant}', '{prompt}'],
  },
  costSource: 'mixed',
};
