// Lane K5b tests: the post-capture triage hook in CaptureCompletedAttemptNotesUseCase.
// The triage port and the repository are fakes; no network, no kernel. Covers
// the plan §5 hook contract — triage runs once per capture, after the
// candidates are stored; a flag is written per advised candidate through the
// repository's write-once setTriageFlag; an unknown answer writes no flag; a
// candidate that gained a disposition between capture and the flag write is
// skipped; dispositions are never changed by the hook; and a triage failure
// never delays, fails or changes the capture result.
import { describe, expect, it } from "vitest";
import type { ContextSelectionProps } from "../../domain/value-objects/ContextSelection.vo.js";
import type {
  KnowledgeEntryRecord,
  KnowledgeTriageFlag,
} from "../../domain/knowledge-records.js";
import type { KnowledgeEntryRepositoryPort } from "../ports/out/KnowledgeEntryRepositoryPort.out-port.js";
import type {
  ClaimTriageAdvice,
  ClaimTriagePort,
  TriageAttemptQuery,
} from "../ports/out/ClaimTriagePort.out-port.js";
import { CaptureCompletedAttemptNotesUseCase } from "./CaptureCompletedAttemptNotesUseCase.use-case.js";

class RecordingKnowledgeEntryRepository implements KnowledgeEntryRepositoryPort {
  private readonly entries = new Map<string, KnowledgeEntryRecord>();
  readonly flagWrites: Array<{ entryId: string; flag: KnowledgeTriageFlag }> =
    [];

  async saveEntry(record: KnowledgeEntryRecord): Promise<void> {
    this.entries.set(record.id, { ...record });
  }

  async findEntryById(entryId: string): Promise<KnowledgeEntryRecord | null> {
    const entry = this.entries.get(entryId);
    return entry ? { ...entry } : null;
  }

  async listEntriesByProject(
    projectId?: string,
  ): Promise<readonly KnowledgeEntryRecord[]> {
    const all = Array.from(this.entries.values());
    if (!projectId) return all;
    return all.filter((entry) => entry.projectId === projectId);
  }

  async listEntriesBySourceAttempt(
    attemptId: string,
  ): Promise<readonly KnowledgeEntryRecord[]> {
    return [...this.entries.values()].filter(
      (entry) => entry.sourceAttemptId === attemptId,
    );
  }

  async setTriageFlag(
    entryId: string,
    flag: KnowledgeTriageFlag,
  ): Promise<void> {
    this.flagWrites.push({ entryId, flag });
  }

  async saveContextSelections(
    _attemptId: string,
    _selections: readonly ContextSelectionProps[],
  ): Promise<void> {}

  async listContextSelections(
    _attemptId: string,
  ): Promise<readonly ContextSelectionProps[]> {
    return [];
  }
}

/** Fake triage port: configurable advice, records every query. */
class FakeTriagePort implements ClaimTriagePort {
  readonly queries: TriageAttemptQuery[] = [];
  constructor(private readonly answer: () => Promise<ClaimTriageAdvice>) {}

  async triageAttempt(query: TriageAttemptQuery): Promise<ClaimTriageAdvice> {
    this.queries.push(query);
    return this.answer();
  }
}

const BASE_REQUEST = {
  projectId: "proj-1",
  attemptId: "att-1",
  workOrderId: "wo-1",
  headCommitSha: "a1b2c3d",
  notesMarkdown: "- First lesson\n- Second instruction\n- Third status note",
};

/** A promise that resolves when the background triage of one capture settles. */
function triageSettled(): { promise: Promise<void>; onTriageSettled: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, onTriageSettled: () => resolve() };
}

/** Capture once and return the use case, repo and captured entries. */
async function captureWith(triage?: ClaimTriagePort): Promise<{
  repo: RecordingKnowledgeEntryRepository;
  entries: readonly KnowledgeEntryRecord[];
}> {
  const repo = new RecordingKnowledgeEntryRepository();
  const settled = triageSettled();
  const useCase = new CaptureCompletedAttemptNotesUseCase({
    repo,
    ...(triage ? { triage, onTriageSettled: settled.onTriageSettled } : {}),
  });
  const result = await useCase.execute(BASE_REQUEST);
  if (triage) await settled.promise;
  if (result.outcome !== "captured") {
    throw new Error(
      `expected captured outcome, got: ${JSON.stringify(result)}`,
    );
  }
  return { repo, entries: result.candidateEntries };
}

describe("CaptureCompletedAttemptNotesUseCase post-capture triage hook", () => {
  it("runs triage once per capture with every captured candidate", async () => {
    const triage = new FakeTriagePort(async () => ({
      status: "advised",
      contextRef: "triage:att-1",
      flags: {},
      scores: {},
    }));
    await captureWith(triage);
    expect(triage.queries.length).toBe(1);
    const query = triage.queries[0];
    expect(query.attemptId).toBe("att-1");
    expect(query.candidates.map((candidate) => candidate.id)).toEqual([
      "ke-att-1-1",
      "ke-att-1-2",
      "ke-att-1-3",
    ]);
    expect(query.candidates.length).toBe(3);
  });

  it("writes one flag per advised candidate through the repository", async () => {
    const triage = new FakeTriagePort(async () => ({
      status: "advised",
      contextRef: "triage:att-1",
      flags: { "ke-att-1-1": "policy-like", "ke-att-1-2": "instruction-like" },
      scores: {},
    }));
    const { repo } = await captureWith(triage);
    expect(repo.flagWrites.length).toBe(2);
    expect(repo.flagWrites).toContainEqual({
      entryId: "ke-att-1-1",
      flag: "policy-like",
    });
    expect(repo.flagWrites).toContainEqual({
      entryId: "ke-att-1-2",
      flag: "instruction-like",
    });
  });

  it("writes no flag when triage answers unknown", async () => {
    const triage = new FakeTriagePort(async () => ({
      status: "unknown",
      reason: "transport",
      contextRef: "triage:att-1",
    }));
    const { repo } = await captureWith(triage);
    expect(repo.flagWrites.length).toBe(0);
  });

  it("skips a candidate that gained a disposition before the flag write", async () => {
    const repo = new RecordingKnowledgeEntryRepository();
    // The fake triage accepts a disposition between capture and the write:
    // entry att-1-2 is disposed while triage runs, so its flag must be
    // skipped and its disposition left exactly as the other writer set it.
    const triage = new FakeTriagePort(async () => {
      const disposed = await repo.findEntryById("ke-att-1-2");
      if (disposed) {
        await repo.saveEntry({ ...disposed, disposition: "accepted" });
      }
      return {
        status: "advised",
        contextRef: "triage:att-1",
        flags: {
          "ke-att-1-1": "policy-like",
          "ke-att-1-2": "instruction-like",
        },
        scores: {},
      };
    });
    const settled = triageSettled();
    const useCase = new CaptureCompletedAttemptNotesUseCase({
      repo,
      triage,
      onTriageSettled: settled.onTriageSettled,
    });
    const result = await useCase.execute(BASE_REQUEST);
    await settled.promise;
    expect(result.outcome).toBe("captured");
    // Only the still-undecided candidate got its flag.
    expect(repo.flagWrites).toEqual([
      { entryId: "ke-att-1-1", flag: "policy-like" },
    ]);
    // The disposed entry is untouched by the hook.
    const after = await repo.findEntryById("ke-att-1-2");
    expect(after?.disposition).toBe("accepted");
    expect(after?.triageFlag).toBeUndefined();
  });

  it("never changes a disposition and never fails capture when triage throws", async () => {
    const triage = new FakeTriagePort(async () => {
      throw new Error("triage transport exploded");
    });
    const { repo, entries } = await captureWith(triage);
    expect(entries.length).toBe(3);
    expect(repo.flagWrites.length).toBe(0);
    for (const entry of entries) {
      const stored = await repo.findEntryById(entry.id);
      expect(stored?.disposition).toBe("candidate");
      expect(stored?.triageFlag).toBeUndefined();
    }
  });

  it("never changes a disposition when a flag write is refused", async () => {
    const repo = new RecordingKnowledgeEntryRepository();
    repo.setTriageFlag = async () => {
      throw new Error("repository refused the flag write");
    };
    const triage = new FakeTriagePort(async () => ({
      status: "advised",
      contextRef: "triage:att-1",
      flags: { "ke-att-1-1": "policy-like" },
      scores: {},
    }));
    const settled = triageSettled();
    const useCase = new CaptureCompletedAttemptNotesUseCase({
      repo,
      triage,
      onTriageSettled: settled.onTriageSettled,
    });
    const result = await useCase.execute(BASE_REQUEST);
    await settled.promise;
    expect(result.outcome).toBe("captured");
    const stored = await repo.findEntryById("ke-att-1-1");
    expect(stored?.disposition).toBe("candidate");
  });

  it("returns captured without waiting for a triage port that never answers", async () => {
    const repo = new RecordingKnowledgeEntryRepository();
    const triage = new FakeTriagePort(() => new Promise(() => undefined));
    const useCase = new CaptureCompletedAttemptNotesUseCase({ repo, triage });
    const result = await Promise.race([
      useCase.execute(BASE_REQUEST),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);
    expect(result).not.toBe("timed-out");
    if (result === "timed-out") return;
    expect(result.outcome).toBe("captured");
    expect(repo.flagWrites).toEqual([]);
  });

  it("captures unchanged without a triage port (triage disabled)", async () => {
    const { repo, entries } = await captureWith(undefined);
    expect(entries.length).toBe(3);
    expect(repo.flagWrites.length).toBe(0);
  });
});
