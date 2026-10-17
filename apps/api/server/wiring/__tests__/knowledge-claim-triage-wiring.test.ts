// Lane K6 tests: the API knowledge composition wires the claim-triage port
// (decision-kernel plan, 2026-10-16, §5) into CaptureCompletedAttemptNotesUseCase.
//
// Triage stays off unless the installation's v2 decisions block is enabled, a
// key source is declared and the claim-triage consumer carries its own
// `acknowledgeCandidateClaimsLeaveHost: true` acknowledgement. No real
// network and no key material anywhere: the key reader is a stub and the key
// never enters logs.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { DecisionsSectionV2 } from "@fleet/installation";

import {
  createConfiguredKnowledgeComposition,
  type KnowledgeComposition,
} from "../knowledge/composition";

const FIXTURE_DIR = new URL(
  "../../../../../packages/brief-knowledge/src/infrastructure/adapters/__fixtures__/jev/",
  import.meta.url,
);

/** Proves the fixture dir resolves; the shape of the answers is irrelevant. */
readFileSync(
  fileURLToPath(new URL("jev-score-response.json", FIXTURE_DIR)),
  "utf8",
);

const PROJECT_ID = "proj-k6";

const NOTES_REQUEST = {
  projectId: PROJECT_ID,
  attemptId: "att-k6-1",
  workOrderId: "wo-k6-1",
  headCommitSha: "def5678",
  notesMarkdown:
    "- The API root wires claim triage behind the acknowledgement\n",
};

/**
 * A spy transport recording every call. The response body is irrelevant: the
 * triage port never throws, and this suite asserts on the requests made, not
 * on the advice they produce. The body never carries key material.
 */
function spyFetch(): typeof fetch & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

const JEV_BASE = {
  provider: "jev",
  model: "typesafe/jev-1.14",
  keyFile: "/keys/jev.key",
  minConfidence: 0.5,
  monthlyBudgetUsd: 0.01,
  assumedCostPerCallUsd: 0.00002,
  acknowledgeProseLeavesHost: true,
} as const;

/** Jev enabled, but no claim-triage consumer entry at all. */
const JEV_WITH_UNACKNOWLEDGED_TRIAGE = {
  ...JEV_BASE,
  consumers: {
    "claim-triage": {},
  },
} as unknown as DecisionsSectionV2;

/** Jev enabled with the claim-triage consumer acknowledged: triage is wired. */
const JEV_WITH_ACKNOWLEDGED_TRIAGE: DecisionsSectionV2 = {
  ...JEV_BASE,
  consumers: {
    "claim-triage": { acknowledgeCandidateClaimsLeaveHost: true },
  },
};

/** Jev enabled and acknowledged, but the key is not readable: no request. */
const JEV_WITH_UNREADABLE_KEY: DecisionsSectionV2 = {
  ...JEV_BASE,
  consumers: {
    "claim-triage": { acknowledgeCandidateClaimsLeaveHost: true },
  },
};

async function capture(
  composition: KnowledgeComposition,
): Promise<{ outcome: string }> {
  const result =
    await composition.captureCompletedAttemptNotes.captureCompletedAttemptNotes(
      NOTES_REQUEST,
    );
  return { outcome: result.outcome };
}

/** The post-capture triage hook is started, not awaited: give it a beat. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

function monthReceiptPath(stateDir: string): string {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return path.join(stateDir, "decision-receipts", `${monthKey}.jsonl`);
}

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeTempStateDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-api-k6-"));
  createdDirs.add(directory);
  return directory;
}

describe("knowledge composition claim triage wiring", () => {
  it("with no acknowledgement the capture use case gets no triage and no network", async () => {
    const stateDir = await makeTempStateDir();
    const fetch = spyFetch();
    const composition = createConfiguredKnowledgeComposition({
      stateDir,
      decisions: JEV_WITH_UNACKNOWLEDGED_TRIAGE,
      fetch,
      readKey: async () => "stub-key-not-real",
    });
    expect((await capture(composition)).outcome).toBe("captured");
    await settle();
    expect(fetch.calls).toHaveLength(0);
    await expect(readFile(monthReceiptPath(stateDir), "utf8")).rejects.toThrow(
      "ENOENT",
    );
  });

  it("with everything set and an injected fetch a capture triggers exactly one triage request", async () => {
    const stateDir = await makeTempStateDir();
    const fetch = spyFetch();
    const readKeys: string[] = [];
    const composition = createConfiguredKnowledgeComposition({
      stateDir,
      decisions: JEV_WITH_ACKNOWLEDGED_TRIAGE,
      fetch,
      readKey: async (keyPath) => {
        readKeys.push(keyPath);
        return "stub-key-not-real";
      },
    });
    expect((await capture(composition)).outcome).toBe("captured");
    await settle();
    // One candidate, one batch, one reservation: exactly one request.
    expect(fetch.calls).toHaveLength(1);
    // The stub key reader saw exactly the configured keyFile path.
    expect(readKeys).toEqual([JEV_BASE.keyFile]);
    // The request was receipted in the same journal the ranking advice uses.
    const raw = await readFile(monthReceiptPath(stateDir), "utf8");
    const lines = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.some((line) => line.kind === "reserved")).toBe(true);
  });

  it("with no key there is no triage request and no network", async () => {
    const stateDir = await makeTempStateDir();
    const fetch = spyFetch();
    const composition = createConfiguredKnowledgeComposition({
      stateDir,
      decisions: JEV_WITH_UNREADABLE_KEY,
      fetch,
      // The key cannot be read: the request is refused before any network.
      readKey: async () => {
        throw new Error("no key material");
      },
    });
    expect((await capture(composition)).outcome).toBe("captured");
    await settle();
    expect(fetch.calls).toHaveLength(0);
  });
});
