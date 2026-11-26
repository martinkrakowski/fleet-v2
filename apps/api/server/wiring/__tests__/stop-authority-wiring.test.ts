import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AttemptRepositoryAdapter,
  LaneRun,
  LaneRunRepositoryAdapter,
  type AttemptRecord,
  type LaneRunRecord,
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

async function seedRunningAttempt(stateDir: string): Promise<void> {
  const record: AttemptRecord = {
    id: ATTEMPT_ID,
    workOrderId: "wo-fc12d",
    kind: "initial",
    fixNumber: 0,
    priorAttemptId: null,
    worktreePath: stateDir,
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
  await new AttemptRepositoryAdapter({ stateDir }).saveAttempt(record);
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

  it("emits one authority event on requestLaneRunStop and keeps one line with the same eventId on idempotent retry", async () => {
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

    // The real idempotent retry: a fresh entryId against the same recorded
    // stop key answers `already-requested` and emits no second event.
    const retried = await work.requestLaneRunStop.requestLaneRunStop({
      ...request,
      entryId: RETRY_ENTRY_ID,
    });
    expect(retried.outcome).toBe("already-requested");
    const afterRetry = await readJournal(stateDir);
    expect(afterRetry).not.toBeNull();
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry![0]!["eventId"]).toBe(`stop:${RUN_ID}/stop@web`);

    // A byte-identical retry (same entryId) is refused at the run journal
    // and never writes a second line either.
    const sameEntryId = await work.requestLaneRunStop.requestLaneRunStop(request);
    expect(sameEntryId).toEqual({ outcome: "refused", reason: "journal-refused" });
    expect(await readJournal(stateDir)).toHaveLength(1);
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

    await expect(
      readFile(path.join(unusedDir, "authority-events.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
