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

import { isSafeSshHost, isValidHostName } from '@fleet/installation';
import type {
  AgyAcknowledgement,
  GateSlotSection,
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

/** Size bounds the loader's own host rules hold; the draft refuses early. */
const MAX_ROLES = 16;
const MAX_ROLE_ALIASES = 16;
const MAX_PATH_LENGTH = 1024;
const MAX_ALIAS_LENGTH = 255;
const MAX_CONTAINER_NAME_LENGTH = 64;
const MAX_TUNNEL_OFFSET = 1024;
const CONTAINER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A plain data record: an object whose prototype is `Object.prototype` or
 * `null`. Everything a draft reads off a hostile runtime value is read through
 * this check first, so a class instance or a falsy value is refused, never run.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/**
 * Read one own data property of a plain record without running a getter: an
 * accessor property reads as absent. Wrapped in `try/catch` so a hostile
 * `Object.getOwnPropertyDescriptor` can never throw through the draft.
 */
function ownDataValue(record: object, key: string): unknown {
  try {
    if (!Object.hasOwn(record, key)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) {
      return undefined;
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      // An accessor is never run: a getter's value is untrusted by definition.
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

/**
 * Copy a plain record's own data properties, skipping accessors. A hostile
 * value never throws and never runs a getter; what it carries as plain data
 * survives, everything else is omitted.
 */
function copyOwnData(record: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(record)) {
    return undefined;
  }
  try {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (Object.hasOwn(record, key)) {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (descriptor !== undefined && descriptor.get === undefined) {
          out[key] = descriptor.value;
        }
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/** An opencode runner as the operator described it. */
export interface OpencodeHostRunnerDraft {
  readonly kind: 'opencode';
  /** The opencode server's port on its own host, 1..65535. */
  readonly port: number;
  /**
   * How far above the port the bundled runner program dials the server; absent
   * means 1. The loader owns the exact value the bundled program implements.
   */
  readonly tunnelOffset?: number;
  /** Absolute path of the auth file on the orchestrator. */
  readonly authFile?: string;
  readonly maxLanes?: number;
  readonly capabilities?: RunnerCapabilityDeclaration;
  /** The host-wide gate-slot throttle the host already declares (KF-30b). */
  readonly gateSlot?: GateSlotSection;
}

/** An agy runner as the operator described it; `full` needs its mode typed. */
export interface AgyHostRunnerDraft {
  readonly kind: 'agy';
  readonly agyMode: 'edit-only' | 'full';
  /** The acknowledgement the security text was confirmed with, when `full`. */
  readonly agyAcknowledgement?: AgyAcknowledgement;
  readonly port: number;
  /** How far above the port the bundled runner program dials; absent means 1. */
  readonly tunnelOffset?: number;
  readonly authFile?: string;
  readonly maxLanes?: number;
  readonly capabilities?: RunnerCapabilityDeclaration;
  /** The host-wide gate-slot throttle the host already declares (KF-30b). */
  readonly gateSlot?: GateSlotSection;
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
  /** Optional lowercase container name the host's runner runs in. */
  readonly container?: string;
  /**
   * Optional one-ssh-alias-per-held-role map: an ssh host may give a role a
   * different alias than the host's own. Every key must be a role the host
   * holds, and every value passes the loader's safe-host rule.
   */
  readonly roleAliases?: Readonly<Partial<Record<HostRole, string>>>;
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
  // The declaration is read through own-data guards: a hostile value (a
  // getter-carrying field, a non-plain object) is refused, never run and
  // never a throw.
  const fields = copyOwnData(declaration);
  if (fields === undefined) {
    errors.push(`${path}: must be plain data`);
    return undefined;
  }
  const networkEgressRestricted = ownDataValue(fields, 'networkEgressRestricted');
  const cpuAndMemoryLimited = ownDataValue(fields, 'cpuAndMemoryLimited');
  const processTreeTermination = ownDataValue(fields, 'processTreeTermination');
  const filesystemScope = ownDataValue(fields, 'filesystemScope');
  if (
    networkEgressRestricted === undefined ||
    cpuAndMemoryLimited === undefined ||
    processTreeTermination === undefined ||
    filesystemScope === undefined
  ) {
    errors.push(`${path}: must carry the four capability fields`);
    return undefined;
  }
  return {
    networkEgressRestricted,
    cpuAndMemoryLimited,
    processTreeTermination,
    filesystemScope,
  } as RunnerCapabilityDeclaration;
}

/**
 * Build the `runner` block in the key order the v2 writer emits, or record
 * why it cannot be built. The `agy` fields appear only on an agy runner, so
 * the union stays exact. The runner is read through own-data guards, so a
 * hostile runtime value is refused, never run and never a throw.
 */
function buildHostRunner(
  input: unknown,
  path: string,
  errors: string[],
): HostRunnerSection | undefined {
  const fields = copyOwnData(input);
  if (fields === undefined) {
    errors.push(`${path}: must be plain data`);
    return undefined;
  }
  const port = fields.port;
  if (typeof port !== 'number' || !isValidPort(port)) {
    errors.push(`${path}.port: must be an integer 1..65535`);
  }
  const tunnelOffset = fields.tunnelOffset;
  if (
    tunnelOffset !== undefined &&
    (typeof tunnelOffset !== 'number' ||
      !Number.isInteger(tunnelOffset) ||
      tunnelOffset < 0 ||
      tunnelOffset > MAX_TUNNEL_OFFSET)
  ) {
    errors.push(
      `${path}.tunnelOffset: must be an integer from 0 to ${MAX_TUNNEL_OFFSET}`,
    );
  }
  const rawAuthFile = fields.authFile;
  const authFile =
    typeof rawAuthFile === 'string' && isAbsolute(rawAuthFile)
      ? rawAuthFile
      : undefined;
  if (rawAuthFile !== undefined && authFile === undefined) {
    errors.push(`${path}.authFile: must be an absolute path`);
  }
  const capabilities =
    fields.capabilities === undefined
      ? undefined
      : copyCapabilityDeclaration(
          fields.capabilities as RunnerCapabilityDeclaration,
          `${path}.capabilities`,
          errors,
        );
  const common = {
    port: port as number,
    ...(tunnelOffset !== undefined ? { tunnelOffset: tunnelOffset as number } : {}),
    ...(authFile !== undefined ? { authFile } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(fields.maxLanes !== undefined
      ? { maxLanes: fields.maxLanes as number }
      : {}),
    ...(fields.gateSlot !== undefined
      ? { gateSlot: fields.gateSlot as GateSlotSection }
      : {}),
  };
  if (fields.kind === 'agy') {
    return {
      kind: 'agy',
      ...common,
      agyMode: fields.agyMode as 'edit-only' | 'full',
      ...(fields.agyAcknowledgement !== undefined
        ? { agyAcknowledgement: fields.agyAcknowledgement as AgyAcknowledgement }
        : {}),
    };
  }
  return { kind: 'opencode', ...common };
}

/**
 * Draft one host entry from collected answers.
 *
 * Refused here, before any probe runs: an input that is not plain data, an
 * alias that is not a safe ssh host, an alias on a `local` transport or a
 * missing one on an `ssh` transport, relative or oversized paths, sparse or
 * unknown roles, malformed container and role-alias maps, and runner ports or
 * tunnel offsets outside their bounds. Nothing hostile ever runs and no
 * operator value is echoed in a refusal. Everything else the file format
 * says — the loader's host rules, the dial-port collision rule, the agy
 * isolation floor — is the loader's answer, not this function's.
 */
export function draftHost(rawInput: unknown): HostDraftResult {
  // Hostile runtime input is refused, never run: no getter is invoked and
  // nothing throws, whatever the caller hands over.
  const fields = copyOwnData(rawInput);
  if (fields === undefined) {
    return {
      ok: false,
      errors: ['hosts: the host description must be plain data'],
    };
  }
  const name = fields.name;
  if (typeof name !== 'string' || name === '') {
    return {
      ok: false,
      errors: ['hosts: the host name must be a non-empty string'],
    };
  }
  return validateHostFields(fields, name);
}

/**
 * The path prefix an error names a host by. The name is operator input, so it
 * is echoed only when it is a valid host name that cannot be mistaken for a
 * secret (short, no long alphanumeric run); anything else gets a fixed label.
 */
function hostPath(name: string): string {
  return isValidHostName(name) &&
    name.length <= 32 &&
    !/[A-Za-z0-9]{12,}/.test(name)
    ? `hosts.${name}`
    : 'hosts.<invalid-name>';
}

/**
 * The one field validator: `draftHost` runs it on the operator's input and
 * `applyHostDraft` runs it again on the candidate host before `ok: true`, so
 * a hand-built draft cannot carry a field the loader would refuse.
 */
function validateHostFields(
  fields: Record<string, unknown>,
  name: string,
): HostDraftResult {
  const path = hostPath(name);
  const errors: string[] = [];

  const transport = fields.transport;
  if (transport !== 'ssh' && transport !== 'local') {
    errors.push(`${path}.transport: must be "local" or "ssh"`);
  }

  const sshAlias = fields.sshAlias;
  if (transport === 'ssh') {
    if (sshAlias === undefined) {
      errors.push(`${path}.sshAlias: required when transport is "ssh"`);
    } else if (
      typeof sshAlias !== 'string' ||
      !isSafeSshHost(sshAlias) ||
      sshAlias.length > MAX_ALIAS_LENGTH
    ) {
      // The value never appears in the message: an alias is operator input.
      errors.push(
        `${path}.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option`,
      );
    }
  } else if (sshAlias !== undefined) {
    errors.push(`${path}.sshAlias: must be absent when transport is "local"`);
  }

  const worktreeRoot = fields.worktreeRoot;
  if (typeof worktreeRoot !== 'string' || !isAbsolute(worktreeRoot)) {
    errors.push(`${path}.worktreeRoot: must be an absolute path`);
  } else if (worktreeRoot.length > MAX_PATH_LENGTH) {
    errors.push(
      `${path}.worktreeRoot: must be at most ${MAX_PATH_LENGTH} characters`,
    );
  }
  const tmpDir = fields.tmpDir;
  if (tmpDir !== undefined) {
    if (typeof tmpDir !== 'string' || !isAbsolute(tmpDir)) {
      errors.push(`${path}.tmpDir: must be an absolute path`);
    } else if (tmpDir.length > MAX_PATH_LENGTH) {
      errors.push(
        `${path}.tmpDir: must be at most ${MAX_PATH_LENGTH} characters`,
      );
    }
  }

  const rolesField = fields.roles;
  const validRoles: HostRole[] = [];
  if (!Array.isArray(rolesField)) {
    errors.push(`${path}.roles: must be an array of host roles`);
  } else {
    if (rolesField.length === 0) {
      errors.push(`${path}.roles: at least one role is required`);
    }
    if (rolesField.length > MAX_ROLES) {
      errors.push(`${path}.roles: must hold at most ${MAX_ROLES} roles`);
    }
    for (let index = 0; index < rolesField.length; index += 1) {
      if (!Object.hasOwn(rolesField, index)) {
        // A sparse array is refused: a hole would draft a silent undefined role.
        errors.push(
          `${path}.roles[${index}]: must be a dense array of known host roles`,
        );
        continue;
      }
      const role = ownDataValue(rolesField, String(index));
      if (typeof role !== 'string' || !HOST_ROLES.includes(role as HostRole)) {
        errors.push(`${path}.roles[${index}]: must be a known host role`);
        continue;
      }
      validRoles.push(role as HostRole);
    }
  }

  const container = fields.container;
  if (container !== undefined) {
    if (
      typeof container !== 'string' ||
      container === '' ||
      container !== container.trim()
    ) {
      errors.push(
        `${path}.container: must be a non-empty lowercase container name without leading or trailing whitespace`,
      );
    } else if (container.length > MAX_CONTAINER_NAME_LENGTH) {
      errors.push(
        `${path}.container: must be at most ${MAX_CONTAINER_NAME_LENGTH} characters`,
      );
    } else if (!CONTAINER_NAME_PATTERN.test(container)) {
      errors.push(
        `${path}.container: must be a lowercase container name matching ^[a-z0-9][a-z0-9-]*$`,
      );
    }
  }

  const roleAliasesField = fields.roleAliases;
  const aliases = copyOwnData(roleAliasesField);
  if (roleAliasesField !== undefined && aliases === undefined) {
    errors.push(
      `${path}.roleAliases: must be an object mapping held roles to safe ssh hosts`,
    );
  } else if (aliases !== undefined) {
    if (transport !== 'ssh') {
      errors.push(
        `${path}.roleAliases: must be absent when transport is "local"`,
      );
    }
    const aliasKeys = Object.keys(aliases);
    if (aliasKeys.length > MAX_ROLE_ALIASES) {
      errors.push(
        `${path}.roleAliases: must hold at most ${MAX_ROLE_ALIASES} role aliases`,
      );
    }
    for (const key of aliasKeys) {
      if (!HOST_ROLES.includes(key as HostRole)) {
        errors.push(`${path}.roleAliases: every key must be a known host role`);
        continue;
      }
      if (!validRoles.includes(key as HostRole)) {
        errors.push(`${path}.roleAliases.${key}: the host does not hold that role`);
        continue;
      }
      const alias = aliases[key];
      if (typeof alias !== 'string' || !isSafeSshHost(alias)) {
        errors.push(
          `${path}.roleAliases: every value must match the loader's safe ssh host rule`,
        );
      }
    }
  }

  const runner =
    fields.runner === undefined
      ? undefined
      : buildHostRunner(fields.runner, `${path}.runner`, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const host: HostSection = {
    transport: transport as HostTransport,
    ...(transport === 'ssh' ? { sshAlias: sshAlias as string } : {}),
    ...(container !== undefined ? { container: container as string } : {}),
    ...(aliases !== undefined
      ? { roleAliases: aliases as Partial<Record<HostRole, string>> }
      : {}),
    worktreeRoot: worktreeRoot as string,
    ...(tmpDir !== undefined ? { tmpDir: tmpDir as string } : {}),
    roles: [...validRoles],
    ...(runner !== undefined ? { runner } : {}),
  };
  return { ok: true, draft: { name, host } };
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

/**
 * An installation value whose hosts may receive a draft. A hostile `current`
 * (accessor-carrying or non-plain fields) is read through own-data guards, so
 * no getter ever runs and nothing throws.
 */
export function baseV2File(current: unknown): HostDraftCandidate | undefined {
  if (current === undefined || current === null) {
    return { schemaVersion: 2, hosts: {} };
  }
  if (typeof current !== 'object' || Array.isArray(current)) {
    return undefined;
  }
  // Read through the own data properties: an accessor never runs, so a
  // throwing getter is refused, not executed.
  if (ownDataValue(current, 'schemaVersion') !== 2) {
    return undefined;
  }
  const hostsField = ownDataValue(current, 'hosts');
  const hosts = copyOwnData(hostsField) ?? {};
  return {
    ...copyOwnData(current),
    schemaVersion: 2,
    hosts: hosts as Readonly<Record<string, HostSection>>,
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
      readonly reason: 'exists' | 'missing' | 'not-v2' | 'invalid';
      readonly errors: readonly string[];
    };

/**
 * How the draft is applied: `add` files a new host and refuses a name that
 * is already in the file; `edit` replaces an existing host and refuses a
 * name that is not there. Neither mode silently upgrades to the other.
 */
export type ApplyHostDraftMode = 'add' | 'edit';

/**
 * In `edit` mode carry the contract fields the draft does not manage over to
 * the drafted entry, with drafted-precedence: a field the draft supplies
 * wins, and a field the draft omits keeps the existing entry's value.
 * `roleAliases` are the one exception when the draft omits them: the
 * inherited map is pruned to the roles the drafted host still holds, so an
 * edit that drops a role drops that role's alias too.
 * Every other field is the draft's: one the draft omits is dropped, so an
 * edit that moves a host to `local` does not keep the old `sshAlias`.
 * A role alias survives only while the drafted host is an ssh host that
 * still holds that role, and a tunnel offset only while the drafted host
 * has a runner. In `add` mode there is no existing entry, so nothing is
 * carried.
 * Every read goes through own-data guards: a base file carrying
 * `roleAliases: null`, arrays, primitives, non-plain prototypes or throwing
 * getters yields `undefined` and never throws.
 */
function mergeDraftedHost(
  existing: HostSection,
  drafted: HostSection,
): HostSection {
  const guardedExisting = copyOwnData(existing);
  const guardedContainer =
    guardedExisting === undefined
      ? undefined
      : ownDataValue(guardedExisting, 'container');
  const guardedRunner =
    guardedExisting === undefined
      ? undefined
      : copyOwnData(ownDataValue(guardedExisting, 'runner'));
  const guardedTunnelOffset =
    guardedRunner === undefined
      ? undefined
      : ownDataValue(guardedRunner, 'tunnelOffset');
  const guardedAliases =
    guardedExisting === undefined
      ? undefined
      : copyOwnData(ownDataValue(guardedExisting, 'roleAliases'));

  // The draft's nested fields are the caller's runtime values, not copies:
  // the runner and the roles array are read through own-data guards so a
  // getter is never invoked and nothing throws.
  const guardedDraftedRunner =
    drafted.runner === undefined
      ? undefined
      : copyOwnData(drafted.runner);
  const draftedTunnelOffset =
    guardedDraftedRunner === undefined
      ? undefined
      : ownDataValue(guardedDraftedRunner, 'tunnelOffset');

  const container = drafted.container ?? readGuardedString(guardedContainer);
  const tunnelOffset = draftedTunnelOffset ?? readGuardedNumber(guardedTunnelOffset);

  let roleAliases: Partial<Record<HostRole, string>> | undefined;
  if (drafted.roleAliases !== undefined) {
    // The draft's own alias map wins as supplied.
    roleAliases = drafted.roleAliases;
  } else if (guardedAliases !== undefined && drafted.transport === 'ssh') {
    const pruned: Partial<Record<HostRole, string>> = {};
    const draftedRoles = drafted.roles;
    const draftedRolesLength =
      Array.isArray(draftedRoles)
        ? (ownDataValue(draftedRoles, 'length') as number | undefined)
        : undefined;
    if (typeof draftedRolesLength === 'number') {
      for (let index = 0; index < draftedRolesLength; index += 1) {
        const role = ownDataValue(draftedRoles as unknown as object, String(index));
        if (typeof role !== 'string') {
          continue;
        }
        const alias = guardedAliases[role];
        if (typeof alias === 'string') {
          pruned[role as HostRole] = alias;
        }
      }
    }
    if (Object.keys(pruned).length > 0) {
      roleAliases = pruned;
    }
  }

  return {
    ...drafted,
    ...(container !== undefined ? { container } : {}),
    ...(roleAliases !== undefined ? { roleAliases } : {}),
    ...(drafted.runner !== undefined && tunnelOffset !== undefined
      ? {
          runner: {
            ...(guardedDraftedRunner ?? {}),
            tunnelOffset,
          } as HostSection['runner'],
        }
      : {}),
  };
}

/**
 * The guarded scalar reads over a copied own-data record: a value that is not
 * the expected plain type is absent, never carried.
 */
function readGuardedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readGuardedNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Apply one draft to a copy of the current installation value and return the
 * candidate file. The current value is never mutated: the candidate is a new
 * object whose `hosts` record is the current one plus the drafted entry. In
 * `add` mode a name already in the file is refused with `reason: "exists"`;
 * in `edit` mode a name that is not there is refused with `reason: "missing"`
 * and the contract fields the draft does not manage survive from the existing
 * entry.
 * A file of schema version 1 carries no hosts and converting one is a mapping
 * step of its own (the conversion forces the isolation acknowledgement), so
 * it is refused here rather than half-done.
 * A hostile draft (null, a primitive, a missing name, a non-plain host entry)
 * is refused, never thrown on, and never runs a getter.
 */
export function applyHostDraft(
  current: unknown,
  draft: HostDraft,
  mode: ApplyHostDraftMode,
): ApplyHostDraftResult {
  const draftFields = copyOwnData(draft);
  const name = readGuardedString(
    draftFields === undefined ? undefined : draftFields.name,
  );
  const host =
    draftFields === undefined ? undefined : copyOwnData(draftFields.host);
  if (name === undefined || host === undefined) {
    return {
      ok: false,
      reason: 'not-v2',
      errors: [
        'hosts: the draft must carry a name and a plain host entry',
      ],
    };
  }
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
  const exists = Object.hasOwn(base.hosts, name);
  if (mode === 'add' && exists) {
    return {
      ok: false,
      reason: 'exists',
      errors: [
        `${hostPath(name)}: already in the installation file; editing is a separate mode`,
      ],
    };
  }
  if (mode === 'edit' && !exists) {
    return {
      ok: false,
      reason: 'missing',
      errors: [
        `${hostPath(name)}: not in the installation file; adding is a separate mode`,
      ],
    };
  }
  const hostsRecord = { ...base.hosts };
  const merged =
    mode === 'edit'
      ? mergeDraftedHost(base.hosts[name], host as unknown as HostSection)
      : (host as unknown as HostSection);
  // The same field validation `draftHost` runs, on the host as it will be
  // filed: `roles: ["wizard"]` or `roleAliases: null` never reaches `ok: true`.
  const checked = validateHostFields(copyOwnData(merged) ?? {}, name);
  if (!checked.ok) {
    return { ok: false, reason: 'invalid', errors: checked.errors };
  }
  hostsRecord[name] = merged;
  return {
    ok: true,
    candidate: {
      ...base,
      hosts: hostsRecord,
    },
  };
}
