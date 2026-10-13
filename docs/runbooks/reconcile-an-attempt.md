# Runbook: reconcile an attempt

*Date: 2026-10-13 · Status: draft, not a tool · Owner decision: pending*

Use after the execution kernel can persist intent. Until then, the live check is `ocm-run --status` on that attempt's port. This runbook does not replace that command.

## When

The local client died, the API caller disconnected, or the controller restarted after it had reserved capacity.

## Steps

1. Read the journal. If there is no intent record, do not dispatch.
2. If the intent has no session id, ask the runner whether a session exists for that attempt on that port.
3. If the runner cannot be read, record unknown. Do not free capacity. Do not dispatch again. Do not ingest notes. Do not accept the attempt.
4. If a session is active, attach the observation. Do not start another session in that worktree.
5. If the runner reports the command ended, write the completion receipt (attempt id, port, session id, exit). Then collect artifacts and compare commits to the tip recorded before dispatch.
6. Release capacity only after the receipt says the command ended and the process group is gone.
7. A quota or permission refusal is a terminal refusal, not a return to the queue.

Steps 6 and 7, and silence-as-"no answer" in the first-run demonstration, are open owner decisions, not settled rules. They remain pending owner decision before any runbook moves from draft to tool.

## Proof

Killing the local watcher of a `--detach` dispatch leaves the server session running. A second reconcile prints the same session id and does not create a new one.

## Not this runbook

Merging, pushing, or declaring a green check. Those need their own receipts, re-read at the current head.
