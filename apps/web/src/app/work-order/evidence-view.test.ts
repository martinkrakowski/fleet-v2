import { describe, expect, it } from "vitest";
import {
  assessmentTone,
  coverageText,
  isHeadSha,
  kindText,
  listText,
  resultTone,
  tallyText,
} from "./evidence-view";

describe("isHeadSha", () => {
  it("accepts 7 to 40 lowercase hex characters and refuses anything else", () => {
    expect(isHeadSha("0123abc")).toBe(true);
    expect(isHeadSha("a".repeat(40))).toBe(true);
    expect(isHeadSha("0123ab")).toBe(false);
    expect(isHeadSha("a".repeat(41))).toBe(false);
    expect(isHeadSha("0123ABC")).toBe(false);
    expect(isHeadSha("../x")).toBe(false);
    expect(isHeadSha("")).toBe(false);
  });
});

describe("resultTone", () => {
  it("maps every evidence result word to a badge tone", () => {
    expect(resultTone("pass")).toBe("accepted");
    expect(resultTone("fail")).toBe("failed");
    expect(resultTone("pending")).toBe("queued");
    expect(resultTone("unknown")).toBe("unknown");
    expect(resultTone("not-applicable")).toBe("ended");
  });
});

describe("assessmentTone", () => {
  it("maps every assessment state to a badge tone", () => {
    expect(assessmentTone("accepted")).toBe("accepted");
    expect(assessmentTone("blocked")).toBe("blocked");
    expect(assessmentTone("rejected")).toBe("failed");
    expect(assessmentTone("pending")).toBe("queued");
    expect(assessmentTone("stale")).toBe("unknown");
  });
});

describe("coverageText", () => {
  it("covers null, ran and did-not-run shapes", () => {
    expect(coverageText(null)).toBe("coverage not recorded");
    expect(
      coverageText({ ran: true, unitKind: "tests", units: 4 }),
    ).toBe("covered 4 tests");
    expect(coverageText({ ran: false, reason: "gate missing" })).toBe(
      "did not run: gate missing",
    );
  });
});

describe("tallyText", () => {
  it("covers null, agreement and disagreement", () => {
    expect(tallyText(null)).toBe("review tally not recorded");
    expect(
      tallyText({ pass: 2, fail: 1, unknown: 0, disagreement: false }),
    ).toBe("review tally: 2 pass · 1 fail · 0 unknown");
    expect(
      tallyText({ pass: 1, fail: 1, unknown: 1, disagreement: true }),
    ).toBe("review tally: 1 pass · 1 fail · 1 unknown · reviewers disagree");
  });
});

describe("kindText", () => {
  it("covers recorded and unrecorded kinds", () => {
    expect(kindText(null)).toBe("kind not recorded");
    expect(kindText("security")).toBe("security");
  });
});

describe("listText", () => {
  it("covers empty and non-empty item lists", () => {
    expect(listText([], "none recorded")).toBe("none recorded");
    expect(listText(["a", "b"], "none recorded")).toBe("a, b");
  });
});
