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
