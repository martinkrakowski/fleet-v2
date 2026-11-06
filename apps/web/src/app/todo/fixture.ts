/**
 * Test-input fixture for the `/todo` page. The wire shape is copied from
 * `docs/planning/2026-10-28_owner-todo-section-plan.md` section 3.2 (lines
 * 66–82). This file is a test input only, never shipped data: it is imported
 * only by the two test files. Subjects are invented — never a real host,
 * account, token, secret name or personal matter.
 */

import type { OwnerTodoList } from "./todo-wire";

export const ownerTodoListFixture: OwnerTodoList = {
  schemaVersion: 1,
  readAtIso: "2026-11-02T09:00:00.000Z",
  sources: [
    {
      source: "owner-items",
      repository: null,
      readAtIso: "2026-11-02T09:00:00.000Z",
      status: "read",
      reason: null,
    },
    {
      source: "questions",
      repository: null,
      readAtIso: "2026-11-02T09:00:00.000Z",
      status: "read",
      reason: null,
    },
  ],
  complete: true,
  counts: { total: 3, gating: 1, yours: 1, clearsItself: 2 },
  parksWithoutItem: 2,
  entries: [
    {
      origin: "owner-item",
      id: "example-item-1",
      projectId: "example-project",
      kind: "merge",
      subject: "merge the example cutover lane",
      sinceIso: "2026-10-30T09:00:00.000Z",
      ageDays: 6,
      gating: true,
      gatesLanes: ["example-project/example-plan/example-lane"],
      namesLanes: ["example-project/example-plan/example-lane"],
      questionIds: [],
      closedBy: "merge-observed",
      commands: [],
    },
    {
      origin: "owner-item",
      id: "example-item-2",
      projectId: "example-project",
      kind: "secret",
      subject: "rotate the example deploy token",
      sinceIso: "2026-10-31T08:00:00.000Z",
      ageDays: 5,
      gating: false,
      gatesLanes: [],
      namesLanes: [],
      questionIds: ["example-question-1", "example-question-2"],
      closedBy: "owner",
      commands: ["fleet-v2 owner-items resolve example-item-2 --done"],
    },
    {
      origin: "question",
      id: "example-question-3",
      projectId: null,
      kind: "decision",
      subject: "which example branch should ship?",
      sinceIso: "2026-11-01T10:00:00.000Z",
      ageDays: 4,
      gating: false,
      gatesLanes: [],
      namesLanes: [],
      questionIds: ["example-question-3"],
      closedBy: "answer",
      commands: [],
    },
  ],
};

export const ownerTodoListEnvelopeFixture = {
  operationId: "example-operation",
  code: "OK",
  result: ownerTodoListFixture,
};
