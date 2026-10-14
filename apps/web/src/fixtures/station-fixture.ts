/**
 * Consolidated station fixture data for the fleet-v2 web views.
 * Every value here is a sample; nothing reaches a runner or the API.
 */

// ---------------------------------------------------------------------------
// Shared fact types (from app/lanes/fixture.ts and app/attempt/fixture.ts)
// ---------------------------------------------------------------------------

export type FactValue = "yes" | "no" | "unknown";
export type FactState = FactValue | "stale";
export type CapacityState = "pending" | "held" | "released";
export type FactName = "reachable" | "prepared" | "active" | "ended" | "collected";

export interface Facts {
  reachable: FactValue;
  prepared: FactValue;
  active: FactValue;
  ended: FactValue;
  collected: FactValue;
}

export const FACTS_ORDER: Array<keyof Facts> = [
  "reachable",
  "prepared",
  "active",
  "ended",
  "collected",
];

export const FACT_LABELS: Record<keyof Facts, string> = {
  reachable: "Runner reachable",
  prepared: "Workspace prepared",
  active: "Worker command active",
  ended: "Worker command ended",
  collected: "Artifacts collected",
};

export const FACT_SHORT: Record<keyof Facts, string> = {
  reachable: "reachable",
  prepared: "prepared",
  active: "active",
  ended: "ended",
  collected: "collected",
};

// ---------------------------------------------------------------------------
// Lanes view types and data
// ---------------------------------------------------------------------------

export interface WorkOrderSummary {
  project: string;
  task: string;
  lane: string;
}

export interface NotOffered {
  op: string;
  reason: string;
}

export interface AttemptSummary {
  id: string;
  wo: string;
  kind: "first" | "fix";
  number: number;
  fixOf: string | null;
  session: string | null;
  port: number;
  slot: number | null;
  capacity: CapacityState;
  startedAt: string | null;
  queuedAt: string | null;
  queueBound: string | null;
  observedAt: string;
  observedFrom: string;
  facts: Facts;
  lastKnown: { at: string; facts: Facts } | null;
  stale: boolean;
  receipts: {
    completion: { id: string } | null;
    verification: { head: string; pass: boolean } | null;
    acceptance: { head: string } | null;
    decision: { id: string; door: string; pending: boolean } | null;
  };
  mergeHead: string | null;
  pullRequest: string | null;
  cost: { steps: number; minutes: number; usd: number } | null;
  legal: string[];
  notOffered: NotOffered[];
}

export const capacity = { host: "execution host A", port: 4166, slots: 3 };
export const install = { wavesInboxUrl: "#waves-inbox" };

export const workOrders: Record<string, WorkOrderSummary> = {
  "wo-0142": { project: "fleet-v2", task: "Wire the Nitro API route surface (step A)", lane: "api-routes-a" },
  "wo-0139": { project: "fleet-v2", task: "Worktree inspection as a typed contract", lane: "runner-inspect" },
  "wo-0146": { project: "fleet-v2", task: "Five-fact observation as a typed port (step C)", lane: "facts-port" },
  "wo-0137": { project: "fleet-v2", task: "Reconcile runbook fixture and journal replay", lane: "journal-replay" },
  "wo-0131": { project: "waves", task: "Relay and host-alert contract beside waves/v1 (W1)", lane: "contract-w1" },
  "wo-0133": { project: "waves", task: "Enrol-key rotation runbook fixture", lane: "enrol-rotate" },
  "wo-0128": { project: "hexagen", task: "Emit adapter bindings from the manifest", lane: "bindings-emit" }
};

export const attempts: AttemptSummary[] = [
  {
    id: "att_01J9ZM8R2C", wo: "wo-0142", kind: "fix", number: 2, fixOf: "att_01J9ZK3Q7V",
    session: "ses_9c04d", port: 4166, slot: 2, capacity: "held",
    startedAt: "13:41:08Z", queuedAt: null, queueBound: null,
    observedAt: "14:02:04Z", observedFrom: "runner port 4166 · session ses_9c04d",
    facts: { reachable: "yes", prepared: "yes", active: "yes", ended: "no", collected: "no" },
    lastKnown: null, stale: false,
    receipts: { completion: null, verification: null, acceptance: null, decision: null },
    mergeHead: null, pullRequest: null,
    cost: { steps: 41, minutes: 21, usd: 0.07 },
    legal: ["reconcile", "stop"],
    notOffered: [
      { op: "collect", reason: "the command has not ended" },
      { op: "fix", reason: "this attempt is still running" },
      { op: "merge", reason: "no acceptance receipt at the current head" }
    ]
  },
  {
    id: "att_01J9ZN4H8Y", wo: "wo-0128", kind: "first", number: 1, fixOf: null,
    session: "ses_2e71b", port: 4166, slot: 3, capacity: "held",
    startedAt: "13:52:30Z", queuedAt: null, queueBound: null,
    observedAt: "14:02:05Z", observedFrom: "runner port 4166 · session ses_2e71b",
    facts: { reachable: "yes", prepared: "yes", active: "yes", ended: "no", collected: "no" },
    lastKnown: null, stale: false,
    receipts: { completion: null, verification: null, acceptance: null, decision: null },
    mergeHead: null, pullRequest: null,
    cost: { steps: 18, minutes: 9, usd: 0.03 },
    legal: ["reconcile", "stop"],
    notOffered: [
      { op: "collect", reason: "the command has not ended" },
      { op: "merge", reason: "no acceptance receipt at the current head" }
    ]
  },
  {
    id: "att_01J9ZH1M4T", wo: "wo-0139", kind: "first", number: 1, fixOf: null,
    session: "ses_3a8e0", port: 4166, slot: 1, capacity: "held",
    startedAt: "13:22:44Z", queuedAt: null, queueBound: null,
    observedAt: "14:01:58Z", observedFrom: "runner port 4166 did not answer (10 s timeout). Last answer 13:48:10Z.",
    facts: { reachable: "unknown", prepared: "unknown", active: "unknown", ended: "unknown", collected: "no" },
    lastKnown: { at: "13:48:10Z", facts: { reachable: "yes", prepared: "yes", active: "yes", ended: "no", collected: "no" } },
    stale: true,
    receipts: { completion: null, verification: null, acceptance: null, decision: null },
    mergeHead: null, pullRequest: null,
    cost: { steps: 63, minutes: 26, usd: 0.12 },
    legal: ["reconcile"],
    notOffered: [
      { op: "stop", reason: "the runner cannot be read; a stop needs the runner to confirm termination" },
      { op: "collect", reason: "the outcome is unknown; unknown is not ended" },
      { op: "merge", reason: "unknown never frees capacity" }
    ]
  },
  {
    id: "att_01J9ZQ6T1A", wo: "wo-0133", kind: "first", number: 1, fixOf: null,
    session: null, port: 4166, slot: null, capacity: "pending",
    startedAt: null, queuedAt: "14:00:12Z", queueBound: "30 min",
    observedAt: "14:02:06Z", observedFrom: "journal · intent recorded, no session id",
    facts: { reachable: "yes", prepared: "yes", active: "no", ended: "no", collected: "no" },
    lastKnown: null, stale: false,
    receipts: { completion: null, verification: null, acceptance: null, decision: null },
    mergeHead: null, pullRequest: null,
    cost: null,
    legal: ["stop"],
    notOffered: [
      { op: "reconcile", reason: "no session exists yet; the intent record is the truth" },
      { op: "dispatch again", reason: "the journal already holds this intent; a second record would be a duplicate" }
    ]
  },
  {
    id: "att_01J9ZT4C6H", wo: "wo-0146", kind: "first", number: 1, fixOf: null,
    session: "ses_6f2d9", port: 4166, slot: null, capacity: "released",
    startedAt: "13:54:02Z", queuedAt: null, queueBound: null,
    observedAt: "13:58:44Z", observedFrom: "completion receipt cmp-0312 · runner port 4166",
    facts: { reachable: "yes", prepared: "yes", active: "no", ended: "yes", collected: "no" },
    lastKnown: null, stale: false,
    receipts: { completion: { id: "cmp-0312" }, verification: null, acceptance: null, decision: null },
    mergeHead: null, pullRequest: null,
    cost: { steps: 34, minutes: 5, usd: 0.02 },
    legal: ["collect"],
    notOffered: [
      { op: "reconcile", reason: "a completion receipt exists (cmp-0312); the slot is already released" },
      { op: "fix", reason: "verification has not run" },
      { op: "merge", reason: "no acceptance receipt at the current head" }
    ]
  },
  {
    id: "att_01J9ZF2N6P", wo: "wo-0131", kind: "first", number: 1, fixOf: null,
    session: "ses_5d33c", port: 4166, slot: null, capacity: "released",
    startedAt: "12:48:02Z", queuedAt: null, queueBound: null,
    observedAt: "13:27:40Z", observedFrom: "completion receipt cmp-0309 · runner port 4166",
    facts: { reachable: "yes", prepared: "yes", active: "no", ended: "yes", collected: "yes" },
    lastKnown: null, stale: false,
    receipts: {
      completion: { id: "cmp-0309" },
      verification: { head: "a81f4e2", pass: true },
      acceptance: null,
      decision: { id: "d-0311", door: "one-way", pending: true }
    },
    mergeHead: null, pullRequest: null,
    cost: { steps: 88, minutes: 38, usd: 0.19 },
    legal: [],
    notOffered: [
      { op: "merge", reason: "awaiting decision d-0311 in Waves; silence is not approval" },
      { op: "fix", reason: "nothing to fix: verification and review passed at a81f4e2" },
      { op: "reconcile", reason: "the attempt ended and was collected" }
    ]
  },
  {
    id: "att_01J9ZD5W9K", wo: "wo-0137", kind: "first", number: 1, fixOf: null,
    session: "ses_1b7f2", port: 4166, slot: null, capacity: "released",
    startedAt: "12:30:15Z", queuedAt: null, queueBound: null,
    observedAt: "13:55:20Z", observedFrom: "acceptance receipt acc-0071 · head e5a7c90",
    facts: { reachable: "yes", prepared: "yes", active: "no", ended: "yes", collected: "yes" },
    lastKnown: null, stale: false,
    receipts: {
      completion: { id: "cmp-0304" },
      verification: { head: "e5a7c90", pass: true },
      acceptance: { head: "e5a7c90" },
      decision: null
    },
    mergeHead: "e5a7c90", pullRequest: "#7",
    cost: { steps: 71, minutes: 31, usd: 0.14 },
    legal: ["merge"],
    notOffered: [
      { op: "reconcile", reason: "the attempt ended and was collected" },
      { op: "fix", reason: "nothing to fix at e5a7c90" }
    ]
  },
  {
    id: "att_01J9ZK3Q7V", wo: "wo-0142", kind: "first", number: 1, fixOf: null,
    session: "ses_7f21a", port: 4166, slot: null, capacity: "released",
    startedAt: "12:34:10Z", queuedAt: null, queueBound: null,
    observedAt: "13:19:30Z", observedFrom: "verification receipt vrf-0217 · head 7b2d0aa",
    facts: { reachable: "yes", prepared: "yes", active: "no", ended: "yes", collected: "yes" },
    lastKnown: null, stale: false,
    receipts: {
      completion: { id: "cmp-0305" },
      verification: { head: "7b2d0aa", pass: false },
      acceptance: null,
      decision: null
    },
    mergeHead: null, pullRequest: null,
    cost: { steps: 94, minutes: 38, usd: 0.21 },
    legal: [],
    notOffered: [
      { op: "fix", reason: "a fix attempt is already open: att_01J9ZM8R2C" },
      { op: "merge", reason: "verification failed at 7b2d0aa" },
      { op: "reconcile", reason: "the attempt ended and was collected" }
    ]
  }
];

export function getProjectAttemptCounts(): Array<[string, number]> {
  return Array.from(
    attempts.reduce((map, attempt) => {
      const name = workOrders[attempt.wo].project;
      map.set(name, (map.get(name) ?? 0) + 1);
      return map;
    }, new Map<string, number>())
  ).sort(([a], [b]) => a.localeCompare(b));
}

export const totalAttemptsCount: number = attempts.length;

// ---------------------------------------------------------------------------
// Attempt view types and data
// ---------------------------------------------------------------------------

export interface WorkOrder {
  project: string;
  task: string;
  lane: string;
  base: string;
  policy: string;
  manifest?: Record<string, string>;
}

export interface Receipt {
  id: string;
  at: string;
  head?: string;
  exit?: number;
  pass: boolean;
  text: string;
}

export interface Decision {
  id: string;
  pending: boolean;
  askedAt: string;
  door: "one-way" | "two-way";
  question: string;
  scope: string;
  answer: string | null;
}

export interface Worktree {
  inspectedAt: string;
  commit: string;
  base: string;
  commitsSinceDispatch: number;
  uncommitted: string[];
  untracked: string[];
  residue: string[];
  artifacts: Array<[string, boolean]>;
  stale?: boolean;
}

export interface Cost {
  steps: number;
  minutes: number;
  usd: number;
  note?: string;
}

export interface Brief {
  digest: string;
  frozenAt: string;
  original?: string;
  manifest: Record<string, string>;
  markdown: string;
}

export interface Attempt {
  id: string;
  wo: string;
  kind: "fix" | "first";
  number: number;
  fixOf?: string;
  session: string | null;
  port: number;
  slot: number | null;
  capacity: "pending" | "held" | "released";
  startedAt: string | null;
  queuedAt?: string | null;
  queueBound?: string | null;
  observedAt: string;
  observedFrom: string;
  facts: Facts;
  model: {
    implementer: string;
    fallback: string;
    reviewer: string;
  };
  readiness: Array<[string, boolean, string]> | null;
  worktree: Worktree;
  receipts: {
    completion: Receipt | null;
    verification: Receipt | null;
    review: Receipt | null;
    acceptance: Receipt | null;
    decision: Decision | null;
    merge?: Receipt | null;
  };
  legal: string[];
  notOffered: Array<[string, string]>;
  cost?: Cost;
  brief?: Brief;
  mergeHead?: string;
  pullRequest?: string;
  lastKnown?: {
    at: string;
    facts: Facts;
  };
  withdrawn?: boolean;
  merged?: boolean;
}

export interface Install {
  wavesInboxUrl: string;
}

export interface Capacity {
  host: string;
  port: number;
  slots: number;
}

export interface Fixture {
  loadedAt: string;
  capacity: Capacity;
  install: Install;
  projects: string[];
  workOrders: Record<string, WorkOrder>;
  attempts: Attempt[];
}

export function findAttempt(id: string): Attempt | undefined {
  return ATTEMPT_FIXTURE.attempts.find((a) => a.id === id);
}

export function workOrderOf(a: Attempt): WorkOrder {
  return ATTEMPT_FIXTURE.workOrders[a.wo];
}

export function attemptsOf(wo: string): Attempt[] {
  return ATTEMPT_FIXTURE.attempts.filter((a) => a.wo === wo).sort((x, y) => x.number - y.number);
}

export type Summary = [word: string, note: string, variant: string];

export function summarize(a: Attempt): Summary {
  const R = a.receipts;
  if (a.withdrawn) return ["ended", "withdrawn before a session existed", "ended"];
  if (R.decision && R.decision.pending) return ["blocked", "waiting on decision " + R.decision.id, "blocked"];
  if (a.facts.reachable === "unknown" || a.facts.ended === "unknown")
    return ["unknown", a.lastKnown ? "runner silent since " + a.lastKnown.at : "runner silent", "unknown"];
  if (a.capacity === "pending") return ["queued", "intent recorded · waiting for a slot", "queued"];
  if (a.merged) return ["accepted", "merged at " + a.mergeHead, "accepted"];
  if (R.acceptance) return ["accepted", "accepted at " + R.acceptance.head, "accepted"];
  if (R.verification && !R.verification.pass) return ["failed", "check failed at " + R.verification.head, "failed"];
  if (a.facts.active === "yes")
    return ["active", "running · " + (a.cost ? a.cost.minutes + " lane min" : ""), "active"];
  if (a.facts.ended === "yes")
    return ["ended", a.facts.collected === "yes" ? "ended · collected" : "ended · artifacts not collected", "ended"];
  return ["ended", "ended", "ended"];
}

export const ATTEMPT_FIXTURE: Fixture = {
  loadedAt: "2026-10-13T14:02:10Z",
  capacity: { host: "execution host A", port: 4166, slots: 3 },
  install: { wavesInboxUrl: "#waves-inbox" },
  projects: ["fleet-v2", "waves", "hexagen"],
  workOrders: {
    "wo-0142": {
      project: "fleet-v2",
      task: "Wire the Nitro API route surface (step A)",
      lane: "api-routes-a",
      base: "0da21c4",
      policy: "pol-2026-10-11.3",
    },
    "wo-0139": {
      project: "fleet-v2",
      task: "Worktree inspection as a typed contract",
      lane: "runner-inspect",
      base: "0da21c4",
      policy: "pol-2026-10-11.3",
    },
    "wo-0137": {
      project: "fleet-v2",
      task: "Reconcile runbook fixture and journal replay",
      lane: "journal-replay",
      base: "c69dcaa",
      policy: "pol-2026-10-11.3",
    },
    "wo-0131": {
      project: "waves",
      task: "Relay and host-alert contract beside waves/v1 (W1)",
      lane: "contract-w1",
      base: "4e1a9b0",
      policy: "pol-2026-10-11.3",
    },
    "wo-0128": {
      project: "hexagen",
      task: "Emit adapter bindings from the manifest",
      lane: "bindings-emit",
      base: "b77c3d1",
      policy: "pol-2026-10-11.3",
    },
    "wo-0133": {
      project: "waves",
      task: "Enrol-key rotation runbook fixture",
      lane: "enrol-rotate",
      base: "4e1a9b0",
      policy: "pol-2026-10-11.3",
    },
    "wo-0146": {
      project: "fleet-v2",
      task: "Five-fact observation as a typed port (step C)",
      lane: "facts-port",
      base: "0da21c4",
      policy: "pol-2026-10-11.3",
    },
    "wo-0144": {
      project: "fleet-v2",
      task: "Replace empty route bodies with port types (step B)",
      lane: "api-routes-b",
      base: "0da21c4",
      policy: "pol-2026-10-11.3",
      manifest: {
        "dispatch id": "assigned on dispatch",
        repository: "fleet-v2",
        "base commit": "0da21c4",
        "policy revision": "pol-2026-10-11.3",
        "owned paths": "apps/api/server/routes/**",
        permissions: "read, write inside owned paths; no push, no gh, no ssh, no curl, no sudo",
        "knowledge versions": "from the included rows at freeze",
        bounds: "100 steps · 45 min · 2 cpu · 4 GiB",
        "expected artifacts": ".lane/notes.md, .lane/receipt.json",
        "decision references": "none",
      },
    },
  },
  attempts: [
    {
      id: "att_01J9ZM8R2C",
      wo: "wo-0142",
      kind: "fix",
      number: 2,
      fixOf: "att_01J9ZK3Q7V",
      session: "ses_9c04d",
      port: 4166,
      slot: 2,
      capacity: "held",
      startedAt: "13:41:08Z",
      observedAt: "14:02:04Z",
      observedFrom: "runner port 4166 · session ses_9c04d",
      facts: { reachable: "yes", prepared: "yes", active: "yes", ended: "no", collected: "no" },
      model: { implementer: "glm-5.3 · low", fallback: "laguna-s-2.1", reviewer: "gpt-6-luna" },
      readiness: [
        ["Runner reachable", true, "port 4166 answered in 40 ms"],
        ["Repository", true, "fleet-v2 worktree api-routes-a"],
        ["Base commit", true, "HEAD 7b2d0aa, two commits on base 0da21c4 as the manifest says"],
        ["Toolchain", true, "node 22, yarn 4.12"],
        ["Dependencies", true, "install completed 13:40:51Z"],
        ["Brief", true, "digest matches sha256:4c1e…9a2f"],
        ["Isolation", true, "worktree scope, no egress, 2 cpu, 4 GiB, process-tree stop"],
        ["Completion", true, "runner reports command end"],
        ["Credentials", true, "no key, token or .pgpass readable by the worker"],
        ["Capacity", true, "slot 2 reserved by this attempt; no other session in the worktree"],
      ],
      worktree: {
        inspectedAt: "14:02:04Z",
        commit: "9f3e1c2",
        base: "0da21c4",
        commitsSinceDispatch: 1,
        uncommitted: ["apps/api/server/envelope.ts", "apps/api/server/routes/v1/attempts.get.ts", "apps/api/server/composition.ts"],
        untracked: ["apps/api/server/routes/v1/attempts.get.test.ts"],
        residue: [],
        artifacts: [[".lane/notes.md", false], [".lane/receipt.json", false]],
      },
      receipts: { completion: null, verification: null, review: null, acceptance: null, decision: null },
      legal: ["reconcile", "stop"],
      notOffered: [
        ["collect", "the command has not ended"],
        ["fix", "this attempt is still running"],
        ["merge", "no acceptance receipt at the current head"],
      ],
      cost: { steps: 41, minutes: 21, usd: 0.07 },
      brief: {
        digest: "sha256:4c1e5b0d…9a2f",
        frozenAt: "13:40:12Z",
        original: "sha256:b81a…07d3 (att_01J9ZK3Q7V)",
        manifest: {
          "dispatch id": "dsp_01J9ZM8Q",
          repository: "fleet-v2",
          "base commit": "0da21c4 (branch head 7b2d0aa)",
          "policy revision": "pol-2026-10-11.3",
          "owned paths": "apps/api/**",
          permissions: "read, write inside owned paths; no push, no gh, no ssh, no curl, no sudo",
          "knowledge versions": "k-017 v2, k-023 v1, k-009 v3",
          bounds: "100 steps · 45 min · 2 cpu · 4 GiB",
          "expected artifacts": ".lane/notes.md, .lane/receipt.json",
          "decision references": "none",
        },
        markdown: `# Fix attempt 2 · wo-0142 · api-routes-a\n\nFresh session. The original package is \`sha256:b81a…07d3\`. Do not resume \`ses_7f21a\`; its conversation is not yours.\n\n## On the branch\n- \`lane/api-routes-a\` is at 7b2d0aa, two commits on base 0da21c4.\n- \`apps/api/server/composition.ts\`, \`apps/api/server/envelope.ts\`, \`apps/api/server/routes/v1/*.ts\` were added by attempt 1.\n- Verification at 7b2d0aa failed: \`yarn typecheck\` in \`apps/api\` (receipt vrf-0217).\n\n## Fixes\n1. \`apps/api/server/routes/v1/attempts.get.ts:14\` returns 200 when the outcome is unknown. Return 409 with code \`attempt.unknown\`.\n2. \`apps/api/server/envelope.ts:9\` types \`result\` as \`unknown\`. The envelope is \`{ operationId, code, result: object | null }\`.\n3. \`InspectWorkOrder\` is imported from the package root. Import it from \`@fleet/work-execution/application\`.\n\n## Proof\n- \`yarn typecheck\` in \`apps/api\` passes. Run nothing else in the root.\n- A GET on \`/v1/attempts/att_x\` whose outcome is unknown returns 409.\n- \`GET /\` still returns \`{ status: "ok", app: "api" }\`.\n\n## Bounds\n100 steps, 45 minutes. Owned paths \`apps/api/**\`. Nothing under \`server/\` imports \`node:child_process\`.\n\n## Context selected for this brief\n| Entry | Claim |\n|---|---|\n| k-017 v2 | Nitro routes live under \`server/routes\`; \`srcDir\` is set in \`nitro.config.ts\`. |\n| k-023 v1 | Hexagen regenerates \`*.in-port.ts\`; hand edits are overwritten on sync. |\n| k-009 v3 | Routes must not import \`node:child_process\`; review greps \`server/\`. |\n\nWrite \`.lane/notes.md\` before you stop: one claim per line, with the path it is about.`,
      },
    },
    {
      id: "att_01J9ZK3Q7V",
      wo: "wo-0142",
      kind: "first",
      number: 1,
      session: "ses_7f21a",
      port: 4166,
      slot: null,
      capacity: "released",
      startedAt: "12:34:10Z",
      observedAt: "13:19:30Z",
      observedFrom: "verification receipt vrf-0217 · head 7b2d0aa",
      facts: { reachable: "yes", prepared: "yes", active: "no", ended: "yes", collected: "yes" },
      model: { implementer: "glm-5.3 · low", fallback: "laguna-s-2.1", reviewer: "gpt-6-luna" },
      readiness: null,
      worktree: {
        inspectedAt: "13:12:40Z",
        commit: "7b2d0aa",
        base: "0da21c4",
        commitsSinceDispatch: 2,
        uncommitted: [],
        untracked: [],
        residue: [],
        artifacts: [[".lane/notes.md", true], [".lane/receipt.json", true]],
      },
      receipts: {
        completion: { id: "cmp-0305", at: "13:12:36Z", exit: 0, pass: true, text: "command ended; process group gone; slot 2 released 13:12:40Z" },
        verification: { id: "vrf-0217", at: "13:19:30Z", head: "7b2d0aa", exit: 2, pass: false, text: "verification host L · yarn typecheck in apps/api failed: 3 errors (envelope.ts:9, attempts.get.ts:14, composition.ts:3)" },
        review: null,
        acceptance: null,
        decision: null,
      },
      legal: [],
      notOffered: [
        ["fix", "a fix attempt is already open: att_01J9ZM8R2C"],
        ["merge", "verification failed at 7b2d0aa"],
        ["reconcile", "the attempt ended and was collected"],
      ],
      cost: { steps: 94, minutes: 38, usd: 0.21 },
      brief: {
        digest: "sha256:b81a…07d3",
        frozenAt: "12:33:40Z",
        manifest: { "owned paths": "apps/api/**", bounds: "100 steps · 45 min" },
        markdown: "# wo-0142 · api-routes-a\n\nAdd the composition root, the error envelope and one route file per row of the route table. Each handler calls its use case and maps `Not implemented` to 501.\n\n## Proof\n- `yarn typecheck` in `apps/api`.\n- A request to each new path returns 501. `GET /` still returns ok.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Brief view types and data
// ---------------------------------------------------------------------------

export interface WorkOrderFixture {
  project: string;
  task: string;
  lane: string;
  base: string;
  policy: string;
  unfrozen?: boolean;
  manifest?: Record<string, string>;
}

export interface ProposalFixture {
  id: string;
  v: string;
  kind: "keeper" | "candidate" | "l3";
  claim: string;
  scope: string;
  source: string;
  why: [string, string][];
  include: boolean;
}

export interface FrozenPackageFixture {
  digest: string;
  frozenAt: string;
  manifest: Record<string, string>;
  markdown: string;
  original?: string;
}

export interface BriefFixture {
  loadedAt: string;
  workOrders: Record<string, WorkOrderFixture>;
  frozenPackages: Record<string, FrozenPackageFixture>;
  proposals: ProposalFixture[];
}

export const BRIEF_FIXTURE: BriefFixture = {
  loadedAt: "2026-10-13T14:02:10Z",
  workOrders: {
    "wo-0142": { project: "fleet-v2", task: "Wire the Nitro API route surface (step A)", lane: "api-routes-a", base: "0da21c4", policy: "pol-2026-10-11.3" },
    "wo-0139": { project: "fleet-v2", task: "Worktree inspection as a typed contract", lane: "runner-inspect", base: "0da21c4", policy: "pol-2026-10-11.3" },
    "wo-0137": { project: "fleet-v2", task: "Reconcile runbook fixture and journal replay", lane: "journal-replay", base: "c69dcaa", policy: "pol-2026-10-11.3" },
    "wo-0131": { project: "waves", task: "Relay and host-alert contract beside waves/v1 (W1)", lane: "contract-w1", base: "4e1a9b0", policy: "pol-2026-10-11.3" },
    "wo-0128": { project: "hexagen", task: "Emit adapter bindings from the manifest", lane: "bindings-emit", base: "b77c3d1", policy: "pol-2026-10-11.3" },
    "wo-0133": { project: "waves", task: "Enrol-key rotation runbook fixture", lane: "enrol-rotate", base: "4e1a9b0", policy: "pol-2026-10-11.3" },
    "wo-0146": { project: "fleet-v2", task: "Five-fact observation as a typed port (step C)", lane: "facts-port", base: "0da21c4", policy: "pol-2026-10-11.3" },
    "wo-0144": { project: "fleet-v2", task: "Replace empty route bodies with port types (step B)", lane: "api-routes-b", base: "0da21c4", policy: "pol-2026-10-11.3", unfrozen: true,
      manifest: { "dispatch id": "assigned on dispatch", repository: "fleet-v2", "base commit": "0da21c4", "policy revision": "pol-2026-10-11.3",
        "owned paths": "apps/api/server/routes/**", permissions: "read, write inside owned paths; no push, no gh, no ssh, no curl, no sudo",
        "knowledge versions": "from the included rows at freeze", bounds: "100 steps · 45 min · 2 cpu · 4 GiB",
        "expected artifacts": ".lane/notes.md, .lane/receipt.json", "decision references": "none" } }
  },
  frozenPackages: {
    "wo-0142": {
      digest: "sha256:4c1e5b0d…9a2f", frozenAt: "13:40:12Z", original: "sha256:b81a…07d3 (att_01J9ZK3Q7V)",
      manifest: {
        "dispatch id": "dsp_01J9ZM8Q", repository: "fleet-v2", "base commit": "0da21c4 (branch head 7b2d0aa)", "policy revision": "pol-2026-10-11.3",
        "owned paths": "apps/api/**", permissions: "read, write inside owned paths; no push, no gh, no ssh, no curl, no sudo",
        "knowledge versions": "k-017 v2, k-023 v1, k-009 v3", bounds: "100 steps · 45 min · 2 cpu · 4 GiB",
        "expected artifacts": ".lane/notes.md, .lane/receipt.json", "decision references": "none"
      },
      markdown: `# Fix attempt 2 · wo-0142 · api-routes-a

Fresh session. The original package is \`sha256:b81a…07d3\`. Do not resume \`ses_7f21a\`; its conversation is not yours.

## On the branch
- \`lane/api-routes-a\` is at 7b2d0aa, two commits on base 0da21c4.
- \`apps/api/server/composition.ts\`, \`apps/api/server/envelope.ts\`, \`apps/api/server/routes/v1/*.ts\` were added by attempt 1.
- Verification at 7b2d0aa failed: \`yarn typecheck\` in \`apps/api\` (receipt vrf-0217).

## Fixes
1. \`apps/api/server/routes/v1/attempts.get.ts:14\` returns 200 when the outcome is unknown. Return 409 with code \`attempt.unknown\`.
2. \`apps/api/server/envelope.ts:9\` types \`result\` as \`unknown\`. The envelope is \`{ operationId, code, result: object | null }\`.
3. \`InspectWorkOrder\` is imported from the package root. Import it from \`@fleet/work-execution/application\`.

## Proof
- \`yarn typecheck\` in \`apps/api\` passes. Run nothing else in the root.
- A GET on \`/v1/attempts/att_x\` whose outcome is unknown returns 409.
- \`GET /\` still returns \`{ status: "ok", app: "api" }\`.

## Bounds
100 steps, 45 minutes. Owned paths \`apps/api/**\`. Nothing under \`server/\` imports \`node:child_process\`.

## Context selected for this brief
| Entry | Claim |
|---|---|
| k-017 v2 | Nitro routes live under \`server/routes\`; \`srcDir\` is set in \`nitro.config.ts\`. |
| k-023 v1 | Hexagen regenerates \`*.in-port.ts\`; hand edits are overwritten on sync. |
| k-009 v3 | Routes must not import \`node:child_process\`; review greps \`server/\`. |

Write \`.lane/notes.md\` before you stop: one claim per line, with the path it is about.`
    },
    "wo-0128": {
      digest: "sha256:77d0…c41b", frozenAt: "13:52:01Z",
      manifest: { "owned paths": "packages/emit/**", bounds: "100 steps · 45 min" },
      markdown: "# wo-0128 · bindings-emit\n\nEmit `adapter_bindings` from the manifest into the composition root stubs.\n\n## Proof\n- `yarn sync:check` reports no drift."
    },
    "wo-0139": {
      digest: "sha256:0a9e…d2f7", frozenAt: "13:22:10Z",
      manifest: { "owned paths": "packages/work-execution/**", bounds: "100 steps · 45 min" },
      markdown: "# wo-0139 · runner-inspect\n\nType the worktree inspection on the runner port: checked-out commit, uncommitted and untracked changes, residue from earlier attempts, artifact presence. A record, not prose.\n\n## Proof\n- `yarn typecheck` in `packages/work-execution` passes.\n- One unit test builds the record from a fixture directory."
    },
    "wo-0133": {
      digest: "sha256:e3b0…1f44", frozenAt: "13:59:50Z",
      manifest: { "owned paths": "docs/runbooks/**", bounds: "60 steps · 30 min" },
      markdown: "# wo-0133 · enrol-rotate\n\nWrite the fixture for the enrol-key rotation runbook. No token in the fixture."
    },
    "wo-0146": {
      digest: "sha256:9d10…aa07", frozenAt: "13:53:30Z",
      manifest: { "owned paths": "apps/api/**", bounds: "60 steps · 30 min" },
      markdown: "# wo-0146 · facts-port\n\nType the five-fact observation as a port: reachable, prepared, active, ended, collected — each yes, no or unknown, with the time observed and the source that reported it.\n\n## Proof\n- `yarn typecheck` in `apps/api` passes."
    },
    "wo-0131": {
      digest: "sha256:91ac…55e0", frozenAt: "12:47:30Z",
      manifest: { "owned paths": "packages/contract/**", bounds: "100 steps · 45 min", "decision references": "W1 (pending)" },
      markdown: "# wo-0131 · contract-w1\n\nAdd the relay and host-alert resource types beside `waves/v1`. Keep `waves/v1` intact.\n\n## Proof\n- Existing `waves/v1` fixtures unchanged.\n- One fixture per new type.\n\n## Door\nThis is a new contract type (W1). The merge needs a signed decision; do not assume it."
    },
    "wo-0137": {
      digest: "sha256:5f2c…8ab1", frozenAt: "12:29:40Z",
      manifest: { "owned paths": "packages/work-execution/**, docs/runbooks/reconcile-an-attempt.md", bounds: "100 steps · 45 min" },
      markdown: "# wo-0137 · journal-replay\n\nA fixture that kills the controller between reserve and dispatch, restarts it, and proves reconciliation does not dispatch twice.\n\n## Proof\n- The journal holds one intent record.\n- A second reconcile prints the same session id."
    }
  },
  proposals: [
    { id: "k-017", v: "v2", kind: "keeper", claim: "Nitro routes live under server/routes; srcDir is set in nitro.config.ts, so src/routes never registers.", scope: "fleet-v2 · apps/api/**", source: "att_01J9ZB2… @ 3c9f0d1", why: [["paths", "apps/api/**"], ["task", "route, body"]], include: true },
    { id: "k-009", v: "v3", kind: "keeper", claim: "Nothing under server/ imports node:child_process; the pre-merge review greps for it.", scope: "fleet-v2 · apps/api/server/**", source: "att_01J9Z9… @ eccc98b", why: [["paths", "apps/api/server/**"]], include: true },
    { id: "k-023", v: "v1", kind: "keeper", claim: "Hexagen regenerates *.in-port.ts and *.out-port.ts; hand edits are overwritten by yarn sync.", scope: "shared · packages/*/src/**/ports/**", source: "att_01J9Z7… @ eccc98b", why: [["symbol", "InspectWorkOrder, RegisterWorkOrder"], ["task", "port types"]], include: true },
    { id: "c-042", v: "—", kind: "candidate", claim: "Turbo runs typecheck without ^build; the context packages need dist/ first or apps/api fails to resolve them.", scope: "fleet-v2 · turbo.json", source: "att_01J9ZK3Q7V @ 7b2d0aa", why: [["environment", "turbo pipeline"], ["unchecked", "candidate, not a keeper"]], include: false },
    { id: "k-031", v: "v1", kind: "keeper", claim: "yarn lint:arch fails when a supplier context imports an execution aggregate.", scope: "fleet-v2 · packages/**", source: "att_01J9Z8… @ eccc98b", why: [["task", "port types (weak)"]], include: false },
    { id: "p-003", v: "—", kind: "l3", claim: "Lanes cannot push or use gh, ssh, curl or sudo; the orchestrator fetches and opens the pull request.", scope: "operating profile · link, not policy text", source: "pol-2026-10-11.3", why: [["profile", "lane permissions"]], include: true }
  ]
};

// ---------------------------------------------------------------------------
// Knowledge view types and data
// ---------------------------------------------------------------------------

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