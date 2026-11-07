// @generated adapter scaffold — refined for lane O2a-1.
/**
 * OrchestratorSessionRepositoryAdapter implements OrchestratorSessionRepositoryPort
 * over a local JSON store: an in-process map that optionally persists to
 * `<stateDir>/orchestrators.json` under an exclusive lock with an atomic write,
 * exactly as the OwnerQuestion repository does.
 *
 * It never shares another store's file: orchestrator sessions are their own
 * aggregate, and no authorization use case reads them. Each entry on disk is
 * `{ "revision": <n>, "session": <record> }`, so the revision lives beside,
 * never inside, the record. Writes are revision-aware: a save whose expected
 * revision does not match the freshly read revision raises the typed
 * OrchestratorSessionRevisionConflictError rather than a silent overwrite.
 * A save that only renews the lease or the mailbox poll of an active session
 * emits a `heartbeat` change signal; every other save emits `orchestrator`.
 *
 * One active session per conductor identity is the store's own invariant: a
 * save of a second ACTIVE conductor session for the same host in this store
 * is refused with the typed OrchestratorSessionIdentityAlreadyActiveError,
 * and `registerOrAdoptSession` is the one locked operation that adopts,
 * replaces or registers the identity's single session under the store's
 * lock.
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type { OrchestratorSessionRecord } from "../../domain/orchestrator-session-records.js";
import { OrchestratorSession, isOrchestratorAttached, isOrchestratorTokenId } from "../../domain/entities/OrchestratorSession.js";
import { ORCHESTRATOR_SESSION_LEASE_SECONDS } from "../../domain/entities/OrchestratorSession.js";
import { containsSecretShape } from "@fleet/shared";
import {
  OrchestratorSessionIdentityAlreadyActiveError,
  OrchestratorSessionRevisionConflictError,
} from "../../application/ports/out/OrchestratorSessionRepositoryPort.out-port.js";
import type {
  OrchestratorSessionIdentity,
  OrchestratorSessionListQuery,
  OrchestratorSessionRepositoryPort,
  RegisterOrAdoptSessionResult,
  StoredOrchestratorSession,
} from "../../application/ports/out/OrchestratorSessionRepositoryPort.out-port.js";
import type {
  ChangeSignal,
  ChangeSignalPort,
} from "../../application/ports/out/ChangeSignalPort.out-port.js";
import { NoopChangeSignalAdapter } from "./NoopChangeSignalAdapter.adapter.js";
import { withFileLock, writeJsonAtomically } from "./file-store.js";
import { readRecordList, readRevisionedEntry } from "./record-list-store.js";

export interface OrchestratorSessionRepositoryAdapterOptions {
  /** When set, sessions are persisted here and reloaded on first use. */
  readonly stateDir?: string;
  readonly fileName?: string;
  /** Emitter for post-save change signals; defaults to a no-op adapter. */
  readonly changeSignal?: ChangeSignalPort;
}

const DEFAULT_FILE_NAME = "orchestrators.json";
/** The other operator-coordination stores own their own files; never those. */
const OTHER_STORE_FILE_NAMES = [
  "project-profiles.json",
  "coordination-requests.json",
  "owner-questions.json",
];
/** A configured file name may not escape the state directory it belongs to. */
const SAFE_FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Fresh copies: the three arrays are sliced so callers cannot mutate the store. */
function copy(stored: StoredOrchestratorSession): StoredOrchestratorSession {
  return {
    revision: stored.revision,
    session: {
      ...stored.session,
      projects: stored.session.projects.slice(),
      claims: stored.session.claims.slice(),
      scopes: stored.session.scopes.slice(),
    },
  };
}

function elementWiseEqual(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * A save is a heartbeat only when it renews the lease or the mailbox poll of an
 * existing active session: the identity, the registering token id, model, host,
 * started-at, status and the three arrays are unchanged, and only the
 * heartbeat/lease/poll timestamps moved. Every other save announces an
 * orchestrator change.
 */
function signalKindFor(
  before: OrchestratorSessionRecord | undefined,
  after: OrchestratorSessionRecord,
): "orchestrator" | "heartbeat" {
  if (
    before === undefined ||
    before.status !== "active" ||
    after.status !== "active"
  ) {
    return "orchestrator";
  }
  if (
    before.orchestratorId !== after.orchestratorId ||
    before.registeredByTokenId !== after.registeredByTokenId ||
    before.cliKind !== after.cliKind ||
    before.model !== after.model ||
    before.host !== after.host ||
    before.startedAtIso !== after.startedAtIso ||
    before.status !== after.status
  ) {
    return "orchestrator";
  }
  if (
    !elementWiseEqual(before.projects, after.projects) ||
    !elementWiseEqual(before.claims, after.claims) ||
    !elementWiseEqual(before.scopes, after.scopes)
  ) {
    return "orchestrator";
  }
  return "heartbeat";
}

/** Sessions of the conductor identity this store keeps single. */
const CONDUCTOR_CLI_KIND = 'conductor';

type Refusal = { readonly ok: false; readonly reason: string };

/** Screen one identity text without ever echoing it. */
function screenIdentityText(
  field: 'host' | 'stateDir',
  value: string,
  maxBytes: number,
): string | null {
  if (value.trim().length === 0) {
    return `the conductor identity ${field} must be a non-empty string`;
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    return `the conductor identity ${field} is too long`;
  }
  if (containsSecretShape(value)) {
    return `the conductor identity ${field} was refused`;
  }
  return null;
}

/** Screen the identity's host before any store read; the registration facts are validated by the aggregate. */
function screenAdoptionHost(host: unknown): { readonly ok: true } | Refusal {
  if (typeof host !== 'string') {
    return { ok: false, reason: 'the conductor identity host must be a string' };
  }
  const hostError = screenIdentityText('host', host, 256);
  if (hostError !== null) {
    return { ok: false, reason: hostError };
  }
  return { ok: true };
}

/**
 * Safely read every runtime input field once, as plain data: a hostile
 * getter, a null registration or any other malformed shape is the store's
 * typed refusal, never a throw. The registration's own fields are read here
 * too, so no later step ever touches the caller's object again.
 */
function readAdoptionInputs(
  identity: OrchestratorSessionIdentity,
):
  | {
      readonly ok: true;
      readonly host: string;
      readonly stateDir: string | null;
      readonly registration: OrchestratorSessionIdentity['registration'];
    }
  | Refusal {
  if (typeof identity !== 'object' || identity === null) {
    return { ok: false, reason: 'the conductor identity must be a record' };
  }
  try {
    const source = identity as OrchestratorSessionIdentity;
    const host = source.host;
    const stateDir = source.stateDir;
    const registration = source.registration;
    return {
      ok: true,
      host,
      stateDir: stateDir as string | null,
      registration: {
        orchestratorId: registration.orchestratorId,
        model: registration.model,
        projects: registration.projects,
        claims: registration.claims,
        scopes: registration.scopes,
        registeredByTokenId: registration.registeredByTokenId,
      },
    };
  } catch {
    return { ok: false, reason: 'the conductor registration could not be read' };
  }
}

type PreparedAdoption =
  | {
      readonly ok: true;
      readonly host: string;
      readonly stateDir: string | null;
      readonly registration: OrchestratorSessionIdentity['registration'];
      readonly fresh: OrchestratorSessionRecord;
    }
  | Refusal;

/** Read, screen and build everything the adoption needs before any store read. Never throws on hostile input. */
function prepareAdoption(
  identity: OrchestratorSessionIdentity,
  nowIso: string,
): PreparedAdoption {
  const read = readAdoptionInputs(identity);
  if (!read.ok) {
    return read;
  }
  const screened = screenAdoptionHost(read.host);
  if (!screened.ok) {
    return screened;
  }
  if (typeof nowIso !== 'string' || Number.isNaN(Date.parse(nowIso))) {
    return { ok: false, reason: 'the adoption time is not a valid timestamp' };
  }
  const registration = read.registration;
  if (!isOrchestratorTokenId(registration.registeredByTokenId)) {
    return { ok: false, reason: 'the presenting token could not be identified' };
  }
  const created = buildFreshSession(read.host, registration, nowIso);
  if (!created.ok) {
    return created;
  }
  return {
    ok: true,
    host: read.host,
    stateDir: read.stateDir,
    registration,
    fresh: created.fresh,
  };
}

/** Build the fresh active session record from already-read plain data. */
function buildFreshSession(
  host: string,
  registration: OrchestratorSessionIdentity['registration'],
  nowIso: string,
): { readonly ok: true; readonly fresh: OrchestratorSessionRecord } | Refusal {
  try {
    const created = OrchestratorSession.create({
      orchestratorId: registration.orchestratorId,
      cliKind: CONDUCTOR_CLI_KIND,
      model: registration.model,
      host,
      projects: registration.projects,
      claims: registration.claims,
      scopes: registration.scopes,
      registeredByTokenId: registration.registeredByTokenId,
      startedAtIso: nowIso,
      lastHeartbeatIso: nowIso,
      leaseUntilIso: new Date(
        Date.parse(nowIso) + ORCHESTRATOR_SESSION_LEASE_SECONDS * 1000,
      ).toISOString(),
      lastPolledRequestsAtIso: null,
      status: 'active',
    });
    if (!created.success) {
      return { ok: false, reason: 'the conductor session record was refused' };
    }
    return { ok: true, fresh: created.value.toRecord() };
  } catch {
    return { ok: false, reason: 'the conductor registration could not be read' };
  }
}

type AdoptionDecision =
  | {
      readonly ok: true;
      readonly outcome: 'adopted' | 'registered';
      readonly session: OrchestratorSessionRecord;
      readonly revision: number;
      readonly updates: readonly { readonly stored: StoredOrchestratorSession }[];
      readonly signals: readonly {
        readonly before: OrchestratorSessionRecord | undefined;
        readonly after: OrchestratorSessionRecord;
      }[];
    }
  | Refusal;

type AdoptionUpdates = { readonly stored: StoredOrchestratorSession }[];
type AdoptionSignals = {
  before: OrchestratorSessionRecord | undefined;
  after: OrchestratorSessionRecord;
}[];

/** Load one stored session and retire it at `nowIso`. Pure with respect to the store: the write is returned, never applied. */
function retireStored(
  stored: StoredOrchestratorSession,
  nowIso: string,
):
  | {
      readonly ok: true;
      readonly stored: StoredOrchestratorSession;
      readonly after: OrchestratorSessionRecord;
    }
  | Refusal {
  const loaded = OrchestratorSession.create(stored.session);
  if (!loaded.success) {
    return { ok: false, reason: 'the stored session could not be read' };
  }
  const retired = loaded.value.retire(nowIso);
  if (!retired.success) {
    return { ok: false, reason: 'the lapsed session could not be retired' };
  }
  const record = retired.value.toRecord();
  return {
    ok: true,
    stored: { revision: stored.revision + 1, session: record },
    after: record,
  };
}

/** Renew the single live session and retire every other lapsed candidate. Pure: writes are returned, never applied. */
function adoptTheLiveSession(
  liveStored: StoredOrchestratorSession,
  candidates: readonly StoredOrchestratorSession[],
  nowIso: string,
):
  | {
      readonly ok: true;
      readonly record: OrchestratorSessionRecord;
      readonly revision: number;
      readonly updates: AdoptionUpdates;
      readonly signals: AdoptionSignals;
    }
  | Refusal {
  const loaded = OrchestratorSession.create(liveStored.session);
  if (!loaded.success) {
    return { ok: false, reason: 'the stored session could not be read' };
  }
  const renewed = loaded.value.renewLease(nowIso);
  if (!renewed.success) {
    return { ok: false, reason: 'the live session could not be renewed' };
  }
  const record = renewed.value.toRecord();
  const revision = liveStored.revision + 1;
  const updates: AdoptionUpdates = [{ stored: { revision, session: record } }];
  const signals: AdoptionSignals = [{ before: liveStored.session, after: record }];
  for (const lapsed of candidates) {
    if (lapsed.session.orchestratorId === liveStored.session.orchestratorId) {
      continue;
    }
    const retired = retireStored(lapsed, nowIso);
    if (!retired.ok) {
      return retired;
    }
    updates.push({ stored: retired.stored });
    signals.push({ before: lapsed.session, after: retired.after });
  }
  return { ok: true, record, revision, updates, signals };
}

/** Retire every lapsed candidate and register `fresh` over known absence. Pure: writes are returned, never applied. */
function registerFreshSession(
  candidates: readonly StoredOrchestratorSession[],
  fresh: OrchestratorSessionRecord,
  nowIso: string,
):
  | {
      readonly ok: true;
      readonly updates: AdoptionUpdates;
      readonly signals: AdoptionSignals;
    }
  | Refusal {
  const updates: AdoptionUpdates = [];
  const signals: AdoptionSignals = [];
  for (const lapsed of candidates) {
    const retired = retireStored(lapsed, nowIso);
    if (!retired.ok) {
      return retired;
    }
    updates.push({ stored: retired.stored });
    signals.push({ before: lapsed.session, after: retired.after });
  }
  updates.push({ stored: { revision: 1, session: fresh } });
  signals.push({ before: undefined, after: fresh });
  return { ok: true, updates, signals };
}

/**
 * The one decision of `registerOrAdoptSession` over an already-read set of
 * records: adopt the single live conductor session for the identity, or
 * retire the lapsed ones and register the new record, or register over known
 * absence. Pure with respect to the map: writes are returned, never applied.
 */
function decideAdoption(
  records: ReadonlyMap<string, StoredOrchestratorSession>,
  host: string,
  fresh: OrchestratorSessionRecord,
  nowIso: string,
): AdoptionDecision {
  if (records.has(fresh.orchestratorId)) {
    return { ok: false, reason: 'an orchestrator session with this id already exists' };
  }
  const candidates = [...records.values()].filter(
    (stored) =>
      stored.session.cliKind === CONDUCTOR_CLI_KIND &&
      stored.session.status === 'active' &&
      stored.session.host === host,
  );
  const live = candidates.filter((stored) =>
    isOrchestratorAttached(stored.session, nowIso),
  );
  if (live.length > 1) {
    return {
      ok: false,
      reason: 'more than one live session exists for this conductor identity',
    };
  }
  if (live.length === 1) {
    const adopted = adoptTheLiveSession(live[0]!, candidates, nowIso);
    if (!adopted.ok) {
      return adopted;
    }
    return {
      ok: true,
      outcome: 'adopted',
      session: adopted.record,
      revision: adopted.revision,
      updates: adopted.updates,
      signals: adopted.signals,
    };
  }
  const registered = registerFreshSession(candidates, fresh, nowIso);
  if (!registered.ok) {
    return registered;
  }
  return {
    ok: true,
    outcome: 'registered',
    session: fresh,
    revision: 1,
    updates: registered.updates,
    signals: registered.signals,
  };
}

function applyAdoption(
  records: Map<string, StoredOrchestratorSession>,
  decision: Extract<AdoptionDecision, { ok: true }>,
): void {
  for (const update of decision.updates) {
    records.set(update.stored.session.orchestratorId, update.stored);
  }
}

/**
 * The store-side invariant: no second ACTIVE session for one conductor
 * identity (same host, in this same store) is ever written. The session
 * being written never conflicts with itself.
 */
function assertNoActiveIdentityConflict(
  records: ReadonlyMap<string, StoredOrchestratorSession>,
  record: OrchestratorSessionRecord,
): void {
  if (record.status !== 'active' || record.cliKind !== CONDUCTOR_CLI_KIND) {
    return;
  }
  for (const other of records.values()) {
    if (
      other.session.orchestratorId !== record.orchestratorId &&
      other.session.cliKind === CONDUCTOR_CLI_KIND &&
      other.session.status === 'active' &&
      other.session.host === record.host
    ) {
      throw new OrchestratorSessionIdentityAlreadyActiveError();
    }
  }
}

/**
 * The reader's record parser, shared with `fleet-v2 state check`. Never throws:
 * any malformed entry is `undefined`, which makes the file unreadable so the
 * exact bytes are quarantined instead of silently dropped.
 */
export function parseOrchestratorSessionStateRecord(
  raw: unknown,
): StoredOrchestratorSession | undefined {
  try {
    const entry = readRevisionedEntry(raw, "session");
    if (entry === undefined) {
      return undefined;
    }
    const result = OrchestratorSession.create(entry.record);
    return result.success
      ? { revision: entry.revision, session: result.value.toRecord() }
      : undefined;
  } catch {
    return undefined;
  }
}

export class OrchestratorSessionRepositoryAdapter implements OrchestratorSessionRepositoryPort {
  private readonly inMemorySessions = new Map<
    string,
    StoredOrchestratorSession
  >();
  private readonly changeSignal: ChangeSignalPort;
  private signalEmitFailuresCount = 0;

  constructor(
    private readonly options: OrchestratorSessionRepositoryAdapterOptions = {},
  ) {
    this.changeSignal = options.changeSignal ?? new NoopChangeSignalAdapter();
  }

  get signalEmitFailures(): number {
    return this.signalEmitFailuresCount;
  }

  private signal(sig: ChangeSignal): void {
    try {
      this.changeSignal.emit(sig);
    } catch {
      this.signalEmitFailuresCount += 1;
    }
  }

  async save(
    session: OrchestratorSessionRecord,
    expectedRevision: number,
  ): Promise<StoredOrchestratorSession> {
    if (
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        "OrchestratorSessionRepositoryAdapter expected revision must be a non-negative integer",
      );
    }
    const validatedResult = OrchestratorSession.create(session);
    if (!validatedResult.success) {
      throw new Error(validatedResult.error.message);
    }
    const validated = validatedResult.value.toRecord();
    const target = this.statePath;

    if (target === null) {
      const existing = this.inMemorySessions.get(validated.orchestratorId);
      const storedRevision = existing === undefined ? 0 : existing.revision;
      if (storedRevision !== expectedRevision) {
        throw new OrchestratorSessionRevisionConflictError(
          validated.orchestratorId,
          expectedRevision + 1,
          "OrchestratorSessionRepositoryAdapter refuses a stale expected revision",
        );
      }
      assertNoActiveIdentityConflict(this.inMemorySessions, validated);
      const stored: StoredOrchestratorSession = {
        revision: expectedRevision + 1,
        session: validated,
      };
      this.inMemorySessions.set(validated.orchestratorId, stored);
      this.signal({
        kind: signalKindFor(existing?.session, validated),
        id: validated.orchestratorId,
        stateFile: null,
        before: null,
        written: null,
      });
      return copy(stored);
    }

    let existing: StoredOrchestratorSession | undefined;
    let before: ChangeSignal["before"] = null;
    let written: ChangeSignal["written"] = null;

    await withFileLock(`${target}.lock`, async () => {
      try {
        const stat = await fs.stat(target);
        before = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        before = null;
      }
      const records = await this.readRecordsFromDisk(target);
      const stored = records.get(validated.orchestratorId);
      const storedRevision = stored === undefined ? 0 : stored.revision;
      if (storedRevision !== expectedRevision) {
        throw new OrchestratorSessionRevisionConflictError(
          validated.orchestratorId,
          expectedRevision + 1,
          "OrchestratorSessionRepositoryAdapter refuses a stale expected revision",
        );
      }
      assertNoActiveIdentityConflict(records, validated);
      existing = stored;
      const next: StoredOrchestratorSession = {
        revision: expectedRevision + 1,
        session: validated,
      };
      records.set(validated.orchestratorId, next);
      const list = [...records.values()]
        .sort((left, right) =>
          left.session.orchestratorId.localeCompare(
            right.session.orchestratorId,
          ),
        )
        .map(copy);
      await writeJsonAtomically(target, list);
      try {
        const stat = await fs.stat(target);
        written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
      } catch {
        written = null;
      }
    });

    const stored: StoredOrchestratorSession = {
      revision: expectedRevision + 1,
      session: validated,
    };
    this.signal({
      kind: signalKindFor(existing?.session, validated),
      id: validated.orchestratorId,
      stateFile: resolve(target),
      before,
      written,
    });
    return copy(stored);
  }

  /**
   * ONE locked operation, keyed by the conductor identity (host plus state
   * directory, both screened). Under the store's lock it does exactly one of
   * three things: adopts the single live session for the identity and
   * refreshes its heartbeat, retires a lapsed one and registers a new one, or
   * registers when there is none. An unreadable store is refused and never
   * registers; every refusal names a fixed reason and never the identity.
   */
  async registerOrAdoptSession(
    identity: OrchestratorSessionIdentity,
    nowIso: string,
  ): Promise<RegisterOrAdoptSessionResult> {
    const prepared = prepareAdoption(identity, nowIso);
    if (!prepared.ok) {
      return { outcome: 'refused', reason: prepared.reason };
    }
    const stateDirCheck = this.stateDirMatches(prepared.stateDir);
    if (!stateDirCheck.ok) {
      return { outcome: 'refused', reason: stateDirCheck.reason };
    }
    const target = this.statePath;

    if (target === null) {
      // The in-memory store's decision is one synchronous step on its map.
      return this.adoptInMemory(prepared.host, prepared.fresh, nowIso);
    }
    return this.adoptOnDisk(prepared.host, prepared.fresh, nowIso, target);
  }

  /** The in-memory branch of `registerOrAdoptSession`: decide on the map, apply, signal. */
  private adoptInMemory(
    host: string,
    fresh: OrchestratorSessionRecord,
    nowIso: string,
  ): RegisterOrAdoptSessionResult {
    const decision = decideAdoption(this.inMemorySessions, host, fresh, nowIso);
    if (!decision.ok) {
      return { outcome: 'refused', reason: decision.reason };
    }
    applyAdoption(this.inMemorySessions, decision);
    for (const signalOf of decision.signals) {
      this.signal({
        kind: signalKindFor(signalOf.before, signalOf.after),
        id: signalOf.after.orchestratorId,
        stateFile: null,
        before: null,
        written: null,
      });
    }
    return {
      outcome: decision.outcome,
      session: copy({ revision: decision.revision, session: decision.session }).session,
      revision: decision.revision,
    };
  }

  /** The file-backed branch of `registerOrAdoptSession`: decide under the lock, write, signal. */
  private async adoptOnDisk(
    host: string,
    fresh: OrchestratorSessionRecord,
    nowIso: string,
    target: string,
  ): Promise<RegisterOrAdoptSessionResult> {
    let written: ChangeSignal["written"] = null;
    let locked: AdoptionDecision;
    try {
      locked = await withFileLock(`${target}.lock`, async (): Promise<AdoptionDecision> => {
        const records = await this.readRecordsFromDisk(target);
        const decision = decideAdoption(records, host, fresh, nowIso);
        if (!decision.ok) {
          return decision;
        }
        applyAdoption(records, decision);
        const list = [...records.values()]
          .sort((left, right) =>
            left.session.orchestratorId.localeCompare(right.session.orchestratorId),
          )
          .map(copy);
        await writeJsonAtomically(target, list);
        try {
          const stat = await fs.stat(target);
          written = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
        } catch {
          written = null;
        }
        return decision;
      });
    } catch {
      // An unreadable store, a lost lock or any other store failure refuses;
      // it never registers and the thrown detail is never echoed.
      return {
        outcome: 'refused',
        reason: 'the orchestrator session store could not be read',
      };
    }
    if (!locked.ok) {
      return { outcome: 'refused', reason: locked.reason };
    }
    for (const signalOf of locked.signals) {
      this.signal({
        kind: signalKindFor(signalOf.before, signalOf.after),
        id: signalOf.after.orchestratorId,
        stateFile: resolve(target),
        before: null,
        written,
      });
    }
    return {
      outcome: locked.outcome,
      session: copy({ revision: locked.revision, session: locked.session }).session,
      revision: locked.revision,
    };
  }

  /**
   * Screen a supplied state directory against this store's own: null matches
   * any store's own directory, and a supplied value must name this store's
   * directory exactly (a store never acts on another store's identity).
   */
  private stateDirMatches(
    identityStateDir: string | null,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    if (identityStateDir === null) {
      return { ok: true };
    }
    if (typeof identityStateDir !== 'string') {
      return {
        ok: false,
        reason: 'the conductor identity state directory must be null or a string',
      };
    }
    const screened = screenIdentityText('stateDir', identityStateDir, 1024);
    if (screened !== null) {
      return { ok: false, reason: screened };
    }
    const own = this.options.stateDir;
    if (own === undefined || own.trim().length === 0) {
      return { ok: false, reason: 'the identity does not belong to this store' };
    }
    if (resolve(identityStateDir) !== resolve(own)) {
      return { ok: false, reason: 'the identity does not belong to this store' };
    }
    return { ok: true };
  }

  async get(orchestratorId: string): Promise<StoredOrchestratorSession | null> {
    const target = this.statePath;
    if (target === null) {
      const found = this.inMemorySessions.get(orchestratorId);
      return found === undefined ? null : copy(found);
    }
    const records = await this.readRecordsFromDisk(target);
    const found = records.get(orchestratorId);
    return found === undefined ? null : copy(found);
  }

  async list(
    query?: OrchestratorSessionListQuery,
  ): Promise<readonly StoredOrchestratorSession[]> {
    const target = this.statePath;
    const records =
      target === null
        ? this.inMemorySessions
        : await this.readRecordsFromDisk(target);
    return [...records.values()]
      .filter(
        (stored) =>
          query?.status === undefined || stored.session.status === query.status,
      )
      .sort((left, right) =>
        left.session.startedAtIso === right.session.startedAtIso
          ? left.session.orchestratorId.localeCompare(
              right.session.orchestratorId,
            )
          : left.session.startedAtIso.localeCompare(right.session.startedAtIso),
      )
      .map(copy);
  }

  private get statePath(): string | null {
    const { stateDir, fileName } = this.options;
    if (stateDir === undefined || stateDir.trim().length === 0) {
      return null;
    }
    const name = fileName ?? DEFAULT_FILE_NAME;
    if (OTHER_STORE_FILE_NAMES.includes(name)) {
      throw new Error(
        "OrchestratorSessionRepositoryAdapter refuses a fileName that collides with another store",
      );
    }
    if (!SAFE_FILE_NAME.test(name) || name === "." || name === "..") {
      throw new Error(
        "OrchestratorSessionRepositoryAdapter refuses unsafe state file name",
      );
    }
    return join(stateDir, name);
  }

  private async readRecordsFromDisk(
    path: string,
  ): Promise<Map<string, StoredOrchestratorSession>> {
    const records = await readRecordList(
      path,
      "OrchestratorSessionRepositoryAdapter",
      parseOrchestratorSessionStateRecord,
    );
    const map = new Map<string, StoredOrchestratorSession>();
    for (const stored of records) {
      map.set(stored.session.orchestratorId, stored);
    }
    return map;
  }
}
