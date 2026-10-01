# Native Pi coordinator handover

`hyperion_handover` implements a persistent coordinator transition, not a worker assignment. It uses the shared prepared/transferred/cancelled records and canonical execution owner; Codex transitions are unchanged. An approved Run can include existing handover checkpoints. Newly introduced or materially changed boundaries invalidate a stale native Run.

## Current authority and inputs

At a selected, ready checkpoint, use `operation: "run"` with the exact execution `request_id`, `plan_path`, `step_id`, `current_request_authorized: true`, and `handover_sessions_authorized: true`. Existing explicitly requested ad-hoc events use `handover_id`. Supply a concise `summary`, `next_action`, repository-relative `files`, `source_writers_drained: true`, and concrete `source_quiescence_evidence`.

These are coordinator assertions requiring current user authority and actual inspection, not proof furnished by setting booleans. User prohibitions override an approved checkpoint. Permission for isolated offline test sessions is not permission to transfer a live plan. Saved approval, discovery, opening, questions and reload never start a handover.

Run from the Git repository root. Declare **every relevant source file**, including dirty, untracked and deleted files. The bounded observation captures HEAD, the complete index, untracked path inventory and the exact declared working bytes/modes. It excludes canonical plan controls and dispatch artifacts. This is scoped code coverage, not a hash of every checkout byte: undeclared working-file contents are not covered. Canonical paths, regular files and size limits are enforced; aliases are rejected. Reconcile inadequate claims rather than claiming whole-repository verification.

Drain and reconcile all managed assignments/waves first. Verify any external source-owned writers separately. Source idle alone does not prove arbitrary process-tree settlement. Guards are cooperative, not an OS sandbox; unrelated processes and arbitrary third-party extension commands remain outside their control.

## Native workflow

1. The model tool queues a nonce-bound command, returns `terminate: true`, and stops the source turn. Tools cannot replace sessions directly. The command waits for public `waitForIdle()` and rechecks identity and current scope.
2. The host records the typed handover request and preparation through the shared core, exports the brief, and reserves durable intent. It journals one actual native destination ID/path before asynchronous SDK construction or model work.
3. Read-only readiness has a fresh context, the brief/plan/declared code, and only `read`/`report_handover`. It has no parent conversation, ambient extensions, skills, context files, shell or delegation. Requested/actual effort, attempt identity, events and settlement are persisted.
4. A report is unverified evidence. The runner also requires actual `agent_settled`, idle state, no queued messages/retry/compaction, a normal final stop and no tool errors in that attempt. Disposing this readiness object preserves its persistent transcript.
5. The journal rechecks plan, scoped code, brief and the complete readiness transcript. It writes transfer intent, then uses the shared canonical ownership transition. Only this transition completes a typed checkpoint.
6. Public command `switchSession(..., {withSession})` restores that same destination as the interactive coordinator. Only plain correlation data crosses replacement. Fresh callback APIs verify identity and consume a one-use continuation claim before sending the remaining-scope message. No cmux, history fork, competing plan or checkout is involved.
7. Session-wide ownership tags block model tools and native user-bash in the old source, including restoration or branch navigation. The destination retains the native plan binding. New source input/model work cancels pending readiness; new source shell work is blocked while it settles. Shutdown/switch joins readiness; unknown settlement vetoes reuse/switching.

## Inspection and conservative recovery

`operation: "inspect"` is read-only. Records live under the plan-local `.hyperion-dispatch/<plan-basename>/handovers/<request-hash>/` directory. Journal phases are `reserved`, `identified`, `ready`, `transfer-intent`, `transferred`, `claimed`. The handover event ID is distinct from the execution request ID.

With renewed **current** permission, `operation: "resume"` reuses the existing event and destination:

- A stable ready record needs no model call.
- Failed/lost readiness or plan/code drift can be explicitly re-prepared only with attempt-bound verified settlement and an unchanged transcript from that attempt. Preparation archives the old context, refreshes the brief/digests, and issues one durable retry claim. The SDK opens the same ID/path, appends a versioned context entry, and performs fresh read-only readiness. Historical tool failures are retained, not mistaken for new-attempt failures.
- Older runtime evidence cannot supersede an already claimed retry. A crash, absent transcript, ambiguous construction or unknown writer state remains held. No new destination is allocated to escape uncertainty.
- An uncommitted transfer intent can be reset only after the lock proves the source still owns a prepared handover and readiness/context are unchanged. An already committed intent is acknowledged from the matching canonical destination; ownership is never rolled back.
- A cancelled navigation preserves the transferred destination. A consumed continuation claim is never automatically replayed, even if delivery was lost. This is **at-most-once claiming**, not exactly-once delivery.

Use `/hyperion-handover-open [PLAN_PATH]` to open the recorded canonical destination without model work or another continuation. This command also works from the fenced source and after progress or a pause. Inspect the actual destination and delivery/step evidence before giving a fresh explicit instruction to continue remaining approved work. Opening itself grants no execution authority. Paused/cancelled scope stays paused/cancelled.

## Components and evidence

- `src/pi/handover-tool.ts`: native admission, preparation, command routing, lifecycle and recovery.
- `handover-code.ts`: bounded Git/declared-file observations.
- `handover-journal.ts`: session-free durable protocol and one-use claims.
- `handover-readiness.ts`: public-SDK read-only readiness and persistent identity.
- `handover-navigation.ts`: public replacement, fresh-context continuation and source fencing.

`tests/pi-handover-journal.test.cjs` uses synthetic IDs/settlement with real temporary locks and shared transitions. The `handover protocol:` and `handover native:` cases in `tests/pi-runner.test.cjs` use actual offline SDK sessions; the latter invoke the shipped native tool and command. `tests/pi/terminal-handover.cjs` runs the installed Pi CLI through ttyd/xterm and Chromium: native Run, readiness, replacement, selected-only destination checkpoints, destination plan opening, restored-source tool rejection and native user-bash blocking. All fixtures use disposable plans and a scripted provider.

These are coordinator-run runtime/terminal checks, not independent review or live-model routing evidence. They do not establish OS isolation, arbitrary process-tree termination, cross-plan scheduling or recovery from an unobserved process kill.
