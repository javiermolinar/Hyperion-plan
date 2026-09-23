# Markdown storage

The canonical plan is `plan.md`. Readable task text appears only there. Generated HTML and PR notes are views; `plan.state.json` stores receipts, execution scope, revisions, the source digest, and per-step status/hash bookkeeping. It contains no duplicate descriptions, checks, or notes. All helper commands accept Markdown plans; legacy JSON remains supported for migration.

## Portable content and optional metadata

Use a `# Title`, optional introductory prose, and top-level `- [ ]` / `- [x]` task items. Checkbox state means completion, never execution approval. Keep step details indented two spaces. Description and other text fields use blockquotes; checks use ordinary nested bullets. The helper assigns IDs to plain items during the first `status` or `render` call and saves them as HTML comments. Keep these IDs when other tools edit or reorder steps.

```markdown
# Improve session handoff
<!-- plan-companion: {"schema_version":1,"plan_id":"handoff-plan","revision":1} -->

- [ ] Preserve the paused session
  <!-- plan-step: {"id":"session"} -->

  **Description**
  > Preserve the process and breakpoints when switching clients.

  **Done when**
  > Both clients reconnect to the same paused process.

  **Notes**
  <!-- plan-note: {"id":"constraint","state":"pending"} -->
  > Keep existing breakpoint IDs.

- [ ] Review handoff in a fresh Codex task
  <!-- plan-step: {"id":"review","kind":"review","depends_on":["session"],"run_after":"session"} -->

  **Checks**
  - Reconnecting preserves the paused location.
  - Breakpoint operations still target the same IDs.
```

Optional `"milestone":"Service foundation"` step metadata groups adjacent steps under a collapsible heading. Names may contain up to 100 characters; omit or clear the field for ungrouped steps. Repeated names separated by other milestones form separate sections so grouping never changes execution order. Existing plans without milestone names retain their flat layout. Changing only milestone names preserves implementation approval and freshness.

Metadata preserves IDs, review type, coverage, timing, complexity estimates, and freshness state. An unchecked item with `"in_progress":true` in its step comment is running. Completion still comes from the Markdown checkbox. This is a portable task-list subset, not an arbitrary-Markdown parser or a guarantee that every planning tool understands review semantics. Tools that discard metadata may lose identity or references; malformed or dangling references are rejected rather than silently reconstructed.

Supported text sections are **Description**, **Done when**, **Result**, **Blocked by**, **Freshness**, **Complexity rationale**, **Estimate note**, and **Scope warning**. **Checks** contains bullets. **Notes** contains identified note blockquotes, optionally followed by **Response** and a response blockquote. Plain indented text without sections imports as the description. Introductory prose is retained. Unsupported unindented text inside a task or duplicate sections cause a clear error and leave the source untouched.

The top-level plan metadata may include `"lifecycle":"active"` or `"lifecycle":"finished"`; omission means active for older files. Use the `finish` and `reopen` commands to change it with revision checks and approval handling. Finishing keeps task checkboxes unchanged. Edits to the saved content do not automatically reopen a finished plan.

## Editing and refresh

Write or edit `plan.md`, then call `status --plan PLAN_MD` before continuing or `render --plan PLAN_MD --output TASK_CACHE_HTML` to refresh the card. Refresh may add missing IDs and update bookkeeping, but never starts work. External edits advance the revision and invalidate old cards. Changed steps lose prior execution authorization; changed unfinished scopes and affected dependents require freshness review. Unaffected scope remains authorized. Manually checking a box records user completion, not agent-verified evidence.

Whole-plan `revise` uses the same scope comparison as direct Markdown edits: changed descriptions, criteria, coverage, checks, timing, or notes revoke that step's selection. Progress, blocker, and freshness evidence alone do not revoke selection. Clearing freshness never renews approval.

Removing a previously active or completed row is rejected before the helper overwrites the sidecar or PR notes. This applies to direct Markdown omissions as well as revisions and operation batches. The user's externally edited Markdown is left untouched so other edits can be recovered; restore the missing rows before refreshing again.

Successful reads and saves maintain at most two source recovery copies, `current.md` and `previous.md`, in `.plan-history/<plan-stem>-recovery/`. These are generated backups, not additional editable plans. They preserve source content without putting prose in the sidecar or granting execution authority. If an interrupted save leaves the copies at different revisions, choose the copy whose SHA-256 matches the sidecar's `source_digest`, or merge the missing rows into the current Markdown. Recovery starts when this helper first successfully reads or saves a plan; it cannot reconstruct text already removed from a legacy plan with no backup.

All mutating commands use the Markdown lock and check the source digest before replacing it. Markdown, recovery copies, and bookkeeping are each written atomically. They are not a multi-file transaction: after an interruption between writes, the next refresh treats the mismatch conservatively as an external change. Preserve the sidecar across turns so execution receipts remain available. A missing sidecar imports the plan without execution authorization.

## Migration and generated files

```bash
node SKILL_DIR/dist/plan.cjs migrate --plan OLD_PLAN_JSON --output PLAN_MD
node SKILL_DIR/dist/plan.cjs render --plan PLAN_MD --output TASK_VISUALIZATION_DIR/rendered/plan-rREVISION.html
```

Migration verifies the round trip before replacing the legacy JSON with a redirect. It saves the original in `.plan-history`, retains IDs, notes, checks, progress, and receipts, and advances the revision so old cards cannot overwrite the new source. Repeating migration to the same destination is safe. Old cards' JSON paths resolve to Markdown through the helper.

Keep rendered HTML outside the repository in the durable task visualization directory. Use a distinct file for each published revision, retaining earlier files while conversation cards refer to them. The inline renderer requires a file path; HTML is not another source of truth. Do not delete old HTML as part of migration.

The helper regenerates `<plan-stem>-pr-notes.md` after saves. `review-brief` exports required checks plus covered intent and notes from the Markdown source; the agent must still attach the exact code snapshot and test evidence before starting a fresh reviewer. JSON operation payloads and optional structured revision drafts remain supported as transport, not as a second canonical plan.

## Context handover metadata

Step metadata may include `handover_after`, an advisory reason to consider a fresh task after that step. It is independent of prerequisites and approval. Plan metadata stores durable `handovers` events and optional `execution_owner`. Use the `handover` command and [handover protocol](handovers.md) to maintain these records; do not edit them to invent ownership, rewrite past events, or grant approval.
