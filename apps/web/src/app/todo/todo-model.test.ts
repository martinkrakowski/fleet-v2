import { describe, expect, it } from "vitest";
import { ownerTodoListFixture } from "./fixture";
import {
  groupForEntry,
  groupTodoEntries,
  sortTodoEntries,
  todoAgeText,
  todoBadgeCount,
  todoClosedByText,
  todoRowHref,
  todoRowLabel,
  todoUnreadSources,
} from "./todo-model";
import type { OwnerTodoEntry, OwnerTodoList } from "./todo-wire";

function entry(overrides: Partial<OwnerTodoEntry> = {}): OwnerTodoEntry {
  return {
    origin: "owner-item",
    id: "example-item-x",
    projectId: "example-project",
    kind: "other",
    subject: "example subject",
    sinceIso: "2026-10-30T09:00:00.000Z",
    ageDays: 4,
    gating: false,
    gatesLanes: [],
    namesLanes: [],
    questionIds: [],
    closedBy: "owner",
    commands: [],
    ...overrides,
  };
}

describe("groupForEntry", () => {
  it("puts gating rows in blocking", () => {
    expect(groupForEntry(entry({ gating: true, kind: "merge" }))).toBe(
      "blocking",
    );
    expect(groupForEntry(entry({ gating: true, kind: "decision" }))).toBe(
      "blocking",
    );
  });

  it("puts secret, backup and other items in yours", () => {
    expect(groupForEntry(entry({ kind: "secret" }))).toBe("yours");
    expect(groupForEntry(entry({ kind: "backup" }))).toBe("yours");
    expect(groupForEntry(entry({ kind: "other" }))).toBe("yours");
  });

  it("puts merge and decision items and question rows in clears", () => {
    expect(groupForEntry(entry({ kind: "merge" }))).toBe("clears");
    expect(groupForEntry(entry({ kind: "decision" }))).toBe("clears");
    expect(groupForEntry(entry({ origin: "question", kind: "decision" }))).toBe(
      "clears",
    );
  });
});

describe("sortTodoEntries", () => {
  it("returns a new array sorted by gating, then sinceIso, then id", () => {
    const input = [
      entry({
        id: "b",
        sinceIso: "2026-11-01T00:00:00.000Z",
        gating: false,
      }),
      entry({
        id: "a",
        sinceIso: "2026-11-01T00:00:00.000Z",
        gating: false,
      }),
      entry({
        id: "g",
        sinceIso: "2026-10-31T00:00:00.000Z",
        gating: true,
      }),
      entry({
        id: "c",
        sinceIso: "2026-11-02T00:00:00.000Z",
        gating: false,
      }),
    ];
    const sorted = sortTodoEntries(input);
    expect(sorted).not.toBe(input);
    expect(sorted.map((item) => item.id)).toEqual(["g", "a", "b", "c"]);
  });
});

describe("groupTodoEntries", () => {
  it("always has the three group keys, empty groups as empty arrays", () => {
    const groups = groupTodoEntries([]);
    expect(Object.keys(groups).sort()).toEqual(["blocking", "clears", "yours"]);
    expect(groups.blocking).toEqual([]);
    expect(groups.yours).toEqual([]);
    expect(groups.clears).toEqual([]);
  });

  it("partitions sorted rows into the groups", () => {
    const rows = [
      entry({ id: "s", kind: "secret" }),
      entry({ id: "g", gating: true, kind: "merge" }),
      entry({ id: "m", kind: "merge" }),
      entry({ id: "q", origin: "question", kind: "decision" }),
    ];
    const groups = groupTodoEntries(rows);
    expect(groups.blocking.map((item) => item.id)).toEqual(["g"]);
    expect(groups.yours.map((item) => item.id)).toEqual(["s"]);
    expect(groups.clears.map((item) => item.id)).toEqual(["m", "q"]);
  });
});

describe("todoBadgeCount", () => {
  it("counts open rows once, folding a question into its item", () => {
    expect(todoBadgeCount(ownerTodoListFixture)).toBe(3);
    expect(todoBadgeCount(ownerTodoListFixture)).not.toBe(4);
    expect(todoBadgeCount(ownerTodoListFixture)).toBe(
      ownerTodoListFixture.entries.length,
    );
  });
});

describe("todoClosedByText", () => {
  it("maps the four closedBy values", () => {
    expect(todoClosedByText("owner")).toBe("yours to mark done");
    expect(todoClosedByText("merge-observed")).toBe(
      "clears when the merge is observed",
    );
    expect(todoClosedByText("recorded-choice")).toBe(
      "clears when the choice is recorded",
    );
    expect(todoClosedByText("answer")).toBe(
      "clears when the question is answered",
    );
  });
});

describe("todoAgeText", () => {
  it("formats ages and treats zero and negative as today", () => {
    expect(todoAgeText(0)).toBe("today");
    expect(todoAgeText(-3)).toBe("today");
    expect(todoAgeText(1)).toBe("1 day");
    expect(todoAgeText(3)).toBe("3 days");
  });
});

describe("todoRowLabel and todoRowHref", () => {
  it("labels a question row and links it to /questions", () => {
    const questionRow = entry({ origin: "question", kind: "decision" });
    expect(todoRowLabel(questionRow)).toBe("Question");
    expect(todoRowHref(questionRow)).toBe("/questions");
  });

  it("labels an item by its kind word and links nowhere", () => {
    const item = entry({ kind: "secret" });
    expect(todoRowLabel(item)).toBe("Secret");
    expect(todoRowHref(item)).toBeNull();
  });
});

describe("todoUnreadSources", () => {
  it("lists the not-read sources in wire order", () => {
    const list: OwnerTodoList = {
      ...ownerTodoListFixture,
      sources: [
        {
          source: "owner-items",
          repository: null,
          readAtIso: null,
          status: "not-read",
          reason: "lanes not read",
        },
        {
          source: "questions",
          repository: null,
          readAtIso: "2026-11-02T09:00:00.000Z",
          status: "read",
          reason: null,
        },
      ],
    };
    expect(todoUnreadSources(list)).toEqual(["owner-items"]);
  });

  it("returns an empty list when every source was read", () => {
    expect(todoUnreadSources(ownerTodoListFixture)).toEqual([]);
  });
});

describe("the fixture", () => {
  it("uses non-empty, single-line, invented subjects", () => {
    for (const item of ownerTodoListFixture.entries) {
      expect(item.subject).toBeTruthy();
      expect(item.subject).not.toContain("\n");
    }
  });
});
