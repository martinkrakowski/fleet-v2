import { describe, expect, it } from "vitest";
import {
  billingOf,
  modelChipText,
  money,
  seatChipText,
  sumUsage,
  usageChip,
  usageSumText,
  type UsageInput,
} from "./usage-view";
import type { RecordedRunner, RecordedUsage } from "./attempt-wire";

const OPENCODE: RecordedRunner = {
  kind: "opencode",
  agent: "lane-glm",
  model: "model-a",
  variant: "low",
};

const AGY: RecordedRunner = {
  kind: "agy",
  agent: null,
  model: "model-b",
  variant: null,
};

function usage(overrides: Partial<RecordedUsage> = {}): RecordedUsage {
  return {
    source: "opencode-db",
    readAtIso: "2026-10-24T10:05:00Z",
    steps: 40,
    wallSeconds: 1500,
    tokensInput: 1000,
    tokensOutput: 500,
    costUsd: 0.12,
    model: "model-b",
    reason: null,
    ...overrides,
  };
}

const input = (
  runner: RecordedRunner | null,
  u: RecordedUsage | null,
): UsageInput => ({ runner, usage: u });

describe("billingOf", () => {
  it("maps opencode to metered, agy to plan and anything else to unknown", () => {
    expect(billingOf(OPENCODE)).toBe("metered");
    expect(billingOf(AGY)).toBe("plan");
    expect(
      billingOf({ kind: "later-kind", agent: null, model: null, variant: null }),
    ).toBe("unknown");
    expect(billingOf(null)).toBe("unknown");
  });
});

describe("seatChipText", () => {
  it("renders kind, agent and variant when recorded", () => {
    expect(seatChipText(OPENCODE)).toBe("opencode · lane-glm · low");
    expect(seatChipText(AGY)).toBe("agy");
  });

  it("omits the missing agent or variant", () => {
    expect(
      seatChipText({
        kind: "opencode",
        agent: "lane",
        model: null,
        variant: null,
      }),
    ).toBe("opencode · lane");
    expect(
      seatChipText({
        kind: "opencode",
        agent: null,
        model: null,
        variant: "low",
      }),
    ).toBe("opencode · low");
  });

  it("reports a seat that is not recorded", () => {
    expect(seatChipText(null)).toBe("seat not recorded");
  });
});

describe("modelChipText", () => {
  it("takes the runner model first, then the usage model", () => {
    expect(modelChipText(input(OPENCODE, usage()))).toBe("model-a");
    expect(
      modelChipText(
        input(
          { kind: "opencode", agent: null, model: null, variant: null },
          usage(),
        ),
      ),
    ).toBe("model-b");
    expect(modelChipText(input(null, usage()))).toBe("model-b");
  });

  it("falls back to model not recorded", () => {
    expect(modelChipText(input(null, null))).toBe("model not recorded");
    expect(modelChipText(input(null, usage({ model: null })))).toBe(
      "model not recorded",
    );
    expect(
      modelChipText(
        input(
          { kind: "opencode", agent: null, model: null, variant: null },
          null,
        ),
      ),
    ).toBe("model not recorded");
  });
});

describe("usageChip", () => {
  it("says not measured without a usage or when the source is unavailable", () => {
    expect(usageChip(input(OPENCODE, null))).toEqual({
      text: "not measured",
      title: "usage source: not recorded",
      estimate: false,
    });
    expect(
      usageChip(
        input(
          OPENCODE,
          usage({
            source: "unavailable",
            steps: null,
            wallSeconds: null,
            tokensInput: null,
            tokensOutput: null,
            costUsd: null,
          }),
        ),
      ),
    ).toEqual({
      text: "not measured",
      title: "usage source: unavailable",
      estimate: false,
    });
  });

  it("labels an unreadable opencode-db cost", () => {
    expect(usageChip(input(OPENCODE, usage({ costUsd: null })))).toEqual({
      text: "cost unreadable (not 0)",
      title: "usage source: opencode-db",
      estimate: false,
    });
  });

  it("renders a metered dollar figure and keeps $0.00", () => {
    expect(usageChip(input(OPENCODE, usage({ costUsd: 0.12 })))).toEqual({
      text: "$0.12",
      title: "usage source: opencode-db",
      estimate: false,
    });
    expect(usageChip(input(OPENCODE, usage({ costUsd: 0 })))).toEqual({
      text: "$0.00",
      title: "usage source: opencode-db",
      estimate: false,
    });
  });

  it("labels a plan-billed agy figure as an estimate", () => {
    expect(usageChip(input(AGY, usage()))).toEqual({
      text: "est. $0.12 · plan",
      title:
        "usage source: opencode-db · plan-billed seat: an estimate, not spend",
      estimate: true,
    });
  });

  it("labels an unknown billing", () => {
    expect(usageChip(input(null, usage()))).toEqual({
      text: "$0.12 · billing not recorded",
      title: "usage source: opencode-db",
      estimate: false,
    });
  });
});

describe("sumUsage", () => {
  it("keeps metered, estimated and unknown figures apart and never counts unmeasured as zero", () => {
    const sum = sumUsage([
      input(OPENCODE, usage({ costUsd: 0.1 })),
      input(OPENCODE, usage({ costUsd: 0 })),
      input(AGY, usage({ costUsd: 0.3 })),
      input(
        OPENCODE,
        usage({
          source: "unavailable",
          steps: null,
          wallSeconds: null,
          tokensInput: null,
          tokensOutput: null,
          costUsd: null,
        }),
      ),
      input(OPENCODE, null),
    ]);

    expect(sum.attempts).toBe(5);
    expect(sum.measured).toBe(3);
    expect(sum.notMeasured).toBe(2);
    expect(sum.meteredCount).toBe(2);
    expect(sum.estimateCount).toBe(1);
    expect(sum.unknownBillingCount).toBe(0);
    expect(sum.meteredUsd).toBeCloseTo(0.1);
    expect(sum.estimateUsd).toBeCloseTo(0.3);
    expect(sum.unknownBillingUsd).toBe(0);
  });
});

describe("usageSumText", () => {
  const emptySum = {
    attempts: 0,
    measured: 0,
    notMeasured: 0,
    meteredCount: 0,
    estimateCount: 0,
    unknownBillingCount: 0,
    meteredUsd: 0,
    estimateUsd: 0,
    unknownBillingUsd: 0,
  };

  it("handles no recorded attempts", () => {
    expect(usageSumText(emptySum)).toBe("no attempts recorded");
  });

  it("handles all-unmeasured lists with singular and plural", () => {
    expect(usageSumText({ ...emptySum, attempts: 3, notMeasured: 3 })).toBe(
      "not measured on any of 3 attempts",
    );
    expect(usageSumText({ ...emptySum, attempts: 1, notMeasured: 1 })).toBe(
      "not measured on any of 1 attempt",
    );
  });

  it("joins the present parts in order", () => {
    expect(
      usageSumText({
        attempts: 5,
        measured: 3,
        notMeasured: 2,
        meteredCount: 1,
        estimateCount: 1,
        unknownBillingCount: 1,
        meteredUsd: 0.1,
        estimateUsd: 0.3,
        unknownBillingUsd: 0.2,
      }),
    ).toBe(
      "$0.10 metered · est. $0.30 plan, not spend · $0.20 billing not recorded · over 3 of 5 attempts · 2 not measured",
    );
  });

  it("omits the absent dollar parts", () => {
    expect(
      usageSumText({
        attempts: 2,
        measured: 1,
        notMeasured: 1,
        meteredCount: 1,
        estimateCount: 0,
        unknownBillingCount: 0,
        meteredUsd: 0.12,
        estimateUsd: 0,
        unknownBillingUsd: 0,
      }),
    ).toBe("$0.12 metered · over 1 of 2 attempts · 1 not measured");

    expect(
      usageSumText({
        attempts: 1,
        measured: 1,
        notMeasured: 0,
        meteredCount: 0,
        estimateCount: 1,
        unknownBillingCount: 0,
        meteredUsd: 0,
        estimateUsd: 0.3,
        unknownBillingUsd: 0,
      }),
    ).toBe("est. $0.30 plan, not spend · over 1 of 1 attempts");

    expect(
      usageSumText({
        attempts: 1,
        measured: 1,
        notMeasured: 0,
        meteredCount: 0,
        estimateCount: 0,
        unknownBillingCount: 1,
        meteredUsd: 0,
        estimateUsd: 0,
        unknownBillingUsd: 0.2,
      }),
    ).toBe("$0.20 billing not recorded · over 1 of 1 attempts");
  });

  it("names a measured $0.00 metered bucket and a measured $0.00 plan bucket", () => {
    expect(
      usageSumText({
        attempts: 1,
        measured: 1,
        notMeasured: 0,
        meteredCount: 1,
        estimateCount: 0,
        unknownBillingCount: 0,
        meteredUsd: 0,
        estimateUsd: 0,
        unknownBillingUsd: 0,
      }),
    ).toBe("$0.00 metered · over 1 of 1 attempts");

    expect(
      usageSumText({
        attempts: 1,
        measured: 1,
        notMeasured: 0,
        meteredCount: 0,
        estimateCount: 1,
        unknownBillingCount: 0,
        meteredUsd: 0,
        estimateUsd: 0,
        unknownBillingUsd: 0,
      }),
    ).toBe("est. $0.00 plan, not spend · over 1 of 1 attempts");
  });

  it("joins a measured $0.00 metered bucket with a plan estimate", () => {
    expect(
      usageSumText({
        attempts: 2,
        measured: 2,
        notMeasured: 0,
        meteredCount: 1,
        estimateCount: 1,
        unknownBillingCount: 0,
        meteredUsd: 0,
        estimateUsd: 0.3,
        unknownBillingUsd: 0,
      }),
    ).toBe(
      "$0.00 metered · est. $0.30 plan, not spend · over 2 of 2 attempts",
    );
  });

  it("sums a measured $0.00 into the matching bucket with its count", () => {
    const sum = sumUsage([
      input(OPENCODE, usage({ costUsd: 0 })),
      input(OPENCODE, usage({ costUsd: 0.12 })),
      input(AGY, usage({ costUsd: 0 })),
      input(null, usage({ costUsd: 0 })),
    ]);

    expect(sum.attempts).toBe(4);
    expect(sum.measured).toBe(4);
    expect(sum.notMeasured).toBe(0);
    expect(sum.meteredCount).toBe(2);
    expect(sum.estimateCount).toBe(1);
    expect(sum.unknownBillingCount).toBe(1);
    expect(sum.meteredUsd).toBeCloseTo(0.12);
    expect(sum.estimateUsd).toBe(0);
    expect(sum.unknownBillingUsd).toBe(0);
  });
});

describe("money", () => {
  it("formats to two decimals with a dollar sign", () => {
    expect(money(0.12)).toBe("$0.12");
    expect(money(0)).toBe("$0.00");
    expect(money(1.5)).toBe("$1.50");
  });
});
