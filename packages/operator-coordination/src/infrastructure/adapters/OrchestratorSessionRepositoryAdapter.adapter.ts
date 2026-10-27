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
 */

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type { OrchestratorSessionRecord } from "../../domain/orchestrator-session-records.js";
import { OrchestratorSession } from "../../domain/entities/OrchestratorSession.js";
import { OrchestratorSessionRevisionConflictError } from "../../application/ports/out/OrchestratorSessionRepositoryPort.out-port.js";
import type {
  OrchestratorSessionListQuery,
  OrchestratorSessionRepositoryPort,
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
