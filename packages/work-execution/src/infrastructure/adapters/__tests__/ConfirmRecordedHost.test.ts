// Lane Q2b: direct unit tests for the shared confirm-or-unknown comparison of a
// recorded host (seam register entry 2). The refusal branches were pinned only
// in passing by the RunnerForAttempt agy test and the review-locator test; this
// file pins each branch directly, alongside the legacy-name predicate.

import { describe, expect, it } from "vitest";

import type { AttemptRunnerRecord } from "../../../domain/execution-records.js";
import {
  confirmRecordedHost,
  hasRecordedHostName,
  type RunnerForAttemptHostSpec,
} from "../ConfirmRecordedHost.js";

const HOST_NAME = "lanehost";
const CHANGED_REASON = `recorded host ${HOST_NAME} changed or was removed`;

function record(overrides: Partial<AttemptRunnerRecord> = {}): AttemptRunnerRecord {
  return {
    kind: "opencode",
    remotePort: 46000,
    host: null,
    hostName: HOST_NAME,
    agent: null,
    model: "example-provider/example-model",
    variant: null,
    ...overrides,
  };
}

const LOCAL_SPEC: RunnerForAttemptHostSpec = {
  transport: "local",
  roles: ["lane-runner"],
  runner: { kind: "opencode", port: 46000 },
};

const SSH_SPEC: RunnerForAttemptHostSpec = {
  transport: "ssh",
  sshAlias: "lane.example",
  roles: ["lane-runner"],
  runner: { kind: "opencode", port: 46000 },
};

describe("hasRecordedHostName", () => {
  it.each([
    { name: "null", recorded: null },
    { name: "undefined", recorded: undefined },
    { name: "a blank hostName", recorded: record({ hostName: "" }) },
    { name: "a whitespace-only hostName", recorded: record({ hostName: "   " }) },
  ])("is false for $name", ({ recorded }) => {
    expect(hasRecordedHostName(recorded)).toBe(false);
  });

  it("is true for a non-blank hostName", () => {
    expect(hasRecordedHostName(record())).toBe(true);
  });
});

describe("confirmRecordedHost", () => {
  it("confirms a local host", () => {
    expect(confirmRecordedHost(record(), { [HOST_NAME]: LOCAL_SPEC })).toEqual({
      ok: true,
      name: HOST_NAME,
      spec: LOCAL_SPEC,
      transport: "local",
    });
  });

  it("confirms an ssh host", () => {
    expect(
      confirmRecordedHost(record({ host: "lane.example" }), { [HOST_NAME]: SSH_SPEC }),
    ).toEqual({
      ok: true,
      name: HOST_NAME,
      spec: SSH_SPEC,
      transport: "ssh",
    });
  });

  const REFUSALS: Array<{
    name: string;
    record: AttemptRunnerRecord;
    hosts: Record<string, RunnerForAttemptHostSpec>;
  }> = [
    {
      name: "a recorded host name absent from the installation hosts",
      record: record(),
      hosts: {},
    },
    {
      name: "a host whose roles no longer include lane-runner",
      record: record(),
      hosts: {
        [HOST_NAME]: {
          transport: "local",
          roles: ["worktree"],
          runner: { kind: "opencode", port: 46000 },
        },
      },
    },
    {
      name: "a host whose runner kind differs from the recorded kind",
      record: record(),
      hosts: {
        [HOST_NAME]: {
          transport: "local",
          roles: ["lane-runner"],
          runner: { kind: "agy", port: 46000 },
        },
      },
    },
    {
      name: "a recorded alias against a local host",
      record: record({ host: "lane.example" }),
      hosts: { [HOST_NAME]: LOCAL_SPEC },
    },
    {
      name: "a null alias against an ssh host",
      record: record(),
      hosts: { [HOST_NAME]: SSH_SPEC },
    },
    {
      name: "a differing current ssh alias",
      record: record({ host: "lane.example" }),
      hosts: {
        [HOST_NAME]: { ...SSH_SPEC, sshAlias: "other.example" },
      },
    },
    {
      name: "a blank current ssh alias",
      record: record({ host: "lane.example" }),
      hosts: {
        [HOST_NAME]: { ...SSH_SPEC, sshAlias: "   " },
      },
    },
    {
      name: "a differing opencode port",
      record: record(),
      hosts: {
        [HOST_NAME]: {
          ...LOCAL_SPEC,
          runner: { kind: "opencode", port: 4166 },
        },
      },
    },
  ];

  it.each(REFUSALS)("refuses $name", ({ record: recorded, hosts }) => {
    expect(confirmRecordedHost(recorded, hosts)).toEqual({
      ok: false,
      reason: CHANGED_REASON,
    });
  });

  it("confirms an agy record with a null port against a host that declares one", () => {
    const agySpec: RunnerForAttemptHostSpec = {
      transport: "local",
      roles: ["lane-runner"],
      runner: { kind: "agy", port: 46000 },
    };
    const agyRecord = record({ kind: "agy", remotePort: null, host: null });
    expect(confirmRecordedHost(agyRecord, { [HOST_NAME]: agySpec })).toEqual({
      ok: true,
      name: HOST_NAME,
      spec: agySpec,
      transport: "local",
    });
  });
});
