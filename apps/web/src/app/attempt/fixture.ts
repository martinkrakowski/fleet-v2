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

export interface Facts {
  reachable: "yes" | "no" | "unknown";
  prepared: "yes" | "no" | "unknown";
  active: "yes" | "no" | "unknown";
  ended: "yes" | "no" | "unknown";
  collected: "yes" | "no" | "unknown";
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

export function findAttempt(id: string): Attempt | undefined {
  return FIXTURE.attempts.find((a) => a.id === id);
}

export function workOrderOf(a: Attempt): WorkOrder {
  return FIXTURE.workOrders[a.wo];
}

export function attemptsOf(wo: string): Attempt[] {
  return FIXTURE.attempts.filter((a) => a.wo === wo).sort((x, y) => x.number - y.number);
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

export const FIXTURE: Fixture = {
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
