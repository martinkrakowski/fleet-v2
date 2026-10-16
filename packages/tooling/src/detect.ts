import { BUILT_IN_TOOLS } from './descriptors.js';
import type {
  ModelListResult,
  SignInStatus,
  ToolDescriptor,
  ToolId,
  ToolModelsSpec,
} from './types.js';

/** One recorded probe result: the exit code and stdout of one argument array. */
export interface CommandRunResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Runs one argument array and reports its exit code and stdout; never a shell. */
export type CommandRunner = (argv: readonly string[]) => Promise<CommandRunResult>;

/**
 * Performs the HTTP GET a descriptor declares (opencode's `/api/model`).
 * The caller resolves the tool server's base URL and maps a 2xx answer to
 * `exitCode: 0` and the body to `stdout`.
 */
export type HttpProbeRunner = (path: string) => Promise<CommandRunResult>;

export interface DetectToolOptions {
  /**
   * Runner for descriptor-declared HTTP probes. Absent, every HTTP-probed
   * model list is `'unknown'`: fleet never invents a server address.
   */
  readonly httpGet?: HttpProbeRunner;
}

/** What applying one descriptor through a runner produced. */
export interface ToolDetection {
  readonly id: ToolId;
  /** True only when the detect probe ran and exited 0. */
  readonly installed: boolean;
  /** The recorded stdout of the detect probe, trimmed; '' when it failed. */
  readonly detectOutput: string;
  readonly signIn: SignInStatus;
  readonly models: ModelListResult;
}

async function runProbe(
  run: CommandRunner,
  argv: readonly string[],
): Promise<CommandRunResult | undefined> {
  try {
    return await run(argv);
  } catch {
    return undefined;
  }
}

/** An empty list is never truth: a parse that named nothing stays `'unknown'`. */
function asModelList(list: ModelListResult): ModelListResult {
  return Array.isArray(list) && list.length === 0 ? 'unknown' : list;
}

async function detectModels(
  spec: ToolModelsSpec,
  run: CommandRunner,
  options: DetectToolOptions | undefined,
): Promise<ModelListResult> {
  if (spec.argv !== undefined) {
    const probe = await runProbe(run, spec.argv);
    if (probe === undefined || probe.exitCode !== 0) {
      return 'unknown';
    }
    return asModelList(spec.parse(probe.stdout));
  }
  if (spec.http !== undefined) {
    if (options?.httpGet === undefined) {
      return 'unknown';
    }
    let probe: CommandRunResult | undefined;
    try {
      probe = await options.httpGet(spec.http.path);
    } catch {
      probe = undefined;
    }
    if (probe === undefined || probe.exitCode !== 0) {
      return 'unknown';
    }
    return asModelList(spec.parse(probe.stdout));
  }
  // Neither probe: the tool has a product-shipped fixed list; its parse
  // ignores the (absent) output.
  return asModelList(spec.parse(''));
}

/**
 * Applies one descriptor through the injected runner: detect, sign-in and
 * model list. A tool the detect probe does not confirm contributes no
 * sign-in state and no models, and a probe the runner throws on fails
 * closed (`installed: false` or `'unknown'`), never crashes the sweep.
 */
export async function detectTool(
  descriptor: ToolDescriptor,
  run: CommandRunner,
  options?: DetectToolOptions,
): Promise<ToolDetection> {
  const detect = await runProbe(run, descriptor.detect.argv);
  const installed = detect !== undefined && detect.exitCode === 0;
  const head = {
    id: descriptor.id,
    installed,
    detectOutput: detect === undefined ? '' : detect.stdout.trim(),
  };
  if (!installed) {
    return { ...head, signIn: 'unknown', models: 'unknown' };
  }
  const signInProbe = await runProbe(run, descriptor.signIn.argv);
  const signIn =
    signInProbe === undefined
      ? 'unknown'
      : descriptor.signIn.interpret(signInProbe.stdout, signInProbe.exitCode);
  const models = await detectModels(descriptor.models, run, options);
  return { ...head, signIn, models };
}

/**
 * Applies every built-in descriptor through the injected runner, in
 * descriptor order. This package spawns nothing: the runner (and the
 * optional HTTP prober) are the caller's adapters.
 */
export async function detectTools(
  run: CommandRunner,
  options?: DetectToolOptions,
): Promise<readonly ToolDetection[]> {
  return Promise.all(BUILT_IN_TOOLS.map((tool) => detectTool(tool, run, options)));
}
