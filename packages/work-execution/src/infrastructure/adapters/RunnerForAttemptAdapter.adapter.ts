// Adapter for lane H9b1: one runner adapter per recorded host.
/**
 * RunnerForAttemptAdapter implements RunnerForAttemptPort: it resolves the
 * runner that addresses the host an attempt actually ran on.
 *
 * - **Legacy** (no recorded `hostName`; v1, absent or pre-H9a records): the
 *   single legacy runner the composition root built, exactly as today. That
 *   adapter keeps enforcing the legacy confirm rule itself (the recorded
 *   alias and port must equal the single lane-runner's).
 * - **Recorded `hostName`:** the host is looked up in the CURRENT
 *   installation by its name. If it is missing, renamed, or now has a
 *   different kind, transport, alias or port than recorded, the answer is
 *   `ok: false` naming the recorded host; never a fallback to another host.
 *   Otherwise one `ExecutionRunnerAdapter` is built and cached per host name
 *   from the installation's hosts, with the same environment and options as
 *   today's single adapter, per host.
 * - **Recorded agy host:** a confirmed agy host gets an `AgyRunnerAdapter`
 *   when the root supplies an agy executor for it, and is refused otherwise
 *   (exactly as before when no executor is given).
 */

import { types } from "node:util";
import { isValidHostName } from "@fleet/shared";
import type {
  ExecutionRunnerPort,
  RunnerIsolationCapabilities,
} from "../../application/ports/out/ExecutionRunnerPort.out-port.js";
import type {
  RunnerForAttemptPort,
  RunnerForAttemptRequest,
  RunnerForAttemptResult,
} from "../../application/ports/out/RunnerForAttemptPort.out-port.js";
import type { CommandExecutorPort } from "../../application/ports/out/CommandExecutorPort.out-port.js";
import type {
  AttemptRecord,
  AttemptRunnerRecord,
} from "../../domain/execution-records.js";
import {
  confirmRecordedHost,
  hasRecordedHostName,
  type RunnerForAttemptHostSpec,
} from "./ConfirmRecordedHost.js";
import {
  ExecutionRunnerAdapter,
  type ExecutionRunnerHost,
  type SubprocessRunner,
} from "./ExecutionRunnerAdapter.adapter.js";
import { AgyRunnerAdapter } from "./AgyRunnerAdapter.adapter.js";

export type { RunnerForAttemptHostSpec } from "./ConfirmRecordedHost.js";

// The host spec shape lives in `ConfirmRecordedHost` and is re-exported
// above, so existing imports of `RunnerForAttemptHostSpec` keep resolving.

/**
 * Read one own data property of an untrusted object without ever invoking a
 * getter: a `Proxy`, a throwing descriptor read, or an accessor property is
 * refused, never executed.
 */
function readOwnDataProp(
  obj: object,
  key: string,
): { ok: true; value: unknown } | { ok: false } {
  if (types.isProxy(obj)) return { ok: false };
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return { ok: false };
  }
  if (desc === undefined) return { ok: true, value: undefined };
  if ("value" in desc && !desc.get && !desc.set) {
    return { ok: true, value: desc.value };
  }
  return { ok: false };
}

/**
 * A bounded, non-coercing label for an invalid host name in a refusal: an
 * over-long string is truncated to 128 characters and a non-string is
 * described by its `typeof` only, so no attacker-controlled object
 * coercion (`toString`, `Symbol.toPrimitive`) ever runs and no unbounded
 * string is ever interpolated.
 */
function boundedHostLabel(value: unknown): string {
  if (typeof value !== "string") return typeof value;
  return value.length > 128 ? `${value.slice(0, 128)}…` : `'${value}'`;
}

export interface RunnerForAttemptAdapterOptions {
  /**
   * The current installation's hosts by name (the loader-validated host-map
   * keys). An omitted or empty record means every recorded host is gone.
   */
  readonly hosts?: Readonly<Record<string, RunnerForAttemptHostSpec>>;
  /**
   * The single legacy runner the composition root built (today's
   * environment-based or selected-lane-runner adapter); used for attempts
   * recorded without a `hostName`.
   */
  readonly legacyRunner: ExecutionRunnerPort;
  // --- options forwarded to each per-host ExecutionRunnerAdapter, identical
  // --- to today's single adapter's construction:
  readonly ocmRunBin?: string;
  readonly executor?: CommandExecutorPort;
  readonly runSubprocess?: SubprocessRunner;
  readonly capabilities?: Partial<RunnerIsolationCapabilities>;
  readonly runnerTransport?: "local" | "ssh";
  readonly resolveWorktreePath?: (
    attemptId: string,
  ) => Promise<string | null> | string | null;
  readonly resolveAttempt?: (
    attemptId: string,
  ) => Promise<AttemptRecord | null> | AttemptRecord | null;
  /** AG-2: the executor that runs `bin/agy-run` on a named agy lane-runner host; absent keeps agy refused. */
  readonly agyExecutorForHost?: (hostName: string) => CommandExecutorPort | null;
  /** AG-2: the agy-run script path for every agy host (the adapter's default when absent). */
  readonly agyRunBin?: string;
}

/** The confirm-or-unknown refusal, naming the recorded host. */
export class RunnerForAttemptAdapter implements RunnerForAttemptPort {
  /** One adapter per host name, built once and cached. */
  private readonly adapters = new Map<string, ExecutionRunnerPort>();

  /**
   * `runnerForHostName`'s own cache; it shares no entry with `runnerForAttempt`'s
   * `adapters` Map, so a per-name resolution never hands out another path's adapter.
   */
  private readonly hostNameAdapters = new Map<string, ExecutionRunnerPort>();

  constructor(private readonly options: RunnerForAttemptAdapterOptions) {}

  runnerForAttempt(request: RunnerForAttemptRequest): RunnerForAttemptResult {
    const recorded = request.runner;
    if (!hasRecordedHostName(recorded)) {
      // Legacy attempt: the single legacy runner, exactly as today.
      return { ok: true, runner: this.options.legacyRunner };
    }

    // H9b2: the confirm-or-unknown comparison is the shared one in
    // `ConfirmRecordedHost`, so the executor helper enforces the same rule.
    const confirmed = confirmRecordedHost(
      recorded as AttemptRunnerRecord,
      this.options?.hosts,
    );
    if (!confirmed.ok) {
      return { ok: false, reason: confirmed.reason };
    }

    const name = confirmed.name;
    const spec = confirmed.spec;
    const currentKind = spec.runner?.kind ?? "opencode";
    const currentTransport = confirmed.transport;

    // AG-2: a confirmed agy host gets an AgyRunnerAdapter when the root gives
    // an executor for that host; without one the old refusal stands unchanged.
    if (currentKind === "agy") {
      if (this.options.agyExecutorForHost === undefined) {
        return {
          ok: false,
          reason: `recorded host ${name} runner kind ${currentKind} has no adapter`,
        };
      }
      const cachedAgy = this.adapters.get(name);
      if (cachedAgy !== undefined) return { ok: true, runner: cachedAgy };
      const builtAgy = this.buildAgyRunner(name, spec, currentTransport);
      if (builtAgy === null) {
        return {
          ok: false,
          reason: `recorded host ${name} has no agy executor`,
        };
      }
      this.adapters.set(name, builtAgy);
      return { ok: true, runner: builtAgy };
    }

    // H9b1 follow-up (Fable review): only the `opencode` runner kind has an
    // ocm-run adapter. Any other confirmed kind is refused instead of
    // building an ocm-run adapter for it.
    const unadapted = this.checkOpencodeKind("recorded host", name, currentKind);
    if (unadapted !== null) return unadapted;

    const cached = this.adapters.get(name);
    if (cached !== undefined) return { ok: true, runner: cached };

    const built = this.buildRunner(name, spec, currentTransport);
    this.adapters.set(name, built);
    return { ok: true, runner: built };
  }

  /** Build the runner adapter for one confirmed host (v2 mode). */
  private buildRunner(
    name: string,
    spec: RunnerForAttemptHostSpec,
    transport: "local" | "ssh",
    capabilitiesOverride?: Partial<RunnerIsolationCapabilities>,
  ): ExecutionRunnerPort {
    const host: ExecutionRunnerHost = {
      hostName: name,
      transport,
      ...(transport === "ssh" && spec.sshAlias !== undefined
        ? { sshAlias: spec.sshAlias }
        : {}),
      remotePort:
        typeof spec.runner?.port === "number" ? spec.runner.port : null,
      ...(spec.runner?.authFile !== undefined &&
      spec.runner.authFile.trim() !== ""
        ? { authFile: spec.runner.authFile }
        : {}),
    };
    return new ExecutionRunnerAdapter({
      host,
      ocmRunBin: this.options?.ocmRunBin,
      executor: this.options?.executor,
      ...(this.options?.runSubprocess !== undefined
        ? { runSubprocess: this.options.runSubprocess }
        : {}),
      ...(capabilitiesOverride !== undefined
        ? { capabilities: capabilitiesOverride }
        : this.options?.capabilities !== undefined
          ? { capabilities: this.options.capabilities }
          : {}),
      ...(this.options?.runnerTransport !== undefined
        ? { runnerTransport: this.options.runnerTransport }
        : {}),
      ...this.sharedResolvers(),
    });
  }

  /**
   * The cached per-host opencode runner for `runnerForHostName`, from that
   * path's own Map; built from the validated snapshot when absent.
   */
  private getOrBuildOpencodeRunner(
    name: string,
    spec: RunnerForAttemptHostSpec,
    transport: "local" | "ssh",
    capabilitiesOverride: Partial<RunnerIsolationCapabilities>,
  ): ExecutionRunnerPort {
    const cached = this.hostNameAdapters.get(name);
    if (cached !== undefined) return cached;
    const built = this.buildRunner(name, spec, transport, capabilitiesOverride);
    this.hostNameAdapters.set(name, built);
    return built;
  }

  /**
   * The kind check shared by both resolution paths: only the `opencode`
   * runner kind has an ocm-run adapter; any other kind is refused.
   * Returns `null` when `kind` is `opencode`.
   */
  private checkOpencodeKind(
    prefix: "host" | "recorded host",
    name: string,
    kind: string,
  ): RunnerForAttemptResult | null {
    if (kind === "opencode") return null;
    return {
      ok: false,
      reason: `${prefix} ${name} runner kind ${kind} has no adapter`,
    };
  }

  /**
   * Resolve and cache the runner for a CURRENT installation host by name
   * alone, with no recorded attempt. Every field is read from the
   * installation's host spec through `readOwnDataProp` and validated here:
   * an absent or invalid `runner.port`, `runner.authFile` or
   * `runner.capabilities` is refused, never inherited from another host or
   * from the shared options, and no untrusted object is ever passed on.
   */
  runnerForHostName(hostName: string): RunnerForAttemptResult {
    // `isValidHostName` throws on null/undefined, so the typeof check is first.
    if (typeof hostName !== "string" || !isValidHostName(hostName)) {
      const shown = boundedHostLabel(hostName);
      return { ok: false, reason: `invalid host name ${shown}` };
    }

    // `hosts` is read through `readOwnDataProp` so a throwing getter on the
    // options object is refused instead of escaping this method.
    const hostsRead = readOwnDataProp(this.options, "hosts");
    const hosts = hostsRead.ok ? hostsRead.value : undefined;
    if (
      hosts === null ||
      typeof hosts !== "object" ||
      types.isProxy(hosts) ||
      Array.isArray(hosts)
    ) {
      return {
        ok: false,
        reason: `host ${hostName} is not present in installation hosts`,
      };
    }
    const specRead = readOwnDataProp(hosts, hostName);
    if (
      !specRead.ok ||
      typeof specRead.value !== "object" ||
      specRead.value === null
    ) {
      return {
        ok: false,
        reason: `host ${hostName} is not present in installation hosts`,
      };
    }
    const spec = specRead.value as object;

    // The host must carry the lane-runner role in a real, dense array whose
    // entries are plain data: `types.isProxy` is checked before
    // `Array.isArray` (a revoked Proxy throws on any operation), and every
    // index is read through `readOwnDataProp`, so an own accessor at an
    // index is refused rather than invoked.
    const rolesRead = readOwnDataProp(spec, "roles");
    const roles = rolesRead.ok ? rolesRead.value : undefined;
    let denseRoles = false;
    let hasLaneRunner = false;
    if (typeof roles === "object" && roles !== null && !types.isProxy(roles) && Array.isArray(roles)) {
      denseRoles = true;
      const rolesObj = roles as object;
      for (let i = 0; i < roles.length; i += 1) {
        const entry = readOwnDataProp(rolesObj, String(i));
        if (!entry.ok || entry.value === undefined) {
          // An accessor is refused without invoking it; `undefined` is a
          // sparse hole (no own data property at that index).
          denseRoles = false;
          break;
        }
        if (entry.value === "lane-runner") hasLaneRunner = true;
      }
    }
    if (!denseRoles || !hasLaneRunner) {
      return {
        ok: false,
        reason: `host ${hostName} does not serve the lane-runner role`,
      };
    }

    // The runner block: a non-null, non-array, non-Proxy plain object.
    const runnerRead = readOwnDataProp(spec, "runner");
    const runner = runnerRead.ok ? runnerRead.value : undefined;
    if (
      runner === null ||
      typeof runner !== "object" ||
      types.isProxy(runner) ||
      Array.isArray(runner)
    ) {
      return {
        ok: false,
        reason: `host ${hostName} declares no runner block`,
      };
    }
    const runnerObj = runner as object;

    // Kind: default `opencode` when absent; any non-opencode kind (including
    // `agy`) has no ocm-run adapter on this path.
    const kindRead = readOwnDataProp(runnerObj, "kind");
    if (!kindRead.ok) {
      return { ok: false, reason: `host ${hostName} runner kind is unreadable` };
    }
    const kind = kindRead.value === undefined ? "opencode" : kindRead.value;
    if (typeof kind !== "string") {
      return {
        ok: false,
        reason: `host ${hostName} runner kind is not a string`,
      };
    }
    const kindRefusal = this.checkOpencodeKind("host", hostName, kind);
    if (kindRefusal !== null) return kindRefusal;

    // The port: the host's own declared port, never another port.
    const portRead = readOwnDataProp(runnerObj, "port");
    const port = portRead.ok ? portRead.value : undefined;
    if (
      typeof port !== "number" ||
      !Number.isFinite(port) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return {
        ok: false,
        reason: `host ${hostName} runner.port is absent or invalid`,
      };
    }

    // The auth file: the host's own, so `bin/ocm-run` never falls back to
    // the default or first-host auth file.
    const authRead = readOwnDataProp(runnerObj, "authFile");
    const authFile = authRead.ok ? authRead.value : undefined;
    if (typeof authFile !== "string" || authFile.trim() === "") {
      return {
        ok: false,
        reason: `host ${hostName} runner.authFile is absent or blank`,
      };
    }

    // The capabilities: the host's own declaration, never the shared
    // options' capabilities and never another host's.
    const capabilities = this.readHostCapabilities(runnerObj);
    if (capabilities === null) {
      return {
        ok: false,
        reason: `host ${hostName} declares no valid runner.capabilities`,
      };
    }

    // Transport and, for ssh, the alias.
    const transportRead = readOwnDataProp(spec, "transport");
    if (!transportRead.ok) {
      return { ok: false, reason: `host ${hostName} transport is unreadable` };
    }
    const transportValue = transportRead.value;
    if (
      transportValue !== undefined &&
      transportValue !== "local" &&
      transportValue !== "ssh"
    ) {
      return { ok: false, reason: `host ${hostName} transport is invalid` };
    }
    const transport = transportValue === "ssh" ? "ssh" : "local";
    let sshAlias: string | undefined;
    if (transport === "ssh") {
      const aliasRead = readOwnDataProp(spec, "sshAlias");
      const alias = aliasRead.ok ? aliasRead.value : undefined;
      if (typeof alias !== "string" || alias.trim() === "") {
        return {
          ok: false,
          reason: `host ${hostName} is ssh but declares no sshAlias`,
        };
      }
      sshAlias = alias;
    }

    // A fresh plain snapshot of only the validated primitives; the original
    // spec object is never passed on.
    const snapshot: RunnerForAttemptHostSpec = {
      transport,
      ...(transport === "ssh" ? { sshAlias } : {}),
      runner: { kind: "opencode", port, authFile },
    };
    return {
      ok: true,
      runner: this.getOrBuildOpencodeRunner(hostName, snapshot, transport, capabilities),
    };
  }

  /**
   * Read and validate the host's own `runner.capabilities` declaration.
   * Returns the seven-key override built from the validated primitives, or
   * `null` when the declaration is absent or invalid. Accessors and proxies
   * are refused without ever invoking a getter.
   */
  private readHostCapabilities(
    runnerObj: object,
  ): Partial<RunnerIsolationCapabilities> | null {
    const capsRead = readOwnDataProp(runnerObj, "capabilities");
    const caps = capsRead.ok ? capsRead.value : undefined;
    if (
      caps === null ||
      typeof caps !== "object" ||
      types.isProxy(caps) ||
      Array.isArray(caps)
    ) {
      return null;
    }
    const capsObj = caps as object;

    const scopeRead = readOwnDataProp(capsObj, "filesystemScope");
    const filesystemScope = scopeRead.ok ? scopeRead.value : undefined;
    if (
      filesystemScope !== "scoped-worktree" &&
      filesystemScope !== "inherited-directory"
    ) {
      return null;
    }

    const flags: readonly (keyof RunnerIsolationCapabilities)[] = [
      "networkEgressRestricted",
      "cpuAndMemoryLimited",
      "processTreeTermination",
    ];
    const flagValues: boolean[] = [];
    for (const flag of flags) {
      const flagRead = readOwnDataProp(capsObj, flag);
      const value = flagRead.ok ? flagRead.value : undefined;
      if (typeof value !== "boolean") return null;
      flagValues.push(value);
    }

    const sourceRead = readOwnDataProp(capsObj, "source");
    const source = sourceRead.ok ? sourceRead.value : undefined;
    if (source !== undefined && source !== "declared") return null;

    return {
      filesystemScope,
      networkEgressRestricted: flagValues[0]!,
      cpuAndMemoryLimited: flagValues[1]!,
      processTreeTermination: flagValues[2]!,
      source: "declared",
      authoritativeCompletion: true,
      artifactPersistence: true,
    };
  }

  /** Resolvers forwarded to every per-host runner adapter (opencode and agy). */
  private sharedResolvers(): Pick<
    RunnerForAttemptAdapterOptions,
    'resolveWorktreePath' | 'resolveAttempt'
  > {
    return {
      ...(this.options?.resolveWorktreePath !== undefined
        ? { resolveWorktreePath: this.options.resolveWorktreePath }
        : {}),
      ...(this.options?.resolveAttempt !== undefined
        ? { resolveAttempt: this.options.resolveAttempt }
        : {}),
    };
  }

  /** Build the agy runner adapter for one confirmed agy host (AG-2). */
  private buildAgyRunner(
    name: string,
    spec: RunnerForAttemptHostSpec,
    transport: "local" | "ssh",
  ): ExecutionRunnerPort | null {
    const executor = this.options.agyExecutorForHost!(name);
    if (executor === null) return null;
    return new AgyRunnerAdapter({
      executor,
      hostName: name,
      ...(transport === "ssh" && spec.sshAlias !== undefined
        ? { sshAlias: spec.sshAlias }
        : {}),
      mode: spec.runner?.agyMode ?? "edit-only",
      transport,
      ...(this.options.agyRunBin !== undefined
        ? { agyRunBin: this.options.agyRunBin }
        : {}),
      ...this.sharedResolvers(),
      ...(this.options.capabilities !== undefined
        ? { capabilities: this.options.capabilities }
        : {}),
    });
  }
}
