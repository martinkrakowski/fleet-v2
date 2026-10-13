/**
 * Local fixture for the Brief view, copied from the draft page
 * docs/planning/2026-10-13_waves-dashboard.html (`FIXTURE`).
 * Every value here is a sample; nothing reaches a runner or the API.
 */

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

export const FIXTURE: BriefFixture = {
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
