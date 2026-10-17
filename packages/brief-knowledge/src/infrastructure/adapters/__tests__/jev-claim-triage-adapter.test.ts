// Lane K5b tests: JevClaimTriageAdapter with a fake journal and fake
// transport. No network: fetch is a stub or a spy, the key reader is a fake.
// Covers the plan §5 contract — one reservation per batch, flags keyed by
// candidate id, unknown means no flag, and a batch whose settlement fails
// never contributes advice.
import { describe, expect, it } from "vitest";
import {
  JevClaimTriageAdapter,
  TRIAGE_CLASS_OPTIONS,
  TRIAGE_REUSE_LEVELS,
} from "../JevClaimTriageAdapter.adapter.js";
import { buildTriageBatches, triageContextRef } from "../claim-triage-state.js";
import { CLAIM_TRIAGE_CONSUMER } from "../../../application/ports/out/DecisionReceiptJournalPort.out-port.js";
import type {
  DecisionCallReceipt,
  DecisionJournalSnapshot,
  DecisionReceiptJournalPort,
  ReadDecisionJournalQuery,
} from "../../../application/ports/out/DecisionReceiptJournalPort.out-port.js";
import type { TriageAttemptQuery } from "../../../application/ports/out/ClaimTriagePort.out-port.js";

const ATTEMPT = "attempt-42";
const QUERY: TriageAttemptQuery = {
  attemptId: ATTEMPT,
  pathPrefixes: ["src/utils"],
  candidates: [
    { id: "entry-a", claimText: "Date strings are parsed with parseISO." },
    { id: "entry-b", claimText: "The gate must pass before pushing." },
  ],
};

/** A `choice` answer body for one question key. */
function choiceAnswer(
  choice: string,
  confidence: number,
  probabilities?: Record<string, number>,
): unknown {
  return {
    type: "choice",
    choice,
    probabilities: probabilities ?? {
      lesson: choice === "lesson" ? 0.99 : 0,
      policy_proposal: choice === "policy_proposal" ? 0.99 : 0,
      instruction: choice === "instruction" ? 0.99 : 0,
      status_noise: choice === "status_noise" ? 0.99 : 0,
    },
    confidence,
  };
}

/** A `score` answer body for one question key (mostly reusable). */
function scoreAnswer(
  confidence: number,
  probabilities?: Record<string, number>,
): unknown {
  return {
    type: "score",
    probabilities: probabilities ?? { 0: 0, 1: 0, 2: 0.1, 3: 0.9 },
    confidence,
  };
}

/** Response body for the two-candidate QUERY: both entries advised. */
function advisedBody(): unknown {
  return {
    model: "typesafe/jev-1.14-20261014",
    answers: {
      k0: choiceAnswer("lesson", 0.8),
      "k0-reuse": scoreAnswer(0.8),
      k1: choiceAnswer("policy_proposal", 0.9),
      "k1-reuse": scoreAnswer(0.9, { 0: 0.7, 1: 0.1, 2: 0.1, 3: 0.1 }),
    },
    usage: { input_tokens: 10, output_tokens: 10, cost: 0.001 },
    id: "gen-triage-1",
    provider: "TypeSafe",
  };
}

/** Build a Response from a body with a real stream body, like Node's fetch. */
function makeResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: init?.headers ?? { "content-type": "application/json" },
  });
}

interface RecordedReserve {
  readonly consumer?: string;
  readonly stateSha256: string;
  readonly assumedCostUsd: number;
}
interface RecordedSettle {
  readonly reservationId: string;
  readonly receipt: DecisionCallReceipt;
}

/** The journal's shape, recorded in memory; every method can be made to throw. */
class FakeJournal implements DecisionReceiptJournalPort {
  readonly reserves: RecordedReserve[] = [];
  readonly settles: RecordedSettle[] = [];
  reserveResult: "ok" | "budget-exhausted" | "not-configured" | "throw" = "ok";

  async reserve(query: {
    consumer?: string;
    stateSha256: string;
    assumedCostUsd: number;
  }): Promise<
    | { ok: true; reservationId: string }
    | { ok: false; reason: "budget-exhausted" | "not-configured" }
  > {
    if (this.reserveResult === "throw") {
      throw new Error("journal unavailable");
    }
    this.reserves.push({
      consumer: query.consumer,
      stateSha256: query.stateSha256,
      assumedCostUsd: query.assumedCostUsd,
    });
    if (this.reserveResult === "ok") {
      return { ok: true, reservationId: `res-${this.reserves.length}` };
    }
    return { ok: false, reason: this.reserveResult };
  }

  async settle(
    reservationId: string,
    receipt: DecisionCallReceipt,
  ): Promise<void> {
    this.settles.push({ reservationId, receipt });
  }

  async monthSpendUsd(): Promise<number> {
    return 0;
  }

  async appendOutcome(): Promise<void> {
    return undefined;
  }

  async readJournal(
    _query: ReadDecisionJournalQuery,
  ): Promise<DecisionJournalSnapshot> {
    return { receipts: [], outcomes: [], skippedLines: 0 };
  }
}

interface RecordedCall {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

function fetchAnswering(
  bodies: readonly unknown[],
  calls: RecordedCall[],
): typeof fetch {
  let index = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      authorization: headers.authorization,
      body: typeof init?.body === "string" ? init.body : "",
    });
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return makeResponse(body);
  }) as typeof fetch;
}

function makeAdapter(
  overrides?: Partial<{
    fetch: typeof fetch;
    journal: DecisionReceiptJournalPort;
    minConfidence: number;
    timeoutMs: number;
  }>,
): {
  adapter: JevClaimTriageAdapter;
  journal: FakeJournal;
  calls: RecordedCall[];
} {
  const journal = new FakeJournal();
  const calls: RecordedCall[] = [];
  const adapter = new JevClaimTriageAdapter({
    model: "typesafe/jev-1.14",
    keyFile: "/tmp/jev-key",
    minConfidence: 0.5,
    journal: overrides?.journal ?? journal,
    assumedCostUsd: 0.002,
    monthlyBudgetUsd: 100,
    fetch: overrides?.fetch ?? fetchAnswering([advisedBody()], calls),
    readKey: async () => "test-key",
    ...(overrides?.minConfidence !== undefined
      ? { minConfidence: overrides.minConfidence }
      : {}),
    ...(overrides?.timeoutMs !== undefined
      ? { timeoutMs: overrides.timeoutMs }
      : {}),
  });
  return { adapter, journal, calls };
}

describe("JevClaimTriageAdapter", () => {
  it("maps advised answers to flags and scores keyed by candidate id", async () => {
    const { adapter } = makeAdapter();
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice.status).toBe("advised");
    if (advice.status !== "advised") return;
    expect(advice.contextRef).toBe(triageContextRef(ATTEMPT));
    // entry-a chose lesson (no flag); entry-b chose policy_proposal at
    // 0.9 ≥ 0.5 (flag) — flags are by candidate id, not by question key.
    expect(advice.flags).toEqual({ "entry-b": "policy-like" });
    // Reuse scores are expectations over 4 levels: k0 → (0.1·2 + 0.9·3)/3 ≈
    // 0.9667; k1 → (0.1·1 + 0.1·2 + 0.1·3)/3 = 0.2.
    expect(advice.scores["entry-a"]).toBeCloseTo(2.9 / 3, 10);
    expect(advice.scores["entry-b"]).toBeCloseTo(0.2, 10);
  });

  it("maps instruction and never flags lesson or status_noise", async () => {
    const body = advisedBody();
    const mutated = body as {
      answers: Record<string, unknown>;
    };
    mutated.answers.k0 = choiceAnswer("instruction", 0.7);
    mutated.answers.k1 = choiceAnswer("status_noise", 0.99);
    const { adapter } = makeAdapter({ fetch: fetchAnswering([body], []) });
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice.status).toBe("advised");
    if (advice.status !== "advised") return;
    expect(advice.flags).toEqual({ "entry-a": "instruction-like" });
  });

  it("asks one choice and one score question per candidate in the sent state", async () => {
    const calls: RecordedCall[] = [];
    const { adapter } = makeAdapter({
      fetch: fetchAnswering([advisedBody()], calls),
    });
    await adapter.triageAttempt(QUERY);
    expect(calls.length).toBe(1);
    const sent = JSON.parse(calls[0].body) as {
      model: string;
      state: string;
      questions: Record<string, { type: string }>;
    };
    expect(sent.model).toBe("typesafe/jev-1.14");
    const state = JSON.parse(sent.state) as {
      claims: Record<string, string>;
      pathPrefixes: string[];
    };
    expect(Object.keys(state.claims)).toEqual(["k0", "k1"]);
    expect(state.pathPrefixes).toEqual(["src/utils"]);
    expect(Object.keys(sent.questions).sort()).toEqual([
      "k0",
      "k0-reuse",
      "k1",
      "k1-reuse",
    ]);
    expect(sent.questions.k0.type).toBe("choice");
    expect(sent.questions["k0-reuse"].type).toBe("score");
    const choiceQ = sent.questions.k0 as unknown as {
      criteria: Record<string, string>;
    };
    expect(choiceQ.criteria).toEqual(TRIAGE_CLASS_OPTIONS);
    const scoreQ = sent.questions["k0-reuse"] as unknown as {
      levels: readonly string[];
    };
    expect(scoreQ.levels).toEqual(TRIAGE_REUSE_LEVELS);
    // The authorization header carries the key; it is never in the body.
    expect(calls[0].authorization).toBe("Bearer test-key");
    expect(calls[0].body).not.toContain("test-key");
  });

  it("reserves and settles once per batch under the shared triage contextRef", async () => {
    const { adapter, journal, calls } = makeAdapter();
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice.status).toBe("advised");
    expect(calls.length).toBe(1);
    expect(journal.reserves.length).toBe(1);
    expect(journal.reserves[0].consumer).toBe(CLAIM_TRIAGE_CONSUMER);
    expect(journal.settles.length).toBe(1);
    const receipt = journal.settles[0].receipt;
    expect(receipt.consumer).toBe(CLAIM_TRIAGE_CONSUMER);
    expect(receipt.contextRef).toBe(triageContextRef(ATTEMPT));
    expect(receipt.model).toBe("typesafe/jev-1.14-20261014");
    expect(receipt.requestId).toBe("gen-triage-1");
    expect(receipt.costUsd).toBe(0.001);
    expect(receipt.questionKinds).toEqual(["choice", "score"]);
    expect(receipt.lexicalOrder).toEqual([]);
    expect(receipt.decidedOrder).toEqual([]);
    expect(receipt.unknownReason).toBeUndefined();
  });

  it("advises nothing and sends nothing when no candidate is usable", async () => {
    const calls: RecordedCall[] = [];
    const { adapter, journal } = makeAdapter({
      fetch: fetchAnswering([advisedBody()], calls),
    });
    const advice = await adapter.triageAttempt({
      ...QUERY,
      candidates: [
        {
          id: "entry-secret",
          claimText:
            "The token is sk-abcdefghijklmnopqrstuvwx and must not leave.",
        },
      ],
    });
    expect(calls.length).toBe(0);
    expect(journal.reserves.length).toBe(0);
    // Nothing was paid: no reservation, so the answer stays within the
    // unknown contract — no flag for the secret-shaped candidate either way.
    expect(advice.status === "unknown" || advice.status === "advised").toBe(
      true,
    );
    if (advice.status === "advised") {
      expect(advice.flags).toEqual({});
    }
  });

  it("refuses the whole attempt when the budget refuses the first batch", async () => {
    const calls: RecordedCall[] = [];
    const { adapter, journal } = makeAdapter({
      fetch: fetchAnswering([advisedBody()], calls),
    });
    journal.reserveResult = "budget-exhausted";
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "budget",
      contextRef: triageContextRef(ATTEMPT),
    });
    expect(calls.length).toBe(0);
    expect(journal.settles.length).toBe(0);
  });

  it("maps a throwing journal reserve to not-configured and sends nothing", async () => {
    const calls: RecordedCall[] = [];
    const { adapter } = makeAdapter({
      fetch: fetchAnswering([advisedBody()], calls),
    });
    const throwingJournal = new FakeJournal();
    throwingJournal.reserveResult = "throw";
    const adapterThrowing = makeAdapter({
      fetch: fetchAnswering([advisedBody()], calls),
      journal: throwingJournal,
    }).adapter;
    const advice = await adapterThrowing.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "not-configured",
      contextRef: triageContextRef(ATTEMPT),
    });
    expect(calls.length).toBe(0);
    void adapter;
  });

  it("uses no answer whose settlement failed, keeping the reservation counted", async () => {
    const calls: RecordedCall[] = [];
    const journal = new FakeJournal();
    journal.settle = async (_reservationId, _receipt) => {
      throw new Error("append failed");
    };
    const { adapter } = makeAdapter({
      fetch: fetchAnswering([advisedBody()], calls),
      journal,
    });
    const advice = await adapter.triageAttempt(QUERY);
    expect(calls.length).toBe(1);
    expect(advice).toEqual({
      status: "unknown",
      reason: "not-configured",
      contextRef: triageContextRef(ATTEMPT),
    });
  });

  it("reports unknown/shape when a batch body is malformed", async () => {
    const bad = {
      model: "typesafe/jev-1.14-20261014",
      answers: { k0: { type: "choice" } },
    };
    const { adapter, journal } = makeAdapter({
      fetch: fetchAnswering([bad], []),
    });
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "shape",
      contextRef: triageContextRef(ATTEMPT),
    });
    // The paid call is still settled, with an unknownReason.
    expect(journal.settles.length).toBe(1);
    expect(journal.settles[0].receipt.unknownReason).toBe("shape");
  });

  it("reports unknown/shape when the JSON is unparsable", async () => {
    const { adapter } = makeAdapter({
      fetch: fetchAnswering(["not json at all"], []),
    });
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "shape",
      contextRef: triageContextRef(ATTEMPT),
    });
  });

  it("reports unknown/shape when the body exceeds the 64 KiB cap", async () => {
    const big = "x".repeat(70000);
    const { adapter } = makeAdapter({ fetch: fetchAnswering([big], []) });
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "shape",
      contextRef: triageContextRef(ATTEMPT),
    });
  });

  it("reports unknown/transport on an HTTP failure without reading the body", async () => {
    const { adapter } = makeAdapter({
      fetch: (async () =>
        makeResponse("server error", { status: 500 })) as typeof fetch,
    });
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "transport",
      contextRef: triageContextRef(ATTEMPT),
    });
  });

  it("reports unknown/timeout when the deadline aborts the request", async () => {
    const slowFetch: typeof fetch = (async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }
      });
    }) as typeof fetch;
    const { adapter } = makeAdapter({ fetch: slowFetch, timeoutMs: 20 });
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "timeout",
      contextRef: triageContextRef(ATTEMPT),
    });
  });

  it("reports unknown/transport when fetch itself throws", async () => {
    const { adapter } = makeAdapter({
      fetch: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "transport",
      contextRef: triageContextRef(ATTEMPT),
    });
  });

  it("stops after a batch that fails and never reserves the later batches", async () => {
    // 200 claims of ~200 bytes ≈ 40 KiB → 2 batches; the first fails with an
    // HTTP error, so the second is never reserved (spend only grows).
    const claims = Array.from({ length: 200 }, (_, index) => ({
      id: `entry-${index}`,
      claimText:
        `Claim ${index} padded to about two hundred bytes of reusable lesson text for the batch cap.`.padEnd(
          200,
          "x",
        ),
    }));
    const { adapter, journal } = makeAdapter({
      fetch: (async () =>
        makeResponse("bad gateway", { status: 502 })) as typeof fetch,
    });
    const advice = await adapter.triageAttempt({
      ...QUERY,
      candidates: claims,
    });
    expect(advice.status).toBe("unknown");
    expect(journal.reserves.length).toBe(1);
    // The failed call is still settled as estimated, with its transport
    // reason — a reservation is never left pending.
    expect(journal.settles.length).toBe(1);
    expect(journal.settles[0].receipt.unknownReason).toBe("transport");
  });

  it("keeps no flag when the confidence gate refuses every answer", async () => {
    const body = advisedBody() as { answers: Record<string, unknown> };
    body.answers.k0 = choiceAnswer("lesson", 0.2);
    body.answers["k0-reuse"] = scoreAnswer(0.2);
    body.answers.k1 = choiceAnswer("policy_proposal", 0.3);
    body.answers["k1-reuse"] = scoreAnswer(0.3);
    const { adapter } = makeAdapter({
      fetch: fetchAnswering([body], []),
      minConfidence: 0.5,
    });
    const advice = await adapter.triageAttempt(QUERY);
    expect(advice).toEqual({
      status: "unknown",
      reason: "low-confidence",
      contextRef: triageContextRef(ATTEMPT),
    });
  });

  it("builds batches from the shared builder and maps ids back per batch", async () => {
    // Five claims of 8000 bytes ≈ 40 KiB total → 2 batches (4 + 1) under the
    // caps; every claim stays inside the 8 KiB field cap.
    const bigClaim = (letter: string): string => letter.repeat(8000);
    const candidates = [
      { id: "entry-a", claimText: bigClaim("A") },
      { id: "entry-b", claimText: bigClaim("B") },
      { id: "entry-c", claimText: bigClaim("C") },
      { id: "entry-d", claimText: bigClaim("D") },
      { id: "entry-e", claimText: bigClaim("E") },
    ];
    const built = buildTriageBatches(QUERY.pathPrefixes, candidates);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.batches.length).toBe(2);
    const calls: RecordedCall[] = [];
    const { adapter, journal } = makeAdapter({
      fetch: fetchAnswering([advisedBody(), advisedBody()], calls),
    });
    const advice = await adapter.triageAttempt({ ...QUERY, candidates });
    // The fixture body answers only k0 and k1, so batch 2's k0 (entry-e)
    // classifies as lesson and batch 1's k0/k1 map to entry-a/entry-b —
    // the advice is partial but well-formed: entry-b keeps its flag, and
    // batch 2's k0 score maps to entry-e, not to entry-a.
    expect(advice.status).toBe("advised");
    if (advice.status !== "advised") return;
    expect(advice.flags).toEqual({ "entry-b": "policy-like" });
    expect(advice.scores["entry-b"]).toBeCloseTo(0.2, 10);
    expect(advice.scores["entry-e"]).toBeCloseTo(2.9 / 3, 10);
    expect(calls.length).toBe(2);
    expect(journal.reserves.length).toBe(2);
    expect(journal.settles.length).toBe(2);
    // The question keys restart per batch: k0 in batch 2 is entry-e, not entry-a.
    const second = JSON.parse(calls[1].body as string) as { state: string };
    const secondState = JSON.parse(second.state) as {
      claims: Record<string, string>;
    };
    expect(Object.keys(secondState.claims)).toEqual(["k0"]);
    expect(secondState.claims.k0).toBe(bigClaim("E"));
    const first = JSON.parse(calls[0].body as string) as { state: string };
    const firstState = JSON.parse(first.state) as {
      claims: Record<string, string>;
    };
    expect(Object.keys(firstState.claims)).toEqual(["k0", "k1", "k2", "k3"]);
    expect(firstState.claims.k3).toBe(bigClaim("D"));
  });
});
