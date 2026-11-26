import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AttemptRepositoryAdapter,
  AuthorityEventJournalAdapter,
  LaneRun,
  LaneRunRepositoryAdapter,
  withStopAuthorityEvents,
  type AttemptRecord,
  type LaneRunRecord,
  type StopAuthorityEventContext,
  type StopAttemptPort,
} from "@fleet/work-execution";

import { createConfiguredWorkComposition } from "../work/composition";

const createdDirs = new Set<string>();

beforeAll(() => {
  // The recorded runner host is `null`, so any ambient OCM_HOST would turn
  // every stop into a configured-host mismatch refusal before the stub runs.
  delete process.env.OCM_HOST;
});

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  createdDirs.add(directory);
  return directory;
}

const NOW_ISO = "2026-11-26T09:00:00.000Z";
const ATTEMPT_ID = "attempt-fc12d-1";
const RUN_ID = "run-01JB0000000000000000000000";
const OTHER_RUN_ID = "run-01JB0000000000000000000001";
const ENTRY_ID = "01JD0000000000000000000001";
const RETRY_ENTRY_ID = "01JD0000000000000000000002";
/** Kept off the OCM_* env so the recorded port/host are the only match. */
const RUNNER_REMOTE_PORT = 4096;

/** A tiny executable stand-in for the bundled `ocm-run` runner script. */
async function makeOcmRunStub(): Promise<string> {
  const dir = await makeTempDir("fleet-fc12d-ocm-run-");
  const stub = path.join(dir, "ocm-run");
  await writeFile(stub, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(stub, 0o755);
  return stub;
}

/** One valid attempt record; `stateDir` only fills the worktree path field. */
function makeAttemptRecord(id: string, worktreePath = "/tmp/fleet-fc12d-unused"): AttemptRecord {
  return {
    id,
    workOrderId: "wo-fc12d",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath,
    baseCommit: "a".repeat(40),
    state: "running",
    revision: 1,
    outcome: null,
    briefDigest: null,
    briefPackagePath: null,
    sessionId: "sess-1",
    completionReceipt: null,
    artifacts: null,
    runner: {
      kind: "opencode",
      remotePort: RUNNER_REMOTE_PORT,
      host: null,
      agent: "lane",
      model: "m-1",
      variant: null,
    },
    createdAtIso: NOW_ISO,
    updatedAtIso: NOW_ISO,
  };
}

async function seedRunningAttempt(stateDir: string): Promise<void> {
  await new AttemptRepositoryAdapter({ stateDir }).saveAttempt(
    makeAttemptRecord(ATTEMPT_ID, stateDir),
  );
}

/** One active lane run that owns no attempt. */
async function seedLaneRun(stateDir: string, runId: string): Promise<void> {
  const built = LaneRun.create({
    version: 1,
    runId,
    workOrderId: "wo-fc12d",
    tier: 2,
    seatPlanRef: "a".repeat(64),
    cursors: { "first-pass": 0, fix: null, review: null },
    round: 0,
    attemptIds: [],
    prNumber: null,
    parked: null,
    parkCount: 0,
    lease: null,
    revision: 1,
    runPolicyRevision: "policy-fc12d",
  });
  if (!built.success) {
    throw new Error("fixture must be a valid LaneRun record");
  }
  const record: LaneRunRecord = built.value.toRecord();
  await new LaneRunRepositoryAdapter({ stateDir }).create(record);
}

/** Parsed journal lines, or null when the journal does not exist. */
async function readJournal(stateDir: string): Promise<Array<Record<string, unknown>> | null> {
  try {
    const content = await readFile(path.join(stateDir, "authority-events.jsonl"), "utf8");
    return content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function makeDurableComposition(): Promise<{
  stateDir: string;
  ocmRunBin: string;
}> {
  const stateDir = await makeTempDir("fleet-fc12d-stop-authority-");
  const ocmRunBin = await makeOcmRunStub();
  await seedRunningAttempt(stateDir);
  await seedLaneRun(stateDir, RUN_ID);
  return { stateDir, ocmRunBin };
}

/** The composition options every durable test uses for the stub runner. */
function compositionOptions(stateDir: string, ocmRunBin: string) {
  return { stateDir, ocmRunBin, runnerRemotePort: RUNNER_REMOTE_PORT };
}

describe("API stop authority event wiring (FC12D)", () => {
  it("emits one authority event to authority-events.jsonl when work.stopAttempt stops an attempt", async () => {
    const { stateDir, ocmRunBin } = await makeDurableComposition();
    const work = createConfiguredWorkComposition(compositionOptions(stateDir, ocmRunBin));

    const stopped = await work.stopAttempt.stopAttempt({
      attemptId: ATTEMPT_ID,
      nowIso: NOW_ISO,
    });
    expect(stopped.outcome).toBe("terminated");

    const events = await readJournal(stateDir);
    expect(events).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events![0]).toEqual({
      eventId: `stop-attempt/${ATTEMPT_ID}`,
      kind: "stop",
      actor: "web-api",
      organizationId: null,
      atIso: NOW_ISO,
      beforeRevision: null,
      afterRevision: null,
    });
  });

  it("emits one authority event on requestLaneRunStop, refuses an exact replay of the same request, and keeps one line with the same eventId on a fresh-entryId retry", async () => {
    const { stateDir, ocmRunBin } = await makeDurableComposition();
    const work = createConfiguredWorkComposition(compositionOptions(stateDir, ocmRunBin));
    const request = {
      runId: RUN_ID,
      mode: "graceful" as const,
      via: "web" as const,
      entryId: ENTRY_ID,
      nowIso: NOW_ISO,
    };

    const recorded = await work.requestLaneRunStop.requestLaneRunStop(request);
    expect(recorded.outcome).toBe("stop-recorded");
    const events = await readJournal(stateDir);
    expect(events).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events![0]).toEqual({
      eventId: `stop:${RUN_ID}/stop@web`,
      kind: "stop",
      actor: "web-api",
      organizationId: null,
      atIso: NOW_ISO,
      beforeRevision: null,
      afterRevision: null,
    });

    // The brief's retry requirement: the exact same request, byte for byte.
    // The run journal refuses a replayed entry id (`duplicate-entry-id`), so
    // the use case answers `refused/journal-refused` — and appends nothing:
    // the journal still holds exactly one line with the identical event id.
    const replayed = await work.requestLaneRunStop.requestLaneRunStop(request);
    expect(replayed).toEqual({ outcome: "refused", reason: "journal-refused" });
    const afterReplay = await readJournal(stateDir);
    expect(afterReplay).not.toBeNull();
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay![0]!["eventId"]).toBe(`stop:${RUN_ID}/stop@web`);

    // The wired retry the web stop route actually performs (`stop.post.ts`
    // mints a fresh entry id per HTTP call): the same stop key answers
    // `already-requested`, and the audited wrapper re-emits the identical
    // event id to the idempotent sink — still exactly one journal line.
    const retryRequest = { ...request, entryId: RETRY_ENTRY_ID };
    const retried = await work.requestLaneRunStop.requestLaneRunStop(retryRequest);
    expect(retried).toEqual({ outcome: "already-requested", runId: RUN_ID, mode: "graceful" });
    const afterRetry = await readJournal(stateDir);
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry![0]!["eventId"]).toBe(`stop:${RUN_ID}/stop@web`);
  });

  it("writes no authority-events.jsonl when stopAttempt or requestLaneRunStop refuses or finds no target", async () => {
    const stateDir = await makeTempDir("fleet-fc12d-stop-refusal-");
    const ocmRunBin = await makeOcmRunStub();
    const work = createConfiguredWorkComposition(compositionOptions(stateDir, ocmRunBin));

    const refusedStop = await work.stopAttempt.stopAttempt({
      attemptId: "missing-attempt",
      nowIso: NOW_ISO,
    });
    expect(refusedStop.outcome).toBe("refused");

    const notFoundStop = await work.requestLaneRunStop.requestLaneRunStop({
      runId: OTHER_RUN_ID,
      mode: "graceful",
      via: "web",
      entryId: ENTRY_ID,
      nowIso: NOW_ISO,
    });
    expect(notFoundStop.outcome).toBe("not-found");

    expect(await readJournal(stateDir)).toBeNull();
  });

  it("performs no file write when composition has no durable stateDir", async () => {
    const ocmRunBin = await makeOcmRunStub();
    const work = createConfiguredWorkComposition({
      ocmRunBin,
      runnerRemotePort: RUNNER_REMOTE_PORT,
    });
    const unusedDir = await makeTempDir("fleet-fc12d-stop-unnused-");

    const refused = await work.stopAttempt.stopAttempt({
      attemptId: "attempt-absent",
      nowIso: NOW_ISO,
    });
    expect(refused.outcome).toBe("refused");

    // The disposable composition wires the lane-run stop with a null sink
    // behind a use case built without repositories: the use case's own
    // not-implemented failure propagates unchanged and the null sink is
    // never touched.
    await expect(
      work.requestLaneRunStop.requestLaneRunStop({
        runId: RUN_ID,
        mode: "graceful",
        via: "web",
        entryId: ENTRY_ID,
        nowIso: NOW_ISO,
      }),
    ).rejects.toThrow("Not implemented: RequestLaneRunStopUseCase");

    await expect(
      readFile(path.join(unusedDir, "authority-events.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes the stop event path without error through the in-memory and null sinks the disposable composition wires", async () => {
    // The same wrapper `createConfiguredWorkComposition` applies, over a stub
    // stop use case: the disposable composition wires an in-memory
    // `AuthorityEventJournalAdapter` behind `stopAttempt` and `null` behind
    // `requestLaneRunStop`, so both sink shapes must complete the event path
    // without error.
    const attempt = makeAttemptRecord("attempt-fc12d-sink");
    const useCase: StopAttemptPort = {
      stopAttempt: async () => ({
        outcome: "terminated",
        attempt,
        receipt: {
          attemptId: attempt.id,
          sessionId: "sess-1",
          endedAtIso: NOW_ISO,
          authoritative: true,
          exitStatus: null,
          stoppedByRequest: true,
        },
        capacityReleased: true,
      }),
    };
    const context: StopAuthorityEventContext = { actor: "web-api", organizationId: null };

    const inMemory = withStopAuthorityEvents(
      useCase,
      new AuthorityEventJournalAdapter({}),
      context,
    );
    const first = await inMemory.stopAttempt({ attemptId: attempt.id, nowIso: NOW_ISO });
    expect(first.result.outcome).toBe("terminated");
    expect(first.auditGap).toBe(false);
    const repeat = await inMemory.stopAttempt({ attemptId: attempt.id, nowIso: NOW_ISO });
    expect(repeat.result.outcome).toBe("terminated");
    expect(repeat.auditGap).toBe(false);

    const nullSink = withStopAuthorityEvents(useCase, null, context);
    const gapped = await nullSink.stopAttempt({ attemptId: attempt.id, nowIso: NOW_ISO });
    expect(gapped.result.outcome).toBe("terminated");
    expect(gapped.auditGap).toBe(true);
  });
});
