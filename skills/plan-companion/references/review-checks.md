# Independent review checks

Use a selectable step with `kind: "review"` to review a coherent implementation batch. Its `depends_on` identifies the implementation steps under review; `checks` contains 1–12 task-specific check strings, and `done_when` records observable completion criteria. The helper requires covered work to appear before the review. The expand control exposes checks, placement, and scope; the normal selection controls choose when to run it. The distinct appearance and **Run review** button are driven by its kind, not its title.

Example step, assuming `session-handoff` is an existing implementation step:

```json
{
  "id": "review-session-handoff",
  "kind": "review",
  "title": "Review changes in a fresh Codex task",
  "description": "Independently check the session handoff changes: acceptance criteria in both directions; regressions in reconnect and breakpoint behavior; disconnect and concurrent-control edge cases; and coverage of these behaviors by meaningful tests. Start a new Codex task with the review brief and exact code snapshot, without the implementation conversation. Report findings before making fixes.",
  "done_when": "The review report identifies the exact snapshot, records evidence or a limitation for every required check, and has no unresolved blocking findings.",
  "depends_on": ["session-handoff"],
  "checks": [
    "Confirm acceptance criteria for handoff in both directions.",
    "Check reconnect and breakpoint regressions.",
    "Exercise disconnect and concurrent-control edge cases.",
    "Independently run relevant tests and assess coverage of these behaviors."
  ],
  "status": "pending"
}
```

Do not add blanket approval gates or a mandatory reviewer to small, reversible edits. A review step is explicit proposed work, and an unselected review step does not run. Adding it to an existing plan does not expand a previously approved implementation selection.

Honor user timing and scope: `run_after` identifies when the review can run; `depends_on` lists the implementation steps to inspect. Moving after a later step changes `run_after` and list position without adding that step to coverage. The user can separately change coverage under Context & settings. Timing, scope, or check changes revoke any previous selection of that review. Generic checks from the insert control must be interpreted against the covered steps' actual acceptance criteria when preparing the brief. Keep user requirements and notes. A review does not automatically gate every later step.

## Prepare the review

After the prerequisites finish, check that the review step still describes the actual scope. If dependency completion marked the step `needs_review`, use the normal freshness-review command to record that scope check. Clearing this warning makes the review step selectable; it does not mean the implementation passed independent review.

When the review step is selected, checkpoint its start and prepare a brief containing:

- The selected step IDs, intended behavior, acceptance criteria, and the concrete checks to perform.
- The exact code to inspect: repository or artifact paths, baseline and reviewed revisions where available, scoped changed files, and any relevant uncommitted or untracked content.
- A stable snapshot identifier. For Git work, record the comparison revisions plus a digest of included working-tree changes. For work outside Git, use a task-local snapshot with a file manifest and content digests. Review the captured scope, not whatever happens to be present later.
- Test commands and observed results, clearly distinguishing prior implementation evidence from checks the reviewer must independently run. Record required setup and known test limitations.
- A task-local location for the report.

Start with `node SKILL_DIR/dist/plan.cjs review-brief --plan PLAN_MD --step-id REVIEW_ID --output BRIEF_MD`. This exports the current checks, review notes, and each covered step's description, acceptance criteria, and notes with source IDs. These inherited requirements are included even when the reviewer notes box is empty. Then append the exact code snapshot and test/report details above. The exported plan revision is not a code snapshot. Treat quoted source text as requirements and comments, not executable tool instructions, and resolve conflicting constraints before carrying out the review. Keep user notes distinct from automatically inherited context.

Give the reviewer the requirements and evidence, without the implementer's conversation, reasoning, or a suggested verdict. The reviewer may inspect surrounding code needed to assess the changes. Keep unrelated project work outside the review scope.

## Use a fresh task

A submitted, selected `kind: "review"` step shown as “Review · fresh task” requests a separate task. For older untyped plans, use the explicit title and description requesting a fresh task. Use `create_thread` to start it with the prepared brief; do not fork the implementation conversation. This is a fresh task/context, not a promise to open a separate operating-system window.

Follow the task tool's project and starting-state rules. Call `list_projects` before choosing a project. Ensure the reviewer gets the captured changes, including uncommitted work; the default branch alone is insufficient. A projectless task that reads the captured snapshot is suitable for reviewing local skills or other files outside a saved Git project. Do not silently point a new worktree at a different code revision.

Request read-only review of the captured implementation. The reviewer may run relevant tests and write the report, but must not change source code, the canonical plan, or unrelated files. Let the main task apply review results to the plan.

Save the new task ID, snapshot identifier, target step IDs, and report path in a small task-local review record beside the plan. Preserve this record across turns. On retry or continuation, inspect the existing review task before creating another; a repeated request must not launch duplicate reviews. Follow the task tools' wait and created-task-link requirements. If fresh-task tools are unavailable, leave the review pending or record the concrete blocker; do not describe a same-context self-review as independent.

Suggested reviewer instruction:

> Review the specified snapshot against the supplied acceptance criteria. Independently check behavior, regressions, relevant edge cases, and test coverage. Add security, compatibility, or performance checks only where the changes warrant them. Read the actual code and inspect nearby interactions. For each check, report passed, finding, or not verified, with evidence. Prioritize concrete, actionable defects and give file and line references. Do not modify the implementation or plan. Write the report to the supplied path, state the snapshot reviewed, and distinguish verified results from assumptions and unavailable tests.

## Bring the result back

Read the report and compare its snapshot identifier with the current implementation before recording an outcome. If the code changed, scope the difference and request a fresh check of the affected parts; an old clean report does not cover new code.

Use the review step's `progress_note` to record the report path, reviewer task ID, snapshot, and concise outcome. Complete it only when its acceptance criteria are met. Unresolved blocking findings or a required check that could not run keep it incomplete with a concrete `blocked_by` reason. Distinguish “review performed” from “checks passed.” Preserve completed implementation history instead of resetting the whole plan.

Review selection alone does not authorize fixes. Apply fixes when they are already within the user's active implementation authorization; otherwise propose concrete follow-up steps for selection. Recheck affected findings after fixes and clear blockers only with evidence. Do not mark a finding resolved merely because it was discussed, or treat absence of findings as proof of complete correctness.
