/**
 * Tool descriptors: how fleet recognises a worker CLI, checks its sign-in
 * without reading credentials, lists the models it can serve, and records
 * what a seat on it can do.
 *
 * A descriptor is pure data plus pure parsers. It never spawns a process,
 * opens a socket or reads a file: every observation enters through the
 * runner a caller injects into `detectTools`. An answer a parser does not
 * recognise is `'unknown'`, never an empty list or a guess.
 */

/** Identifiers of the product-shipped tool descriptors. */
export type ToolId = 'claude-code' | 'opencode' | 'grok' | 'agy';

/** Outcome of a sign-in probe. */
export type SignInStatus = 'signed-in' | 'signed-out' | 'unknown';

/** One model a tool serves, with the variants a seat may pin on it. */
export interface ToolModel {
  readonly id: string;
  readonly variants?: readonly string[];
}

/**
 * A parsed model list: either a non-empty list or explicitly `'unknown'`.
 * An empty list is never a result; a tool that named nothing it can serve
 * answered `'unknown'`.
 */
export type ModelListResult = readonly ToolModel[] | 'unknown';

/** The `--version` probe that recognises the tool and shows its version. */
export interface ToolDetectSpec {
  readonly argv: readonly string[];
}

/**
 * The sign-in check. `interpret` maps the probe's recorded stdout and exit
 * code onto a status. It inspects status text only and never receives, reads
 * or prints a credential value.
 */
export interface ToolSignInSpec {
  readonly argv: readonly string[];
  readonly interpret: (stdout: string, exitCode: number) => SignInStatus;
}

/** An HTTP endpoint of the tool's running server that answers the model list. */
export interface ToolModelsHttpSpec {
  readonly path: string;
}

/**
 * Where a tool's model list comes from: a CLI listing (`argv`), an HTTP GET
 * against the tool's running server (`http`), or a product-shipped fixed list
 * when the tool has neither (then `parse` ignores its input). `parse` turns
 * the recorded output into a non-empty list or `'unknown'`.
 */
export interface ToolModelsSpec {
  readonly argv?: readonly string[];
  readonly http?: ToolModelsHttpSpec;
  readonly parse: (output: string) => ModelListResult;
}

/** What a seat on this tool can do, as fleet invokes it. */
export interface ToolCapabilities {
  /**
   * Whether a seat can run shell commands itself. `false` marks an
   * edit-only (or, with `readOnlyMode`, review-only) seat: the orchestrator
   * runs its checks and its commits.
   */
  readonly canRunCommands: boolean;
  /** Whether the tool's fleet invocation never writes; it can only review. */
  readonly readOnlyMode: boolean;
  /**
   * Whether a headless seat needs allow rules in the tool's own
   * configuration before it may run unattended.
   */
  readonly needsAllowRules: boolean;
  /** Whether the tool runs non-interactively. */
  readonly headless: boolean;
}

/**
 * The argument array fleet uses to start one headless run. Placeholders:
 * `{model}`, `{variant}` and `{prompt}` (the task text or its file path).
 * The template is never a shell string; the caller substitutes the
 * placeholders and hands the array to an argument-array executor.
 */
export interface ToolInvocationSpec {
  readonly argvTemplate: readonly string[];
}

/** How a seat on this tool is billed. */
export type ToolCostSource = 'plan-quota' | 'free-tier' | 'pay-per-token' | 'mixed';

/** One product-shipped tool description. */
export interface ToolDescriptor {
  readonly id: ToolId;
  readonly displayName: string;
  readonly detect: ToolDetectSpec;
  readonly signIn: ToolSignInSpec;
  readonly models: ToolModelsSpec;
  readonly capabilities: ToolCapabilities;
  readonly invocation: ToolInvocationSpec;
  readonly costSource: ToolCostSource;
}
