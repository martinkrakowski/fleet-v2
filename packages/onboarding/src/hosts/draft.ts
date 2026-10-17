/**
 * The draft step of the shared onboarding engine (plan section 5): operator
 * answers in, one v2 host entry out, plus the pure function that applies a
 * draft to a copy of the current installation. Nothing here touches a
 * filesystem, a subprocess, the network or the clock, and no rule of the file
 * format is decided here: `parseInstallation` stays the authority, so a draft
 * can only ever be a proposal the loader has the last word on.
 *
 * The safe-host rule is held by the loader (`isSafeSshHost`, copied there
 * from `WorkspaceAdapter` on purpose) and re-exported here: it is a safety
 * boundary every surface that builds ssh argv must hold, and importing a
 * context package into the engine would invert the dependency direction.
 */

import { isAbsolute } from 'node:path';

import { isSafeSshHost } from '@fleet/installation';
import type {
  AgyAcknowledgement,
  HostRole,
  HostRunnerSection,
  HostSection,
  HostTransport,
  RunnerCapabilityDeclaration,
} from '@fleet/installation';

/**
 * The safe-host rule itself lives in `@fleet/installation` (`isSafeSshHost`),
 * copied there from `WorkspaceAdapter` on purpose: the loader is the first
 * gate, and importing a context package into the engine would invert the
 * dependency direction. It is re-exported here so every surface that drafts
 * hosts keeps one import path for the rule it holds.
 */
export { isSafeSshHost };

/** The roles a host may hold; the loader refuses anything else. */
const HOST_ROLES: readonly HostRole[] = [
  'orchestrator',
  'lane-runner',
  'verifier',
];

/** An opencode runner as the operator described it. */
export interface OpencodeHostRunnerDraft {
  readonly kind: 'opencode';
  /** The opencode server's port on its own host, 1..65535. */
  readonly port: number;
  /** Absolute path of the auth file on the orchestrator. */
  readonly authFile?: string;
  readonly maxLanes?: number;
  readonly capabilities?: RunnerCapabilityDeclaration;
}

/** An agy runner as the operator described it; `full` needs its mode typed. */
export interface AgyHostRunnerDraft {
  readonly kind: 'agy';
  readonly agyMode: 'edit-only' | 'full';
  /** The acknowledgement the security text was confirmed with, when `full`. */
  readonly agyAcknowledgement?: AgyAcknowledgement;
  readonly port: number;
  readonly authFile?: string;
  readonly maxLanes?: number;
  readonly capabilities?: RunnerCapabilityDeclaration;
}

/** One drafted runner, discriminated by the kind that selects its fields. */
export type HostRunnerDraft = OpencodeHostRunnerDraft | AgyHostRunnerDraft;

/** Everything a surface collects before it can draft one host. */
export interface HostDraftInput {
  /** The installation host name this entry is filed under. */
  readonly name: string;
  readonly transport: HostTransport;
  /** Required for an `ssh` transport, absent for a `local` one. */
  readonly sshAlias?: string;
  readonly worktreeRoot: string;
  readonly tmpDir?: string;
  readonly roles: readonly HostRole[];
  readonly runner?: HostRunnerDraft;
}

/** One drafted host: the name it is filed under and the entry itself. */
export interface HostDraft {
  readonly name: string;
  readonly host: HostSection;
}

/** A drafted host, or the reasons it cannot be drafted. */
export type HostDraftResult =
  | { readonly ok: true; readonly draft: HostDraft }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Port range a runner may declare; the loader enforces the same bounds. */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Copy the four declaration fields a v2 file may carry. A `source` is
 * derived by the loader and is never a file field (D4), so a draft that
 * carries one is refused instead of silently dropped.
 */
function copyCapabilityDeclaration(
  declaration: RunnerCapabilityDeclaration,
  path: string,
  errors: string[],
): RunnerCapabilityDeclaration | undefined {
  if (Object.hasOwn(declaration, 'source')) {
    errors.push(
      `${path}.source: is derived by the loader and is never drafted`,
    );
    return undefined;
  }
  const {
    networkEgressRestricted,
    cpuAndMemoryLimited,
    processTreeTermination,
    filesystemScope,
  } = declaration;
  return {
    networkEgressRestricted,
    cpuAndMemoryLimited,
    processTreeTermination,
    filesystemScope,
  };
}

/**
 * Build the `runner` block in the key order the v2 writer emits, or record
 * why it cannot be built. The `agy` fields appear only on an agy runner, so
 * the union stays exact.
 */
function buildHostRunner(
  input: HostRunnerDraft,
  path: string,
  errors: string[],
): HostRunnerSection | undefined {
  if (!isValidPort(input.port)) {
    errors.push(`${path}.port: must be an integer 1..65535`);
  }
  if (input.authFile !== undefined && !isAbsolute(input.authFile)) {
    errors.push(`${path}.authFile: must be an absolute path`);
  }
  const capabilities =
    input.capabilities === undefined
      ? undefined
      : copyCapabilityDeclaration(
          input.capabilities,
          `${path}.capabilities`,
          errors,
        );
  const common = {
    port: input.port,
    ...(input.authFile !== undefined ? { authFile: input.authFile } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(input.maxLanes !== undefined ? { maxLanes: input.maxLanes } : {}),
  };
  if (input.kind === 'agy') {
    return {
      kind: 'agy',
      ...common,
      agyMode: input.agyMode,
      ...(input.agyAcknowledgement !== undefined
        ? { agyAcknowledgement: input.agyAcknowledgement }
        : {}),
    };
  }
  return { kind: 'opencode', ...common };
}

/**
 * Draft one host entry from collected answers.
 *
 * Refused here, before any probe runs: an alias that is not a safe ssh host
 * (the rule above), an alias on a `local` transport or a missing one on an
 * `ssh` transport, a relative worktree root or tmp dir, an empty or unknown
 * role list, and a runner port outside 1..65535. Everything else the file
 * format says — the loader's host rules, the dial-port collision rule, the
 * agy isolation floor — is the loader's answer, not this function's.
 */
export function draftHost(input: HostDraftInput): HostDraftResult {
  const path = `hosts.${input.name}`;
  const errors: string[] = [];

  if (input.transport === 'ssh') {
    if (input.sshAlias === undefined) {
      errors.push(`${path}.sshAlias: required when transport is "ssh"`);
    } else if (!isSafeSshHost(input.sshAlias)) {
      // The value never appears in the message: an alias is operator input.
      errors.push(
        `${path}.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option`,
      );
    }
  } else if (input.sshAlias !== undefined) {
    errors.push(`${path}.sshAlias: must be absent when transport is "local"`);
  }

  if (!isAbsolute(input.worktreeRoot)) {
    errors.push(`${path}.worktreeRoot: must be an absolute path`);
  }
  if (input.tmpDir !== undefined && !isAbsolute(input.tmpDir)) {
    errors.push(`${path}.tmpDir: must be an absolute path`);
  }

  if (input.roles.length === 0) {
    errors.push(`${path}.roles: at least one role is required`);
  }
  for (const [index, role] of input.roles.entries()) {
    if (!HOST_ROLES.includes(role)) {
      errors.push(`${path}.roles[${index}]: must be a known host role`);
    }
  }

  const runner =
    input.runner === undefined
      ? undefined
      : buildHostRunner(input.runner, `${path}.runner`, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const host: HostSection = {
    transport: input.transport,
    ...(input.transport === 'ssh' && input.sshAlias !== undefined
      ? { sshAlias: input.sshAlias }
      : {}),
    worktreeRoot: input.worktreeRoot,
    ...(input.tmpDir !== undefined ? { tmpDir: input.tmpDir } : {}),
    roles: [...input.roles],
    ...(runner !== undefined ? { runner } : {}),
  };
  return { ok: true, draft: { name: input.name, host } };
}

/**
 * The candidate an apply produces: a v2 file value that the loader may still
 * refuse. It is deliberately not typed as `FleetInstallationV2`, because a
 * first write starts from nothing and has no forge mode, an orchestrator or a
 * lane runner yet — `parseInstallation` reports those, and the caller fills
 * them in. Typing it as an accepted file would assert a guarantee no check
 * has established yet.
 */
export interface HostDraftCandidate {
  readonly schemaVersion: 2;
  readonly hosts: Readonly<Record<string, HostSection>>;
  readonly [section: string]: unknown;
}

/** An installation value whose hosts may receive a draft. */
export function baseV2File(current: unknown): HostDraftCandidate | undefined {
  if (current === undefined || current === null) {
    return { schemaVersion: 2, hosts: {} };
  }
  if (typeof current !== 'object' || Array.isArray(current)) {
    return undefined;
  }
  const record = current as { readonly schemaVersion?: unknown };
  if (record.schemaVersion !== 2) {
    return undefined;
  }
  const hosts = (current as { readonly hosts?: unknown }).hosts;
  return {
    ...(current as Readonly<Record<string, unknown>>),
    schemaVersion: 2,
    hosts:
      typeof hosts === 'object' && hosts !== null && !Array.isArray(hosts)
        ? (hosts as Readonly<Record<string, HostSection>>)
        : {},
  };
}

/** The candidate file, or the reason there is none, with its errors. */
export type ApplyHostDraftResult =
  | { readonly ok: true; readonly candidate: HostDraftCandidate }
  | {
      readonly ok: false;
      /**
       * Why no candidate exists: the mode refused the name (`exists` on an
       * add, `missing` on an edit) or the current file is not a v2 file the
       * draft can apply to (`not-v2`).
       */
      readonly reason: 'exists' | 'missing' | 'not-v2';
      readonly errors: readonly string[];
    };

/**
 * How the draft is applied: `add` files a new host and refuses a name that
 * is already in the file; `edit` replaces an existing host and refuses a
 * name that is not there. Neither mode silently upgrades to the other.
 */
export type ApplyHostDraftMode = 'add' | 'edit';

/**
 * Apply one draft to a copy of the current installation value and return the
 * candidate file. The current value is never mutated: the candidate is a new
 * object whose `hosts` record is the current one plus the drafted entry. In
 * `add` mode a name already in the file is refused with `reason: "exists"`;
 * in `edit` mode a name that is not there is refused with `reason: "missing"`.
 * A file of schema version 1 carries no hosts and converting one is a mapping
 * step of its own (the conversion forces the isolation acknowledgement), so
 * it is refused here rather than half-done.
 */
export function applyHostDraft(
  current: unknown,
  draft: HostDraft,
  mode: ApplyHostDraftMode,
): ApplyHostDraftResult {
  const base = baseV2File(current);
  if (base === undefined) {
    return {
      ok: false,
      reason: 'not-v2',
      errors: [
        "installation: hosts can only be added to a schema version 2 file; converting an older file is the caller's step",
      ],
    };
  }
  const exists = Object.hasOwn(base.hosts, draft.name);
  if (mode === 'add' && exists) {
    return {
      ok: false,
      reason: 'exists',
      errors: [
        `hosts.${draft.name}: already in the installation file; editing is a separate mode`,
      ],
    };
  }
  if (mode === 'edit' && !exists) {
    return {
      ok: false,
      reason: 'missing',
      errors: [
        `hosts.${draft.name}: not in the installation file; adding is a separate mode`,
      ],
    };
  }
  return {
    ok: true,
    candidate: { ...base, hosts: { ...base.hosts, [draft.name]: draft.host } },
  };
}
