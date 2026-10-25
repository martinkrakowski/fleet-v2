/**
 * Sample project profiles for the Projects views. Every value is a sample:
 * example.com repositories on the sample hosts `host-a` and `host-b`;
 * nothing here reaches a runner or the API.
 */

import type { ProjectView } from "./map-project";

export const sampleProjects: readonly ProjectView[] = [
  {
    projectId: "fleet-v2",
    displayName: "Fleet v2",
    repository: "https://example.com/fleet-v2.git",
    designatedDispatcherHost: "host-a",
    policyRevision: "pol-2026-10-11.3",
    maxConcurrentLanes: 4,
    runnerCapabilities: { networkEgressRestricted: true },
    status: "active",
    defaultBranch: "main",
    clones: {
      "host-a": {
        path: "/srv/clones/fleet-v2",
        worktreeRoot: "/srv/worktrees/fleet-v2",
      },
    },
    gateProcedures: ["typecheck", "lint"],
    defaultAllowedPathPrefixes: ["packages/**", "apps/**"],
    lastProbe: {
      probedAtIso: "2026-10-24T10:00:00Z",
      probedFrom: "host-a",
      checks: [
        {
          name: "repository reachable",
          host: "host-a",
          result: "pass",
          detail: "git ls-remote answered in 120 ms",
        },
        {
          name: "worktree root writable",
          host: "host-a",
          result: "pass",
          detail: "touch probe in /srv/worktrees/fleet-v2 succeeded",
        },
      ],
    },
    revision: 12,
    updatedAtIso: "2026-10-24T09:55:00Z",
  },
  {
    projectId: "waves",
    displayName: "Waves",
    repository: "https://example.com/waves.git",
    designatedDispatcherHost: "host-b",
    policyRevision: "pol-2026-10-11.3",
    maxConcurrentLanes: 2,
    runnerCapabilities: { networkEgressRestricted: false },
    status: "active",
    defaultBranch: "main",
    clones: {
      "host-b": {
        path: "/srv/clones/waves",
        worktreeRoot: "/srv/worktrees/waves",
      },
    },
    gateProcedures: ["verify"],
    defaultAllowedPathPrefixes: ["contracts/**"],
    lastProbe: {
      probedAtIso: "2026-10-24T10:02:00Z",
      probedFrom: "host-b",
      checks: [
        {
          name: "repository reachable",
          host: "host-b",
          result: "fail",
          detail: "ssh: connection timed out after 10 s",
        },
      ],
    },
    revision: 7,
    updatedAtIso: "2026-10-24T10:02:00Z",
  },
  {
    projectId: "hexagen",
    displayName: "Hexagen",
    repository: "https://example.com/hexagen.git",
    designatedDispatcherHost: "host-a",
    policyRevision: "pol-2026-10-01.1",
    maxConcurrentLanes: 1,
    runnerCapabilities: {},
    status: "retired",
    defaultBranch: null,
    clones: {},
    gateProcedures: [],
    defaultAllowedPathPrefixes: [],
    lastProbe: null,
    revision: 3,
    updatedAtIso: "2026-10-18T08:00:00Z",
  },
];
