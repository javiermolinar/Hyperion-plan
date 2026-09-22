# Independent plan review

An explicit `intent: "review", review_mode: "independent"` request authorizes one fresh review task and reconciliation into the canonical plan. It does not authorize implementation. Ordinary `review` requests remain same-context freshness checks.

## Capture and dispatch

1. Apply the exact request with `apply`. Read `show` and find the `plan_reviews` record by `request_id`. A retry returns the same record: inspect its existing task before dispatching anything. Never launch a second reviewer for that request. If a launch outcome is uncertain, recover the task ID from task history rather than blindly retrying.
2. Capture the resulting plan at the record's `revision` into a task-local immutable review brief beside the canonical plan. Include the selected IDs plus prerequisite and downstream context, original user requirements separately from the proposed approach, acceptance criteria, constraints, and `review_focus`. Do not invent missing original requirements: label those limitations. Include relevant repository paths, Git revision and working-tree changes (or a file manifest for non-Git work). Save this brief and the intended report path before launching.
3. Use `list_projects` and `create_thread` to launch a fresh task, not a fork. The submitted action explicitly requests this task. Follow project and starting-state rules; ensure it can read the actual captured code including local changes. Use a projectless task reading captured files when appropriate. Do not pass the main conversation or a suggested verdict. If tools are unavailable, record `blocked` with a concrete reason.
4. Immediately record `running`, the returned `task_id`, and report path with `plan-review`. A queued `clientThreadId` is not a task ID: resolve task setup before recording running or using task APIs. Follow the created-task link and bounded waiting requirements. Render the refreshed card when reporting progress; status is agent-mediated, not live polling in the card.

Reviewer instruction:

> Perform one bounded, read-only review of the supplied plan snapshot. First identify constraints and failure cases from the original requirements and relevant code; then challenge the proposed approach, completeness, architecture, sequencing, dependencies, and acceptance criteria. Respect the requested scope and focus. Report concrete findings tied to target step IDs (or no IDs for plan-wide findings), their impact, evidence, and suggested corrections. Agreement with evidence is valid; do not invent findings. State the exact plan revision and code snapshot, checks performed, and limitations. Write the report to the supplied path. Do not create a Hyperion plan, edit the canonical plan or implementation, launch another reviewer, or recursively request review. The main task owns reconciliation.

## Reconcile into the same plan

Read the report and compare its captured plan and code with the current state. If they changed, assess the differences explicitly; findings do not automatically cover new work. Preserve the original reviewed revision. Request another review only on explicit user instruction; do not start an automatic review loop.

Apply straightforward, supported plan corrections through existing revision/step commands, preserving stable IDs, completed history, unrelated decisions, and reviewer records. Plan edits have their usual scope-invalidation rules; review never grants new implementation approval. Leave consequential unresolved choices for the user. Do not change completed implementation history to represent planned fixes.

For every finding record `applied`, `not_adopted` with a reason, or `needs_input` with the decision needed. Only mark applied after saving its plan change. Clear freshness warnings only after actual checks. Record `completed` when the report has been read and findings reconciled, even if some need input: completion means review performed, not plan approved. Record a note with coverage and limitations even when there are no findings.

Use a JSON file and the current canonical revision:

```sh
node SKILL_DIR/dist/plan.cjs plan-review --plan PLAN_MD --base-revision CURRENT_REVISION --input UPDATE_JSON
```

Running update:

```json
{"request_id":"REQUEST_ID","state":"running","task_id":"TASK_ID","report_path":"/absolute/task/report.md"}
```

Completed update (all findings are replaced together; other omitted fields are preserved):

```json
{"request_id":"REQUEST_ID","state":"completed","note":"Reviewed the captured requirements and migration sequencing; runtime behavior was not tested.","findings":[{"step_ids":["migration"],"text":"The rollback strategy is unspecified.","resolution":"needs_input","reason":"Choose whether the migration must remain reversible after writes begin."}]}
```

Use `blocked` and `note` for a failed/unavailable reviewer. Preserve the original task ID when resuming. Use `show` to inspect records. Records persist in canonical Markdown and survive whole-plan revisions; only `plan-review` updates their outcomes. Refresh the card after reconciliation. Never create another canonical plan or turn this review into an implementation checklist step.
