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

import {
  HOST_NAME_SECRET_REFUSAL,
  HOST_NAME_TOO_LONG,
  MAX_HOST_NAME_ARGUMENT_LENGTH,
  hostNameHasSecretShape,
  isSafeSshHost,
  isValidHostName,
} from '@fleet/installation';
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

/** An opencode runner as the operator described it. */
export interface OpencodeHostRunnerDraft {
  readonly kind: 'opencode';
  /** The opencode server's port on its own host, 1..65535. */
  readonly port: number;
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
    ...(input.gateSlot !== undefined ? { gateSlot: input.gateSlot } : {}),
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
 * A plain object: its prototype is `Object.prototype` or `null`. A class
 * instance carries behaviour a draft or a rename root must not inherit, so it
 * is refused like any other non-object.
 */
function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copy one own data property by descriptor, never by assignment: an own
 * `"__proto__"` data property assigned onto a fresh `{}` triggers the
 * inherited setter and is dropped, so a key the unknown-root-key check must
 * see disappears. A null-prototype target plus `defineProperty` keeps it.
 */
function copyOwnDataProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
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
export function draftHost(input: unknown): HostDraftResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['hosts: host draft is not an object'] };
  }
  const record = input as Record<string, unknown>;
  const nameDescriptor = Object.getOwnPropertyDescriptor(record, 'name');
  if (
    nameDescriptor !== undefined &&
    (nameDescriptor.get !== undefined || nameDescriptor.set !== undefined)
  ) {
    return { ok: false, errors: ['hosts: host name is unreadable'] };
  }
  const name = nameDescriptor?.value;
  if (typeof name !== 'string') {
    return { ok: false, errors: ['hosts: host draft is not an object'] };
  }
  if (name.length > MAX_HOST_NAME_ARGUMENT_LENGTH) {
    return { ok: false, errors: [HOST_NAME_TOO_LONG] };
  }
  if (hostNameHasSecretShape(name)) {
    return { ok: false, errors: [HOST_NAME_SECRET_REFUSAL] };
  }
  const inputRecord = input as HostDraftInput;
  const path = `hosts.${name}`;
  const errors: string[] = [];

  if (inputRecord.transport === 'ssh') {
    if (inputRecord.sshAlias === undefined) {
      errors.push(`${path}.sshAlias: required when transport is "ssh"`);
    } else if (!isSafeSshHost(inputRecord.sshAlias)) {
      // The value never appears in the message: an alias is operator input.
      errors.push(
        `${path}.sshAlias: must match ^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$ and must not start with "-", so it can never be read as an ssh option`,
      );
    }
  } else if (inputRecord.sshAlias !== undefined) {
    errors.push(`${path}.sshAlias: must be absent when transport is "local"`);
  }

  if (!isAbsolute(inputRecord.worktreeRoot)) {
    errors.push(`${path}.worktreeRoot: must be an absolute path`);
  }
  if (inputRecord.tmpDir !== undefined && !isAbsolute(inputRecord.tmpDir)) {
    errors.push(`${path}.tmpDir: must be an absolute path`);
  }

  if (inputRecord.roles.length === 0) {
    errors.push(`${path}.roles: at least one role is required`);
  }
  for (const [index, role] of inputRecord.roles.entries()) {
    if (!HOST_ROLES.includes(role)) {
      errors.push(`${path}.roles[${index}]: must be a known host role`);
    }
  }

  const runner =
    inputRecord.runner === undefined
      ? undefined
      : buildHostRunner(inputRecord.runner, `${path}.runner`, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const host: HostSection = {
    transport: inputRecord.transport,
    ...(inputRecord.transport === 'ssh' && inputRecord.sshAlias !== undefined
      ? { sshAlias: inputRecord.sshAlias }
      : {}),
    worktreeRoot: inputRecord.worktreeRoot,
    ...(inputRecord.tmpDir !== undefined ? { tmpDir: inputRecord.tmpDir } : {}),
    roles: [...inputRecord.roles],
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
 * In `edit` mode carry the contract fields the draft does not manage over to
 * the drafted entry: `container`, `roleAliases` and `runner.tunnelOffset`.
 * Every other field is the draft's: one the draft omits is dropped, so an
 * edit that moves a host to `local` does not keep the old `sshAlias`. A role
 * alias survives only while the drafted host is an ssh host that still holds
 * that role, and a tunnel offset only while the drafted host has a runner.
 * In `add` mode there is no existing entry, so nothing is carried.
 */
function mergeDraftedHost(
  existing: HostSection,
  drafted: HostSection,
): HostSection {
  const aliases: Partial<Record<HostRole, string>> = {};
  if (drafted.transport === 'ssh' && existing.roleAliases !== undefined) {
    for (const role of drafted.roles) {
      const alias = existing.roleAliases[role];
      if (alias !== undefined) {
        aliases[role] = alias;
      }
    }
  }
  const tunnelOffset = existing.runner?.tunnelOffset;
  return {
    ...drafted,
    ...(existing.container !== undefined ? { container: existing.container } : {}),
    ...(Object.keys(aliases).length > 0 ? { roleAliases: aliases } : {}),
    ...(drafted.runner !== undefined && tunnelOffset !== undefined
      ? { runner: { ...drafted.runner, tunnelOffset } }
      : {}),
  };
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
    candidate: {
      ...base,
      hosts: {
        ...base.hosts,
        [draft.name]:
          mode === 'edit'
            ? mergeDraftedHost(base.hosts[draft.name], draft.host)
            : draft.host,
      },
    },
  };
}

/** Why a rename cannot be planned; no reason string contains either name. */
export type PlanHostRenameReason =
  | 'not-object'
  | 'unreadable'
  | 'not-v2'
  | 'hosts-not-object'
  | 'same-name'
  | 'secret-new-name'
  | 'invalid-new-name'
  | 'name-too-long'
  | 'missing'
  | 'exists';

/** A planned rename, or the reason there is no candidate. */
export type PlanHostRenameResult =
  | { readonly ok: true; readonly candidate: HostDraftCandidate }
  | { readonly ok: false; readonly reason: PlanHostRenameReason };

/**
 * Plan one host-key rename: a new v2 root with the old entry moved to the new
 * key, unchanged, and every other own data property copied by descriptor. It
 * never mutates the input and never walks a host entry. Accessors on the root
 * or on a host entry are `unreadable`; the getter is never called.
 */
export function planHostRename(
  value: unknown,
  oldName: string,
  newName: string,
): PlanHostRenameResult {
  if (typeof oldName !== 'string' || typeof newName !== 'string') {
    return { ok: false, reason: 'not-object' };
  }
  if (
    oldName.length > MAX_HOST_NAME_ARGUMENT_LENGTH ||
    newName.length > MAX_HOST_NAME_ARGUMENT_LENGTH
  ) {
    return { ok: false, reason: 'name-too-long' };
  }
  if (oldName === newName) {
    return { ok: false, reason: 'same-name' };
  }
  if (hostNameHasSecretShape(newName)) {
    return { ok: false, reason: 'secret-new-name' };
  }
  if (!isValidHostName(newName)) {
    return { ok: false, reason: 'invalid-new-name' };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'not-object' };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      descriptor !== undefined &&
      (descriptor.get !== undefined || descriptor.set !== undefined)
    ) {
      return { ok: false, reason: 'unreadable' };
    }
  }
  if (record.schemaVersion !== 2) {
    return { ok: false, reason: 'not-v2' };
  }
  const hosts = record.hosts;
  // `hosts` must be a plain object too: a class instance carries behaviour a
  // rename must not inherit, and its own entries are refused with the root
  // (HN1 fix round 2).
  if (!isPlainObject(hosts)) {
    return { ok: false, reason: 'hosts-not-object' };
  }
  const hostsRecord = hosts as Record<string, unknown>;
  if (!Object.hasOwn(hostsRecord, oldName)) {
    return { ok: false, reason: 'missing' };
  }
  if (Object.hasOwn(hostsRecord, newName)) {
    return { ok: false, reason: 'exists' };
  }
  const oldEntryDescriptor = Object.getOwnPropertyDescriptor(hostsRecord, oldName);
  if (
    oldEntryDescriptor === undefined ||
    oldEntryDescriptor.get !== undefined ||
    oldEntryDescriptor.set !== undefined
  ) {
    return { ok: false, reason: 'unreadable' };
  }
  const newHosts: Record<string, unknown> = Object.create(
    null,
  ) as Record<string, unknown>;
  for (const key of Object.keys(hostsRecord)) {
    const descriptor = Object.getOwnPropertyDescriptor(hostsRecord, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return { ok: false, reason: 'unreadable' };
    }
    if (key !== oldName) {
      copyOwnDataProperty(newHosts, key, descriptor.value);
    }
  }
  copyOwnDataProperty(newHosts, newName, oldEntryDescriptor.value);
  const newRoot: Record<string, unknown> = Object.create(
    null,
  ) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === 'hosts') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      return { ok: false, reason: 'unreadable' };
    }
    copyOwnDataProperty(newRoot, key, descriptor.value);
  }
  newRoot.hosts = newHosts;
  return { ok: true, candidate: newRoot as HostDraftCandidate };
}
