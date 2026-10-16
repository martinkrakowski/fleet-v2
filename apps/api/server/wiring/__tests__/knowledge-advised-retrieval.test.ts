// Lane D5b tests: the API knowledge composition wires the ranking advice port
// (decision port plan, 2026-10-16) into ProposeBriefContextUseCase only.
//
// The jev provider is exercised against the owner-recorded fixture under
// packages/brief-knowledge: the stub fetch replays the recorded answers bound
// to the claims they scored (the recorded state hash covers the recorded
// candidate order; a different candidate order re-keys the same answers onto
// the same claims). No real network and no key material anywhere.
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRankingAdviceState,
  KnowledgeEntryRepositoryAdapter,
  type KnowledgeEntryRecord,
  type RankingAdviceDecisions,
} from "@fleet/brief-knowledge";

import {
  createConfiguredKnowledgeComposition,
  getKnowledgeComposition,
  type KnowledgeComposition,
} from "../knowledge/composition";
import { configureFleetApiRuntime } from "../runtime";

const FIXTURE_DIR = new URL(
  "../../../../../packages/brief-knowledge/src/infrastructure/adapters/__fixtures__/jev/",
  import.meta.url,
);
const FIXTURE_RESPONSE = JSON.parse(
  readFileSync(fileURLToPath(new URL("jev-score-response.json", FIXTURE_DIR)), "utf8"),
) as {
  model: string;
  answers: Record<string, { type: "score"; score: number; probabilities: Record<string, number>; confidence: number }>;
  usage: { input_tokens: number; output_tokens: number; cost: number };
  provider: string;
  id: string;
};

/** The claim the owner-recorded request scored as highly relevant (k0). */
const RECORDED_HIGH_CLAIM =
  "Date strings are parsed with parseISO; never use new Date(string).";
const RECORDED_LOW_CLAIM = "The README badge links to the CI workflow.";

const TASK_SUMMARY = "Update the README badge in src/utils/docs";
const PROJECT_ID = "proj-d5b";
const PATH_PREFIXES = ["src/utils"];

const JEV_DECISIONS: RankingAdviceDecisions = {
  provider: "jev",
  model: "typesafe/jev-1.14",
  keyFile: "/keys/jev.key",
  minConfidence: 0.5,
  monthlyBudgetUsd: 0.01,
  assumedCostPerCallUsd: 0.00002,
  acknowledgeProseLeavesHost: true,
};

function entry(
  id: string,
  claimText: string,
  pathPrefixes: readonly string[],
): KnowledgeEntryRecord {
  return {
    id,
    version: "1.0.0",
    projectId: PROJECT_ID,
    sourceAttemptId: "attempt-1",
    sourceCommitSha: "0".repeat(40),
    claimText,
    pathPrefixes,
    sharedAcrossProjects: false,
    disposition: "accepted",
    verification: "supported",
    checkerId: null,
    dispositionReason: null,
    supersededById: null,
    checks: [],
    reuses: [],
    revision: 1,
    createdAtIso: "2026-10-16T00:00:00.000Z",
    updatedAtIso: "2026-10-16T00:00:00.000Z",
  };
}

/**
 * Spy transport replaying the owner-recorded fixture. The recorded answers
 * belong to the claims they scored, so the replay binds them by claimText:
 * the recorded high answer goes to the same claim, everything else gets the
 * recorded irrelevant answer. Every call is recorded; the body never carries
 * key material.
 */
function replayFetch(): typeof fetch & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = JSON.parse(String(init?.body ?? "{}")) as { state?: string };
    const state = JSON.parse(body.state ?? "{}") as {
      candidates?: Record<string, string>;
    };
    const answers: Record<string, unknown> = {};
    for (const [key, claim] of Object.entries(state.candidates ?? {})) {
      answers[key] =
        claim === RECORDED_HIGH_CLAIM ? FIXTURE_RESPONSE.answers.k0 : FIXTURE_RESPONSE.answers.k1;
    }
    return new Response(
      JSON.stringify({ ...FIXTURE_RESPONSE, answers }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch & { calls: unknown[] };
  fn.calls = calls;
  return fn;
}

const createdDirs = new Set<string>();

afterAll(async () => {
  await Promise.all(
    [...createdDirs].map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  // The runtime tests configure the module-level compositions; reset them so
  // no test inherits another's wiring.
  configureFleetApiRuntime(null);
});

async function makeTempStateDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "fleet-api-d5b-"));
  createdDirs.add(directory);
  return directory;
}

/** Two eligible keepers: the README claim leads lexically, the date claim trails. */
async function seedKeepers(repo: KnowledgeEntryRepositoryAdapter): Promise<void> {
  await repo.saveEntry(entry("entry-readme", RECORDED_LOW_CLAIM, PATH_PREFIXES));
  await repo.saveEntry(entry("entry-date", RECORDED_HIGH_CLAIM, PATH_PREFIXES));
}

function propose(composition: KnowledgeComposition): Promise<{
  outcome: string;
  proposals: readonly { proposalId: string; knowledgeEntryId: string; proposedBecause: string }[];
}> {
  return composition.proposeBriefContext.proposeBriefContext({
    projectId: PROJECT_ID,
    laneId: "lane-d5b",
    taskSummary: TASK_SUMMARY,
    pathPrefixes: PATH_PREFIXES,
  }) as Promise<{
    outcome: string;
    proposals: readonly { proposalId: string; knowledgeEntryId: string; proposedBecause: string }[];
  }>;
}

function monthReceiptPath(stateDir: string): string {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return path.join(stateDir, "decision-receipts", `${monthKey}.jsonl`);
}

describe("knowledge composition ranking advice wiring", () => {
  it("with no decisions block: same order as before and fetch is never called", async () => {
    const stateDir = await makeTempStateDir();
    await seedKeepers(new KnowledgeEntryRepositoryAdapter({ stateDir }));
    const fetch = replayFetch();
    const composition = createConfiguredKnowledgeComposition({ stateDir, fetch });
    const result = await propose(composition);
    expect(result.outcome).toBe("proposed");
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual(["entry-readme", "entry-date"]);
    expect(result.proposals.every((p) => !p.proposedBecause.includes("decision("))).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  it("with provider 'none': same order as before and fetch is never called", async () => {
    const stateDir = await makeTempStateDir();
    await seedKeepers(new KnowledgeEntryRepositoryAdapter({ stateDir }));
    const fetch = replayFetch();
    const composition = createConfiguredKnowledgeComposition({
      stateDir,
      decisions: { provider: "none" },
      fetch,
    });
    const result = await propose(composition);
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual(["entry-readme", "entry-date"]);
    expect(fetch.calls).toHaveLength(0);
  });

  it("with a jev block but no stateDir: fetch is never called", async () => {
    // The advice port only runs once two eligible keepers are ranked, so this
    // case seeds the same in-memory repository the composition wired (without
    // a stateDir there is no file-backed store to seed through).
    const repo = new KnowledgeEntryRepositoryAdapter();
    await seedKeepers(repo);
    const fetch = replayFetch();
    const readKeys: string[] = [];
    const composition = createConfiguredKnowledgeComposition({
      knowledgeEntryRepository: repo,
      decisions: JEV_DECISIONS,
      fetch,
      readKey: async (keyPath) => {
        readKeys.push(keyPath);
        return "stub-key-not-real";
      },
    });
    const result = await propose(composition);
    expect(result.outcome).toBe("proposed");
    // No durable receipt journal (invariant 5): the advice answers
    // unknown/not-configured and the deterministic lexical order stands.
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual(["entry-readme", "entry-date"]);
    expect(result.proposals.every((p) => !p.proposedBecause.includes("decision("))).toBe(true);
    // The provider pipeline never got as far as reading the key or fetching.
    expect(readKeys).toHaveLength(0);
    expect(fetch.calls).toHaveLength(0);
  });

  it("with a jev block, a stateDir and the recorded fixture: the keepers are reordered and receipted", async () => {
    const stateDir = await makeTempStateDir();
    await seedKeepers(new KnowledgeEntryRepositoryAdapter({ stateDir }));
    const fetch = replayFetch();
    const readKeys: string[] = [];
    const composition = createConfiguredKnowledgeComposition({
      stateDir,
      decisions: JEV_DECISIONS,
      fetch,
      readKey: async (keyPath) => {
        readKeys.push(keyPath);
        return "stub-key-not-real";
      },
    });
    const result = await propose(composition);
    expect(result.outcome).toBe("proposed");
    // The recorded judgement (the date claim is highly relevant) reorders the
    // deterministic set: the lexical runner-up leads.
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual(["entry-date", "entry-readme"]);
    expect(result.proposals[0]?.proposedBecause).toContain(
      `decision(${FIXTURE_RESPONSE.model}, c=0.91)`,
    );
    // The stub key reader saw exactly the configured keyFile path.
    expect(readKeys).toEqual([JEV_DECISIONS.keyFile]);
    expect(fetch.calls).toHaveLength(1);

    const raw = await readFile(monthReceiptPath(stateDir), "utf8");
    const lines = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.kind).toBe("reserved");
    expect(lines[1]?.kind).toBe("settled");
    expect(lines[1]?.provider).toBe("jev");
    expect(lines[1]?.lexicalOrder).toEqual(["entry-readme", "entry-date"]);
    expect(lines[1]?.decidedOrder).toEqual(["entry-date", "entry-readme"]);
  });

  it("with a v1 installation: lexical order through the configured runtime and fetch is never called", async () => {
    const stateDir = await makeTempStateDir();
    await seedKeepers(new KnowledgeEntryRepositoryAdapter({ stateDir }));
    const fetch = replayFetch();
    // The composition captures globalThis.fetch at configure time, so the
    // stub must be in place before the runtime is wired.
    vi.stubGlobal("fetch", fetch);
    // v1 files never carry a decisions block; the composition must not invent
    // one, so the advice port stays null and the lexical order stands.
    configureFleetApiRuntime({ stateDir, installation: { schemaVersion: 1 } });
    const result = await propose(getKnowledgeComposition());
    expect(result.outcome).toBe("proposed");
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual(["entry-readme", "entry-date"]);
    expect(result.proposals.every((p) => !p.proposedBecause.includes("decision("))).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  it("with a v2 installation answer-file decisions block: the keepers are reordered without network", async () => {
    const stateDir = await makeTempStateDir();
    await seedKeepers(new KnowledgeEntryRepositoryAdapter({ stateDir }));
    // The advice state is declared from the fields the inner (lexical) result
    // carries, in that order: the README claim is k0, the date claim k1. The
    // owner-recorded answer is keyed by the state digest it answers.
    const state = buildRankingAdviceState({
      taskSummary: TASK_SUMMARY,
      pathPrefixes: PATH_PREFIXES,
      candidates: [
        { id: "entry-readme", claimText: RECORDED_LOW_CLAIM },
        { id: "entry-date", claimText: RECORDED_HIGH_CLAIM },
      ],
    });
    if (!state.ok) {
      throw new Error("the recorded claims must build a decision state");
    }
    const answerFile = path.join(stateDir, "recorded-decision-answers.json");
    await writeFile(
      answerFile,
      JSON.stringify({
        [state.stateSha256]: {
          model: FIXTURE_RESPONSE.model,
          id: "gen-recorded-answer-file",
          answers: {
            // The lexical leader gets the recorded irrelevant answer, the
            // runner-up the recorded highly-relevant answer: exactly the
            // judgement the live fixture case asserts.
            k0: FIXTURE_RESPONSE.answers.k1,
            k1: FIXTURE_RESPONSE.answers.k0,
          },
        },
      }),
      "utf8",
    );
    const fetch = replayFetch();
    vi.stubGlobal("fetch", fetch);
    configureFleetApiRuntime({
      stateDir,
      installation: {
        schemaVersion: 2,
        hosts: {},
        forge: { mode: "none" },
        decisions: { provider: "answer-file", answerFile },
      },
    });
    const result = await propose(getKnowledgeComposition());
    expect(result.outcome).toBe("proposed");
    // The recorded judgement reorders the deterministic set, proving the
    // installation's decisions block reached the knowledge factory.
    expect(result.proposals.map((p) => p.knowledgeEntryId)).toEqual(["entry-date", "entry-readme"]);
    expect(result.proposals[0]?.proposedBecause).toContain(
      `decision(${FIXTURE_RESPONSE.model}, c=0.91)`,
    );
    // The answer-file provider reads only the recorded file: no network.
    expect(fetch.calls).toHaveLength(0);
  });
});
