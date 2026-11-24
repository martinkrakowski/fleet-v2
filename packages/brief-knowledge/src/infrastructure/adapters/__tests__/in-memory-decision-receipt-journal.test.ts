// VB07: unit tests for InMemoryDecisionReceiptJournalAdapter. Every fixture
// here is synthetic; the secret-shaped literals are fabricated test strings
// that merely match a shape regex, never a real credential.
import { describe, expect, it } from "vitest";

import { InMemoryDecisionReceiptJournalAdapter } from "../InMemoryDecisionReceiptJournalAdapter.adapter.js";
import {
  CLAIM_TRIAGE_CONSUMER,
  KNOWLEDGE_RANKING_CONSUMER,
} from "../../../application/ports/out/DecisionReceiptJournalPort.out-port.js";
import type { AppendDecisionOutcome, DecisionCallReceipt } from "../../../application/ports/out/DecisionReceiptJournalPort.out-port.js";
import { budgetAllows } from "@fleet/shared";

/** Synthetic credential-shaped strings; clearly marked, never real. */
const SYNTHETIC_OPENAI_SHAPE = "sk-synthetic-test-only-key-000000";
const SYNTHETIC_GITHUB_SHAPE = "ghp_syntheticTestOnlyToken0000000000";

/** Deterministic clock handle the tests drive across the month boundary. */
let now = new Date("2026-10-31T23:59:59.000Z");
const advanceTo = (iso: string): void => {
  now = new Date(iso);
};

/** A valid 64-char lowercase hex digest (all zeros is fine for tests). */
const SHA = "0".repeat(64);
/** Same length but uppercase — refused by the pattern. */
const UPPER_SHA = "a".repeat(64).toUpperCase();

const makeAdapter = (): InMemoryDecisionReceiptJournalAdapter =>
  new InMemoryDecisionReceiptJournalAdapter(() => now);

interface ReserveOverrides {
  readonly consumer?: string | undefined;
  readonly assumedCostUsd?: number;
  readonly monthlyBudgetUsd?: number;
  readonly consumerBudgetUsd?: number | undefined;
  readonly stateSha256?: string;
}

const reserveQuery = (overrides: ReserveOverrides = {}) => ({
  consumer: KNOWLEDGE_RANKING_CONSUMER,
  assumedCostUsd: 0.01,
  monthlyBudgetUsd: 1,
  consumerBudgetUsd: undefined,
  stateSha256: SHA,
  ...overrides,
});

const receipt = (overrides: Record<string, unknown> = {}): DecisionCallReceipt =>
  ({
  consumer: KNOWLEDGE_RANKING_CONSUMER,
  contextRef: "ctx-0001",
  provider: "synthetic-provider",
  model: "synthetic-model",
  questionKinds: ["grounding"],
  latencyMs: 12,
  lexicalOrder: ["entry-a", "entry-b"],
  decidedOrder: ["entry-b", "entry-a"],
  ...overrides,
  }) as unknown as DecisionCallReceipt;

const outcome = (overrides: Record<string, unknown> = {}): AppendDecisionOutcome => ({
  consumer: KNOWLEDGE_RANKING_CONSUMER,
  contextRef: "ctx-0001",
  kind: "ranking-selection",
  value: ["entry-b"],
  at: "2026-10-31T23:59:59.000Z",
  ...overrides,
}) as unknown as AppendDecisionOutcome;

const reserveOk = async (
  adapter: InMemoryDecisionReceiptJournalAdapter,
  overrides: ReserveOverrides = {},
): Promise<string> => {
  const result = await adapter.reserve(reserveQuery(overrides));
  if (!result.ok) {
    throw new Error("fixture reserve unexpectedly refused");
  }
  return result.reservationId;
};

const settleReceipt = async (
  adapter: InMemoryDecisionReceiptJournalAdapter,
  contextRef: string,
  receiptOverrides: Record<string, unknown> = {},
): Promise<string> => {
  const reservationId = await reserveOk(adapter);
  await adapter.settle(reservationId, receipt({ contextRef, ...receiptOverrides }));
  return reservationId;
};

describe("InMemoryDecisionReceiptJournalAdapter", () => {
  // ------------------------------------------------------------------
  // 1. Budget cap & UTC month rollover
  // ------------------------------------------------------------------
  describe("budget cap and UTC month rollover", () => {
    it("reserves while the assumed cost keeps spend below the monthly and consumer budgets, matching budgetAllows as the oracle", async () => {
      const adapter = makeAdapter();
      const query = reserveQuery({
        assumedCostUsd: 0.05,
        monthlyBudgetUsd: 1,
        consumerBudgetUsd: 0.2,
      });
      const oracle = budgetAllows({
        consumerSpend: 0,
        consumerBudget: 0.2,
        totalSpend: 0,
        totalBudget: 1,
        assumedCost: 0.05,
      });
      const result = await adapter.reserve(query);
      expect(oracle).toEqual({ ok: true });
      expect(result).toEqual({ ok: true, reservationId: expect.any(String) });
      expect(await adapter.monthSpendUsd(new Date("2026-10-15T00:00:00Z"))).toBe(0.05);
    });

    it("reserves only up to the at-the-cap boundary the oracle draws, refusing once spend + assumed cost would reach the cap", async () => {
      const adapter = makeAdapter();
      // assumed 0.9, budget 1: 0 + 0.9 < 1, allowed.
      await expect(adapter.reserve(reserveQuery({ assumedCostUsd: 0.9 }))).resolves.toMatchObject({ ok: true });
      // assumed 0.1, spend 0.9: 0.9 + 0.1 >= 1, refused by the same rule.
      const oracle = budgetAllows({ consumerSpend: 0, totalSpend: 0.9, totalBudget: 1, assumedCost: 0.1 });
      expect(oracle).toEqual({ ok: false, reason: "total-budget" });
      await expect(adapter.reserve(reserveQuery({ assumedCostUsd: 0.1 }))).resolves.toEqual({
        ok: false,
        reason: "budget-exhausted",
      });
    });

    it("refuses with budget-exhausted at and above monthlyBudgetUsd", async () => {
      const adapter = makeAdapter();
      // First reserve + settle puts 0.5 on the month.
      const first = await reserveOk(adapter, { assumedCostUsd: 0.5 });
      await adapter.settle(first, receipt({ costUsd: 0.5 }));
      // At the cap: 0.5 + 0.5 >= 1.
      await expect(adapter.reserve(reserveQuery({ assumedCostUsd: 0.5 }))).resolves.toEqual({
        ok: false,
        reason: "budget-exhausted",
      });
      // Over the cap: 0.5 + 0.6 >= 1.
      await expect(adapter.reserve(reserveQuery({ assumedCostUsd: 0.6 }))).resolves.toEqual({
        ok: false,
        reason: "budget-exhausted",
      });
    });

    it("refuses with budget-exhausted at consumerBudgetUsd even when total budget remains", async () => {
      const adapter = makeAdapter();
      const first = await reserveOk(adapter, {
        assumedCostUsd: 0.4,
        consumerBudgetUsd: 0.5,
      });
      await adapter.settle(first, receipt({ costUsd: 0.4 }));
      // Total budget 1 still has room, but the consumer sub-budget 0.5 is reached.
      await expect(
        adapter.reserve(reserveQuery({ assumedCostUsd: 0.1, consumerBudgetUsd: 0.5 })),
      ).resolves.toEqual({ ok: false, reason: "budget-exhausted" });
      // A different consumer with the same sub-budget still has its own room.
      await expect(
        adapter.reserve(
          reserveQuery({ consumer: CLAIM_TRIAGE_CONSUMER, assumedCostUsd: 0.1, consumerBudgetUsd: 0.5 }),
        ),
      ).resolves.toMatchObject({ ok: true });
    });

    it("settling with a lower costUsd lowers monthSpendUsd and with a higher costUsd raises it", async () => {
      const adapter = makeAdapter();
      const lower = await reserveOk(adapter, { assumedCostUsd: 0.5 });
      await adapter.settle(lower, receipt({ costUsd: 0.2 }));
      expect(await adapter.monthSpendUsd(now)).toBe(0.2);
      const higher = await reserveOk(adapter, { assumedCostUsd: 0.5 });
      await adapter.settle(higher, receipt({ costUsd: 0.7 }));
      expect(await adapter.monthSpendUsd(now)).toBeCloseTo(0.9, 12);
    });

    it("settling without costUsd keeps the assumed cost and marks the receipt estimated", async () => {
      const adapter = makeAdapter();
      const id = await reserveOk(adapter, { assumedCostUsd: 0.3 });
      await adapter.settle(id, receipt({ contextRef: "ctx-est" }));
      expect(await adapter.monthSpendUsd(now)).toBe(0.3);
      const snapshot = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      expect(snapshot.receipts).toHaveLength(1);
      expect(snapshot.receipts[0]?.costUsd).toBe(0.3);
      expect(snapshot.receipts[0]?.estimated).toBe(true);
    });

    it("driving the clock past the UTC month boundary resets available spend to 0 for 2026-11 while 2026-10 spend stays readable", async () => {
      const adapter = makeAdapter();
      const id = await reserveOk(adapter, { assumedCostUsd: 0.6 });
      await adapter.settle(id, receipt({ costUsd: 0.6 }));
      advanceTo("2026-11-01T00:00:00.000Z");
      // November starts empty.
      await expect(adapter.reserve(reserveQuery({ assumedCostUsd: 0.9, monthlyBudgetUsd: 1 }))).resolves.toMatchObject({ ok: true });
      // October's spend is still reported for an October date.
      expect(await adapter.monthSpendUsd(new Date("2026-10-15T00:00:00Z"))).toBe(0.6);
      expect(await adapter.monthSpendUsd(now)).toBe(0.9);
    });
  });

  // ------------------------------------------------------------------
  // 2. Once-only settle
  // ------------------------------------------------------------------
  describe("once-only settle", () => {
    it("settles a reservation once and readJournal returns the settled receipt stamped with the injected clock", async () => {
      const adapter = makeAdapter();
      const id = await reserveOk(adapter);
      advanceTo("2026-10-31T23:00:00.000Z");
      await adapter.settle(id, receipt());
      const snapshot = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      expect(snapshot.receipts).toHaveLength(1);
      const record = snapshot.receipts[0]!;
      expect(record.at).toBe("2026-10-31T23:00:00.000Z");
      expect(record.contextRef).toBe("ctx-0001");
      expect(record.lexicalOrder).toEqual(["entry-a", "entry-b"]);
      expect(record.decidedOrder).toEqual(["entry-b", "entry-a"]);
      expect(record.questionKinds).toEqual(["grounding"]);
      expect(record.estimated).toBe(true);
      expect(record.costUsd).toBe(0.01);
      expect(record.latencyMs).toBe(12);
      expect(snapshot.skippedLines).toBe(0);
    });

    it("refuses a second settle of the same reservationId without changing monthSpendUsd or duplicating the receipt", async () => {
      const adapter = makeAdapter();
      const id = await reserveOk(adapter, { assumedCostUsd: 0.2 });
      await adapter.settle(id, receipt({ costUsd: 0.2 }));
      const spend = await adapter.monthSpendUsd(now);
      await expect(adapter.settle(id, receipt({ costUsd: 0.9 }))).rejects.toThrow(
        /is already settled/,
      );
      expect(await adapter.monthSpendUsd(now)).toBe(spend);
      const snapshot = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      expect(snapshot.receipts).toHaveLength(1);
      expect(snapshot.receipts[0]?.costUsd).toBe(0.2);
    });

    it("refuses an unknown reservationId without changing monthSpendUsd", async () => {
      const adapter = makeAdapter();
      const spend = await adapter.monthSpendUsd(now);
      await expect(adapter.settle("no-such-reservation", receipt())).rejects.toThrow(
        /cannot settle unknown reservation/,
      );
      expect(await adapter.monthSpendUsd(now)).toBe(spend);
      const snapshot = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      expect(snapshot.receipts).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  // 3. Input screening
  // ------------------------------------------------------------------
  describe("input screening", () => {
    it("constructor refuses a non-function clock", () => {
      expect(
        () =>
          new InMemoryDecisionReceiptJournalAdapter(
            "2026-10-31" as unknown as () => Date,
          ),
      ).toThrow("InMemoryDecisionReceiptJournalAdapter requires a now() clock");
    });

    it("reserve refuses null, undefined, and non-object queries", async () => {
      const adapter = makeAdapter();
      for (const bad of [null, undefined, 42, "query", true]) {
        await expect(
          adapter.reserve(bad as unknown as Parameters<typeof adapter.reserve>[0]),
        ).rejects.toThrow(
          "InMemoryDecisionReceiptJournalAdapter requires a reserve query",
        );
      }
    });

    it("reserve refuses empty, over-64-char, and secret-shaped consumers", async () => {
      const adapter = makeAdapter();
      for (const bad of ["", "   ", "x".repeat(65), 7, SYNTHETIC_OPENAI_SHAPE]) {
        await expect(
          adapter.reserve(reserveQuery({ consumer: bad as string })),
        ).rejects.toThrow(
          "InMemoryDecisionReceiptJournalAdapter requires a consumer of at most 64 chars",
        );
      }
    });

    it("reserve refuses non-finite, negative, or non-positive budget figures", async () => {
      const adapter = makeAdapter();
      for (const bad of [NaN, Infinity, -Infinity, -0.01, "0.5", null]) {
        await expect(
          adapter.reserve(reserveQuery({ assumedCostUsd: bad as number })),
        ).rejects.toThrow("finite non-negative assumedCostUsd");
        await expect(
          adapter.reserve(reserveQuery({ monthlyBudgetUsd: bad as number })),
        ).rejects.toThrow("finite non-negative monthlyBudgetUsd");
        await expect(
          adapter.reserve(reserveQuery({ consumerBudgetUsd: bad as number })),
        ).rejects.toThrow("consumerBudgetUsd greater than 0");
      }
      // Zero is a negative-like refusal for the consumer sub-budget only.
      await expect(
        adapter.reserve(reserveQuery({ consumerBudgetUsd: 0 })),
      ).rejects.toThrow("consumerBudgetUsd greater than 0");
      // Zero is a fine assumed cost; a zero total budget refuses at the cap.
      await expect(
        adapter.reserve(reserveQuery({ assumedCostUsd: 0, monthlyBudgetUsd: 0, stateSha256: SHA })),
      ).resolves.toEqual({ ok: false, reason: "budget-exhausted" });
      await expect(
        adapter.reserve(reserveQuery({ assumedCostUsd: 0, monthlyBudgetUsd: 0.01, stateSha256: SHA })),
      ).resolves.toMatchObject({ ok: true });
    });

    it("reserve refuses stateSha256 values that are not 64 lowercase hex characters", async () => {
      const adapter = makeAdapter();
      for (const bad of [
        UPPER_SHA,
        "a".repeat(63),
        "a".repeat(65),
        `g${"a".repeat(63)}`,
        123 as unknown as string,
      ]) {
        await expect(
          adapter.reserve(reserveQuery({ stateSha256: bad as string })),
        ).rejects.toThrow(
          "InMemoryDecisionReceiptJournalAdapter requires stateSha256 to match /^[0-9a-f]{64}$/",
        );
      }
    });

    it("settle refuses empty reservationId and null or non-object receipts", async () => {
      const adapter = makeAdapter();
      for (const badId of ["", "   ", 42 as unknown as string, null as unknown as string]) {
        await expect(
          adapter.settle(badId, receipt()),
        ).rejects.toThrow("requires a non-empty reservationId");
      }
      for (const badReceipt of [null, undefined, "receipt", 7]) {
        await expect(
          adapter.settle("some-id", badReceipt as unknown as Parameters<typeof adapter.settle>[1]),
        ).rejects.toThrow("requires a receipt for reservation some-id");
      }
    });

    it("settle refuses empty, over-length, and secret-shaped contextRef, consumer, and unknownReason", async () => {
      const adapter = makeAdapter();
      const id = await reserveOk(adapter);
      const cases: ReadonlyArray<[Record<string, unknown>, string]> = [
        [{ contextRef: "" }, "usable contextRef"],
        [{ contextRef: "  " }, "usable contextRef"],
        [{ contextRef: "x".repeat(257) }, "usable contextRef"],
        [{ contextRef: SYNTHETIC_GITHUB_SHAPE }, "usable contextRef"],
        [{ consumer: "" }, "usable consumer"],
        [{ consumer: "x".repeat(65) }, "usable consumer"],
        [{ consumer: SYNTHETIC_OPENAI_SHAPE }, "usable consumer"],
        [{ unknownReason: "" }, "usable unknownReason"],
        [{ unknownReason: "x".repeat(257) }, "usable unknownReason"],
        [{ unknownReason: SYNTHETIC_OPENAI_SHAPE }, "usable unknownReason"],
      ];
      for (const [overrides, message] of cases) {
        await expect(adapter.settle(id, receipt(overrides))).rejects.toThrow(message);
      }
    });

    it("settle refuses invalid latencyMs and out-of-range minConfidenceObserved", async () => {
      const adapter = makeAdapter();
      const id = await reserveOk(adapter);
      for (const bad of [-1, NaN, Infinity, -Infinity, "10", null]) {
        await expect(
          adapter.settle(id, receipt({ latencyMs: bad as number })),
        ).rejects.toThrow("finite non-negative latencyMs");
        await expect(
          adapter.settle(id, receipt({ minConfidenceObserved: bad as number })),
        ).rejects.toThrow("minConfidenceObserved in [0,1]");
      }
      await expect(
        adapter.settle(id, receipt({ minConfidenceObserved: 1.01 })),
      ).rejects.toThrow("minConfidenceObserved in [0,1]");
      await expect(
        adapter.settle(id, receipt({ minConfidenceObserved: -0.001 })),
      ).rejects.toThrow("minConfidenceObserved in [0,1]");
    });

    it("settle honours a proxy that consistently presents valid values and refuses a proxy presenting an invalid consumer", async () => {
      const adapter = makeAdapter();
      // An honest proxy behaves like the object it wraps.
      await adapter.settle(await reserveOk(adapter), new Proxy(receipt(), {}));
      // Accepted residual: a proxy lying consistently in every trap is
      // indistinguishable from the honest object it imitates, so it settles.
      const garbageTarget = {
        lexicalOrder: [1, 2],
        decidedOrder: [3],
        questionKinds: [4],
      };
      const lying = new Proxy(
        garbageTarget as unknown as DecisionCallReceipt,
        {
          get(target, prop) {
            if (prop === "consumer") return KNOWLEDGE_RANKING_CONSUMER;
            if (prop === "contextRef") return "ctx-proxy";
            if (prop === "latencyMs") return 5;
            if (prop === "lexicalOrder") return ["entry-a", "entry-b"];
            if (prop === "decidedOrder") return ["entry-a"];
            if (prop === "questionKinds") return ["grounding"];
            return Reflect.get(target as object, prop, target);
          },
        },
      );
      await adapter.settle(await reserveOk(adapter), lying);
      // A proxy that reports a wrong primitive through its get trap is
      // refused by the same screen as a plain object.
      const refusing = new Proxy(receipt(), {
        get(target, prop) {
          if (prop === "consumer") return 42;
          return Reflect.get(target as object, prop);
        },
      });
      await expect(
        adapter.settle(await reserveOk(adapter), refusing),
      ).rejects.toThrow("usable consumer");
    });

    it("refuses enormous string lengths with bounded checks for consumer, contextRef, unknownReason, and outcome text", async () => {
      const adapter = makeAdapter();
      const huge = "x".repeat(1_000_000);
      // The length comparison itself is O(1); allocating the fixture is the
      // test's cost, never the check's.
      await expect(
        adapter.reserve(reserveQuery({ consumer: huge })),
      ).rejects.toThrow("a consumer of at most 64 chars");
      await expect(
        adapter.settle(await reserveOk(adapter), receipt({ contextRef: huge })),
      ).rejects.toThrow("usable contextRef");
      await expect(
        adapter.settle(
          await reserveOk(adapter),
          receipt({ unknownReason: huge }),
        ),
      ).rejects.toThrow("usable unknownReason");
      await settleReceipt(adapter, "ctx-0001");
      const before = await adapter.readJournal({
        consumer: KNOWLEDGE_RANKING_CONSUMER,
      });
      await adapter.appendOutcome(outcome({ contextRef: huge }));
      const after = await adapter.readJournal({
        consumer: KNOWLEDGE_RANKING_CONSUMER,
      });
      expect(after.outcomes).toEqual(before.outcomes);
    });

    it("monthSpendUsd refuses non-Date and invalid Date values", async () => {
      const adapter = makeAdapter();
      for (const bad of ["2026-10", 1760000000000, null, undefined, new Date("invalid")]) {
        await expect(
          adapter.monthSpendUsd(bad as unknown as Date),
        ).rejects.toThrow(
          "InMemoryDecisionReceiptJournalAdapter requires a valid monthUtc Date",
        );
      }
    });

    it("readJournal refuses missing or invalid query consumer", async () => {
      const adapter = makeAdapter();
      for (const bad of [
        null,
        undefined,
        42,
        {},
        { consumer: "" },
        { consumer: "   " },
        { consumer: "x".repeat(65) },
        { consumer: SYNTHETIC_GITHUB_SHAPE },
        { consumer: 7 },
      ]) {
        await expect(
          adapter.readJournal(bad as unknown as Parameters<typeof adapter.readJournal>[0]),
        ).rejects.toThrow(
          "InMemoryDecisionReceiptJournalAdapter requires a readJournal query with a consumer",
        );
      }
    });
  });

  // ------------------------------------------------------------------
  // 4. Outcome joining
  // ------------------------------------------------------------------
  describe("outcome joining", () => {
    it("appends an outcome that matches a settled receipt of the same consumer and contextRef for both known kinds", async () => {
      const adapter = makeAdapter();
      await settleReceipt(adapter, "ctx-rank");
      await adapter.appendOutcome(
        outcome({ contextRef: "ctx-rank", kind: "ranking-selection", value: ["entry-b"] }),
      );
      await settleReceipt(adapter, "ctx-triage", { consumer: CLAIM_TRIAGE_CONSUMER });
      await adapter.appendOutcome(
        outcome({
          consumer: CLAIM_TRIAGE_CONSUMER,
          contextRef: "ctx-triage",
          kind: "triage-disposition",
          value: ["candidate-1"],
        }),
      );
      const ranking = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      const triage = await adapter.readJournal({ consumer: CLAIM_TRIAGE_CONSUMER });
      expect(ranking.outcomes).toHaveLength(1);
      expect(ranking.outcomes[0]).toEqual({
        consumer: KNOWLEDGE_RANKING_CONSUMER,
        contextRef: "ctx-rank",
        kind: "ranking-selection",
        value: ["entry-b"],
        at: "2026-10-31T23:59:59.000Z",
      });
      expect(triage.outcomes).toHaveLength(1);
      expect(triage.outcomes[0]?.kind).toBe("triage-disposition");
    });

    it("silently skips unsettled, unknown, and other-consumer receipts", async () => {
      const adapter = makeAdapter();
      // A settled receipt exists under knowledge-ranking at ctx-0001.
      await settleReceipt(adapter, "ctx-0001");
      const before = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });

      // Unsettled reservation: same contextRef shape but nothing was ever settled
      // for ctx-unsettled in this consumer.
      await adapter.appendOutcome(outcome({ contextRef: "ctx-unsettled" }));
      // Unknown contextRef under the triage consumer.
      await adapter.appendOutcome(
        outcome({ consumer: CLAIM_TRIAGE_CONSUMER, contextRef: "ctx-unknown" }),
      );
      // contextRef settled under a different consumer: triage never settled ctx-0001.
      await adapter.appendOutcome(
        outcome({ consumer: CLAIM_TRIAGE_CONSUMER, contextRef: "ctx-0001" }),
      );

      const ranking = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      const triage = await adapter.readJournal({ consumer: CLAIM_TRIAGE_CONSUMER });
      expect(ranking.outcomes).toEqual(before.outcomes);
      expect(ranking.outcomes).toHaveLength(0);
      expect(triage.outcomes).toHaveLength(0);
    });

    it("silently skips malformed or secret-shaped outcomes", async () => {
      const adapter = makeAdapter();
      await settleReceipt(adapter, "ctx-0001");
      const before = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });

      for (const bad of [
        null,
        "outcome",
        outcome({ kind: "not-a-kind" }),
        outcome({ value: [] }),
        outcome({ value: "entry-b" }),
        outcome({ value: ["entry-b", "   "] }),
        outcome({ value: [SYNTHETIC_OPENAI_SHAPE] }),
        outcome({ at: "" }),
        outcome({ at: "not-a-date" }),
        outcome({ consumer: "" }),
        outcome({ consumer: "   " }),
        outcome({ consumer: "x".repeat(65) }),
        outcome({ consumer: 7 }),
        outcome({ consumer: SYNTHETIC_GITHUB_SHAPE }),
        outcome({ contextRef: "" }),
        outcome({ contextRef: "  " }),
        outcome({ contextRef: "x".repeat(257) }),
        outcome({ contextRef: 7 }),
        outcome({ contextRef: SYNTHETIC_OPENAI_SHAPE }),
      ]) {
        await adapter.appendOutcome(bad as unknown as Parameters<typeof adapter.appendOutcome>[0]);
      }
      const after = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      expect(after.outcomes).toEqual(before.outcomes);
      expect(after.outcomes).toHaveLength(0);
    });

  });

  // ------------------------------------------------------------------
  // 5. Snapshot isolation & filtering
  // ------------------------------------------------------------------
  describe("snapshot isolation and filtering", () => {
    it("filters receipts and outcomes by consumer, preserves append order, and reports skippedLines 0", async () => {
      const adapter = makeAdapter();
      await settleReceipt(adapter, "ctx-r1", { contextRef: "ctx-r1" });
      await settleReceipt(adapter, "ctx-t1", {
        consumer: CLAIM_TRIAGE_CONSUMER,
        contextRef: "ctx-t1",
      });
      await settleReceipt(adapter, "ctx-r2", { contextRef: "ctx-r2" });
      await adapter.appendOutcome(outcome({ contextRef: "ctx-r1", value: ["v1"] }));
      await adapter.appendOutcome(
        outcome({ consumer: CLAIM_TRIAGE_CONSUMER, contextRef: "ctx-t1", kind: "triage-disposition", value: ["v2"] }),
      );
      await adapter.appendOutcome(outcome({ contextRef: "ctx-r2", value: ["v3"] }));

      const ranking = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      expect(ranking.skippedLines).toBe(0);
      expect(ranking.receipts.map((r) => r.contextRef)).toEqual(["ctx-r1", "ctx-r2"]);
      expect(ranking.outcomes.map((o) => o.value)).toEqual([["v1"], ["v3"]]);
      const triage = await adapter.readJournal({ consumer: CLAIM_TRIAGE_CONSUMER });
      expect(triage.receipts.map((r) => r.contextRef)).toEqual(["ctx-t1"]);
      expect(triage.outcomes.map((o) => o.value)).toEqual([["v2"]]);
    });

    it("mutating the returned snapshot does not alter subsequent readJournal results", async () => {
      const adapter = makeAdapter();
      await settleReceipt(adapter, "ctx-0001");
      await adapter.appendOutcome(outcome({ contextRef: "ctx-0001", value: ["entry-b"] }));

      const first = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      // Mutate everything the snapshot hands out.
      (first.receipts as unknown as unknown[]).push("pollution");
      (first.outcomes as unknown as unknown[]).push("pollution");
      (first.receipts[0]!.lexicalOrder as unknown as string[]).push("polluted");
      (first.receipts[0]!.decidedOrder as unknown as string[]).push("polluted");
      (first.outcomes[0]!.value as unknown as string[]).push("polluted");
      (first.receipts[0] as { costUsd: number }).costUsd = 999;

      const second = await adapter.readJournal({ consumer: KNOWLEDGE_RANKING_CONSUMER });
      expect(second.receipts).toHaveLength(1);
      expect(second.receipts[0]?.costUsd).toBe(0.01);
      expect(second.receipts[0]?.lexicalOrder).toEqual(["entry-a", "entry-b"]);
      expect(second.receipts[0]?.decidedOrder).toEqual(["entry-b", "entry-a"]);
      expect(second.outcomes).toHaveLength(1);
      expect(second.outcomes[0]?.value).toEqual(["entry-b"]);
    });
  });
});
