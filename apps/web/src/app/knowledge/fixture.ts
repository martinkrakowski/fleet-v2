export interface Candidate {
  id: string;
  claim: string;
  project: string;
  paths: string;
  source: string;
  evidence: string;
  checked: string | null;
  supersedes: string;
  acceptable: boolean;
  acceptWhy: string;
}

export interface Keeper {
  id: string;
  v: string;
  claim: string;
  project: string;
  paths: string;
  source: string;
  checked: string;
  supersedes: string;
  used: number;
  wrongTurns: number;
}

export const PROJECT = "fleet-v2";

export const candidates: Candidate[] = [
  {
    id: "c-041",
    claim: "Nitro's srcDir: 'server' ignores src/; a route under src/routes never registers.",
    project: "fleet-v2",
    paths: "apps/api/nitro.config.ts",
    source: "att_01J9ZK3Q7V @ 7b2d0aa",
    evidence: ".lane/notes.md · vrf-0217 (failed)",
    checked: null,
    supersedes: "k-017 v2 (would become v3)",
    acceptable: false,
    acceptWhy: "the source head 7b2d0aa has no acceptance receipt",
  },
  {
    id: "c-042",
    claim: "Turbo runs typecheck without ^build; the context packages need dist/ first.",
    project: "fleet-v2",
    paths: "turbo.json, apps/api/package.json",
    source: "att_01J9ZK3Q7V @ 7b2d0aa",
    evidence: ".lane/notes.md",
    checked: null,
    supersedes: "—",
    acceptable: false,
    acceptWhy: "the source head 7b2d0aa has no acceptance receipt",
  },
  {
    id: "c-043",
    claim: "The reviewer seat for wave 3 should move to a cheaper model; Luna is slow on contract diffs.",
    project: "waves",
    paths: "—",
    source: "att_01J9ZF2N6P @ a81f4e2",
    evidence: ".lane/notes.md",
    checked: null,
    supersedes: "—",
    acceptable: false,
    acceptWhy: "this is a seat change: a policy proposal, never a keeper",
  },
  {
    id: "c-044",
    claim: "Killing the controller between reserve and dispatch leaves one intent record; replay finds the session and does not dispatch again.",
    project: "fleet-v2",
    paths: "packages/work-execution/src/journal/**, docs/runbooks/reconcile-an-attempt.md",
    source: "att_01J9ZD5W9K @ e5a7c90",
    evidence: "vrf-0219 (pass) · rev-0117 · acc-0071",
    checked: "vrf-0219 at e5a7c90",
    supersedes: "—",
    acceptable: true,
    acceptWhy: "acceptance receipt acc-0071 binds e5a7c90",
  },
];

export const keepers: Keeper[] = [
  {
    id: "k-017",
    v: "v2",
    claim: "Nitro routes live under server/routes; srcDir is set in nitro.config.ts.",
    project: "fleet-v2",
    paths: "apps/api/**",
    source: "att_01J9ZB2… @ 3c9f0d1",
    checked: "orchestrator · vrf-0198 · 2026-10-12",
    supersedes: "k-017 v1",
    used: 3,
    wrongTurns: 0,
  },
  {
    id: "k-023",
    v: "v1",
    claim: "Hexagen regenerates *.in-port.ts and *.out-port.ts; hand edits are overwritten by yarn sync.",
    project: "fleet-v2, hexagen",
    paths: "packages/*/src/**/ports/**",
    source: "att_01J9Z7… @ eccc98b",
    checked: "orchestrator · vrf-0190 · 2026-10-12",
    supersedes: "—",
    used: 5,
    wrongTurns: 0,
  },
  {
    id: "k-009",
    v: "v3",
    claim: "Nothing under server/ imports node:child_process; the pre-merge review greps for it.",
    project: "fleet-v2",
    paths: "apps/api/server/**",
    source: "att_01J9Z9… @ eccc98b",
    checked: "orchestrator · rev-0102 · 2026-10-12",
    supersedes: "k-009 v2",
    used: 2,
    wrongTurns: 0,
  },
  {
    id: "k-031",
    v: "v1",
    claim: "yarn lint:arch fails when a supplier context imports an execution aggregate.",
    project: "fleet-v2",
    paths: "packages/**",
    source: "att_01J9Z8… @ eccc98b",
    checked: "orchestrator · vrf-0191 · 2026-10-12",
    supersedes: "—",
    used: 1,
    wrongTurns: 1,
  },
];
