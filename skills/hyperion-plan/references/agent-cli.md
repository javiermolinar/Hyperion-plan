# Agent CLI commands

Use the bundled `node SKILL_DIR/dist/plan.cjs` from any directory. All commands require an explicit absolute `--plan` path, except help. Read commands, mutations, and previews emit JSON; `render`, `export`, and `review-brief` print their output path. Errors go to stderr with a nonzero exit status.

Use stable step/note IDs. Displayed numbers change when tasks move. `COMMAND --help` lists that command's options; `step --help` and `note --help` list their subcommands.

## Read and choose work

```sh
node SKILL_DIR/dist/plan.cjs show --plan PLAN_MD
node SKILL_DIR/dist/plan.cjs show --plan PLAN_MD --step-id STEP_ID
node SKILL_DIR/dist/plan.cjs next --plan PLAN_MD
```

`show` returns the full plan or one full step, including description, acceptance criteria, notes, and checks. Private request receipts are omitted. `next` returns `ready_steps`, `in_progress_steps`, `blocked_steps` with reasons, and `unselected_step_ids`. It follows plan order and requires every prerequisite to be completed before reporting a step ready. Including an unfinished prerequisite in the approved selection does not make its dependent ready now. Paused/cancelled scope, blockers, and freshness warnings prevent readiness. These commands never authorize or start work; the current user request and collaboration mode still govern whether to proceed.

`show` and `next` do not write files or acquire a filesystem lock. If Markdown differs from its bookkeeping, they reconcile a snapshot in memory and report `refresh_required: true`. Run `status --plan PLAN_MD` to persist that refresh before continuing; `next` withholds ready work until then. `status` retains its existing refresh behavior, so use `show` for strictly read-only inspection. Concurrent changes detected during a Markdown read produce an error; retry the read.

## Finish and reopen

```sh
node SKILL_DIR/dist/plan.cjs finish --plan PLAN_MD --base-revision REV
node SKILL_DIR/dist/plan.cjs reopen --plan PLAN_MD --base-revision REV
```

`finish` records `lifecycle: "finished"` in Markdown metadata and clears execution approval. It preserves all steps, statuses, notes, and blockers, so a finished plan can contain unfinished work. `status` reports `render_policy: "on_request"`; confirm closure in text without rendering a card. Ordinary follow-ups stay outside that plan. Explicit inspection may render it without reactivating it.

`reopen` records `lifecycle: "active"` without restoring old approval. A fresh implementation selection is required. Use these commands for an explicit finish/reopen request, not because a batch ended. Both require the current revision, support `--dry-run`, and return `unchanged` when already in that state. Older files without lifecycle remain active. Finished plans reject other agent mutations and new card requests until reopened; read/export commands remain available.

Card lifecycle requests use `apply` with `intent: "finish"` or `"reopen"` and normal idempotent receipts. Finish may include edits; reopen cannot. Neither accepts selected work or planning targets. Identical request retries preserve the current state even if the plan has since reopened or finished again.

## Focused step edits

All commands below require `--base-revision REV` from the latest saved plan. They use the same scope comparison as `revise`, preserving unrelated steps, receipts, and paused/cancelled execution state. Content changes revoke the affected step's approval and mark unfinished changed steps and dependents for freshness review. A freshness check does not restore approval. Adding a step never selects it for implementation. Identical edits leave the revision unchanged.

```sh
node SKILL_DIR/dist/plan.cjs step add --plan PLAN_MD --base-revision REV --step-id NEW_ID --title 'Add a regression check' --after EXISTING_ID
node SKILL_DIR/dist/plan.cjs step update --plan PLAN_MD --base-revision REV --step-id STEP_ID --done-when 'The regression check passes'
node SKILL_DIR/dist/plan.cjs step update --plan PLAN_MD --base-revision REV --step-id STEP_ID --input FIELDS_JSON
node SKILL_DIR/dist/plan.cjs step move --plan PLAN_MD --base-revision REV --step-id STEP_ID --before TARGET_ID
node SKILL_DIR/dist/plan.cjs step remove --plan PLAN_MD --base-revision REV --step-id STEP_ID
```

`add` appends by default; use either `--before` or `--after` to choose placement. `move` requires one of those options and only accepts pending steps. It preserves active/completed records and their relative order, rejects prerequisite inversions, and leaves a review's `run_after` and inspected scope unchanged. `remove` rejects active/completed rows and steps referenced by remaining work. Replan dependencies explicitly before removing a referenced task.

`add` and `update` accept `--title`, `--description`, and `--done-when`. Structured `--input` accepts a JSON object of these fields:

- `title`, `short_title`, `milestone`, `description`, `done_when`
- `depends_on` (array of stable IDs)
- `complexity`, `complexity_reason`, `estimated_files`, `estimate_note`, `scope_warning`
- `checks`, `run_after` for review steps; active/completed reviews retain their scope and timing
- `kind` only when adding a step

Text flags override the matching JSON fields. Omitted fields retain their values; use empty text or an empty prerequisite array to clear those values. Usual model limits and review/dependency validation apply. Set a review's placement separately if changing `run_after` would put it before its timing anchor; use an atomic whole-plan revision when the combined edit requires it.

For example, to add a review, supply `--input` containing:

```json
{
  "title": "Review API compatibility",
  "kind": "review",
  "depends_on": ["api"],
  "run_after": "integration",
  "checks": ["Verify both clients retain their existing behavior."]
}
```

Pass its new ID with `--step-id` and place it after `integration`. Step inputs cannot change identity, status, execution approval, comments, progress, or freshness fields. Use `checkpoint` for observed progress, `review` for plan freshness, and the note commands for comments. Use `revise` for coordinated decomposition or changes spanning multiple steps. Use `apply` unchanged for explicit card submissions and their idempotent request receipts.

## Notes and replies

```sh
node SKILL_DIR/dist/plan.cjs note add --plan PLAN_MD --base-revision REV --step-id STEP_ID --note-id NEW_NOTE_ID --text 'Keep the existing API compatible'
node SKILL_DIR/dist/plan.cjs note reply --plan PLAN_MD --base-revision REV --step-id STEP_ID --note-id NOTE_ID --text-file RESPONSE_TXT
```

Use exactly one of `--text` or `--text-file`. Prefer a UTF-8 text file for multiline content and shell-sensitive text. Notes allow 1,000 characters and replies 2,000. IDs are explicit; duplicate note IDs are rejected. `reply` retains the original note text, stores the response, and marks the note acknowledged. Reply only after addressing its substance. These targeted note edits use revision scope invalidation; they do not silently retain approval for changed notes or responses.

## Preview, save, and refresh

Add `--dry-run` to `init`, `apply`, `revise`, `checkpoint`, `review`, `finish`, `reopen`, or any `step`/`note` command. It validates the proposed operation and returns `result: "preview"`, `would_change`, `proposed_revision`, `refresh_required`, and `changes`. The changes show plan fields, added/removed/updated steps, order, and execution scope before and after. No plan, receipt, export, recovery copy, directory, or lock is written. A preview is not a save or approval; all revision and authorization checks still apply.

Dry runs are useful for examining the effect of a change; they do not add a user approval requirement to already authorized work. To save, repeat the same command without `--dry-run` using the still-current revision. Use the revision returned by each successful write for the next edit. If a targeted edit fails as stale, inspect the current plan and reconcile by IDs. Do not blindly retry with a newer revision; check whether the intended change was already applied. Card requests retain their existing `apply` idempotency behavior.

After meaningful saved changes to an active plan, render with `render --plan PLAN_MD --output NEW_CARD_HTML` and show that card following the skill lifecycle. Published cards bundle the renderer used at creation. A new skill installation fixes new cards; it does not update earlier cards automatically.

## Independent plan review records

`plan-review --plan PLAN_MD --base-revision N --input UPDATE_JSON` records progress and findings for an applied independent plan-review request. See [Independent plan review](plan-review.md) for the update format, fresh-task workflow, and reconciliation rules. It preserves implementation authority and rejects stale writes.
