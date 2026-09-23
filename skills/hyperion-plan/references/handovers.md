# Continue in fresh context

A context handover keeps one canonical plan and transfers execution to a fresh Codex task. It avoids carrying the full conversation into the next context. It is not a conversation fork, a new plan, a prediction of compaction, or new implementation approval. This version is manual and agent-mediated: no context-usage monitor or automatic pre-compaction hook is installed. Actual latency savings are not guaranteed.

## Suggested boundaries and actual events

Use optional step metadata `handover_after` with a short reason to suggest a boundary after a coherent batch. Add it through `step update --input` or the card's “Mark handover point after this” action. It is advisory and does not alter dependencies, execution approval, progress, or freshness. Do not mark every step or predict token usage from file counts. Reassess the suggestion when the plan changes.

The card's “Continue in fresh task” action sends `intent: "handover"`, optional `handover_reason`, and zero or one `target_step_ids`, plus pending edits. A target in progress records an event **during** the step; a completed target records **after** it; no target records **between** steps. A pending step cannot be used as an actual handover location. The helper preserves all step IDs, statuses, and unchanged approvals. The event remains history even if a future plan edit removes a formerly referenced pending/reopened step.

If handover becomes necessary midway through work, checkpoint the observed partial result while the source still owns execution, then submit/apply a handover request for that in-progress step. This is allowed under an existing explicit user instruction to hand work to a fresh task; a marker alone does not authorize task creation. If compaction already occurred, record that fact in the reason rather than claiming it was avoided.

## Prepare, dispatch, transfer

1. Read `status`/`show` for the exact canonical path. Check `execution_owner` before any mutation. If set, only that task may write: pass its actual task ID with `--task-id` (or use `CODEX_THREAD_ID` when the runtime supplies it). Never impersonate another task by supplying its ID. An old card can be inspected but does not reclaim ownership. Direct the user to the owning task if their request arrived elsewhere. This is a cooperative workflow guard, not a security boundary against direct file edits.
2. Apply the exact handover request. A retry returns its existing receipt and event: inspect it before creating anything. One unresolved handover is allowed. While requested, prepared, or blocked, implementation selection/checkpoints are held; existing approval and status remain intact. User pauses/cancellations of execution still apply.
3. Prepare a small, concrete record beside the plan. Capture source task ID, repository/checkout path, Git revision, uncommitted/untracked work, tests already run and results, partial work, blockers, decisions and next action. Include original requirements not already in the plan and active review task IDs, snapshot/report paths, and reconciliation status. Include running processes if relevant; settle source-owned writers before transfer. Keep the brief concise and use links to durable evidence rather than copying the transcript.
4. Save preparation through the helper, then export the brief to the recorded absolute path. The record's digest ties preparation to the plan's requirements, progress, approvals, and reviews. Administrative handover writes do not change that digest. The export includes current plan context; append only necessary missing requirements/evidence. The source must separately verify code has not changed; a plan digest does not hash the checkout.

```sh
node SKILL_DIR/dist/plan.cjs handover --plan PLAN_MD --base-revision N --task-id SOURCE_ID --input PREPARE_JSON
node SKILL_DIR/dist/plan.cjs handover-brief --plan PLAN_MD --request-id REQUEST_ID --output /absolute/task/handover.md
```

Preparation JSON:

```json
{"request_id":"REQUEST_ID","state":"prepared","brief_path":"/absolute/task/handover.md","summary":"Migration logic written. Rollback validation is pending.","next_action":"Run rollback tests, then continue only approved unfinished steps.","code_state":"Checkout /absolute/repo, HEAD COMMIT; local changes in migration.go. Unit checks passed; rollback test not run."}
```

5. Use `list_projects` and `create_thread` to start a **fresh task**, not `fork_thread`. The handover action explicitly requests the new task on the **same saved checkout**, so select `environment: {type: "local"}` for that saved project. Keep the exact canonical Markdown and sidecar paths; do not initialize or migrate another plan. If no matching saved project exists, a projectless task may access the same absolute paths only when that environment supports them. If it cannot, mark the event blocked and explain the limitation; do not silently move work to another checkout.
6. Give the destination the canonical plan path, skill path, handover request ID, brief path, source task ID, and actual checkout. Its initial prompt must be **read-only readiness checking**: read the brief, current plan, and relevant code; report ready or a concrete blocker, then stop. Do not execute merely because approved steps exist. Do not recursively hand off, create another plan, or start a second reviewer. This split prevents concurrent writers before task identity is recorded.
7. Immediately save the returned destination task ID via a `prepared` update, preserving existing fields. A `clientThreadId` from queued setup is not a task ID: recover setup's actual task ID first. Persist the queued identifier in `note` while waiting. On uncertain creation, inspect task/history state and recover the existing destination; never blindly dispatch another. Follow created-task link requirements. Use bounded `wait_threads` to receive readiness.
8. Re-read the plan and verify both tasks refer to the same canonical path and checkout, existing approval still applies, and no source-owned writers are running. If the plan or code changed, refresh preparation/brief and ask the **same destination** to verify the new context. Transfer only after a ready response. Record ownership using the latest revision:

```json
{"request_id":"REQUEST_ID","state":"transferred","destination_task_id":"DESTINATION_ID"}
```

```sh
node SKILL_DIR/dist/plan.cjs handover --plan PLAN_MD --base-revision N --task-id SOURCE_ID --input TRANSFER_JSON
```

9. After the transfer save succeeds, the source must stop implementation. Send the destination one follow-up authorizing it to continue the previously approved remaining work, subject to the current lifecycle, execution state, collaboration mode, and user instructions. If there is no approved work, it should show the plan and wait for selection. A paused/cancelled scope stays paused/cancelled. The destination re-reads `execution_owner`, confirms it matches its actual ID, checks code state, and continues with `--task-id DESTINATION_ID`. A lost wakeup can be retried on the same task after inspecting its status; it does not require another handover.
10. Show the transferred event and destination link in the source task. Do not wait in the old task for the whole implementation to finish; that would defeat the context transfer. Subsequent progress belongs in the destination and same canonical plan. Source task history remains available for reference; do not archive it automatically.

## Failure and recovery

Use `handover --input` with `{ "request_id": "...", "state": "blocked", "note": "Concrete failure" }` for an unavailable destination/tool. Preserve any known destination ID and brief. Resume by preparing and contacting the same destination. Use `cancelled` with a reason only when abandoning an incomplete transfer; stop any launched read-only destination and retain source ownership. Cancelling the handover does not approve, resume, or cancel implementation itself.

Transferred/cancelled events are immutable. A new handover requires a new explicit request. Never rewrite an event to make a failed transfer look successful, reset an interrupted step to pending, or mark it complete because another task took over. Whole-plan revisions retain handover history and owner. CLI mutations check the owner, and stale revisions are rejected. Direct Markdown edits bypass actor identity, so agents must always honor the workflow even when editing files.
