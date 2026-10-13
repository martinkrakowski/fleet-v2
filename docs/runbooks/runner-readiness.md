# Runbook: runner readiness

*Date: 2026-10-13 · Status: draft, not a tool · Owner decision: pending*

Checklist recorded once for a prepared workspace, before `DispatchAttempt`. From `docs/planning/2026-10-13_execution-kernel.md`. A failed line stops the dispatch. It does not ask a model to finish setup, and it does not put a provider key in the workspace.

## Checklist

| Check | Pass |
|---|---|
| Runner reachable | The port for this attempt answers |
| Repository | The worktree is the named checkout |
| Base commit | HEAD is the commit in the brief manifest |
| Toolchain | The manifest's toolchain is on PATH |
| Dependencies | Install completed, or the manifest says none are required |
| Brief | The frozen package is in the ignored worktree path and its digest matches |
| Isolation | The runner's capability profile covers filesystem scope, egress, CPU, memory, and process-tree stop |
| Completion | The runner can report command end, not only that the control process is up |
| Credentials | No key, token, or `.pgpass` is in the worktree or the environment the worker can read |
| Capacity | This attempt holds the reservation. The worktree has no other active session |

## Record

Write one readiness receipt: attempt id, environment digest, each line pass or fail, time. Dispatch only when every line passes.

## Not this runbook

A goal-driven container bootstrap, a vendor key in the guest, or treating "runner process is up" as "the lane finished".
