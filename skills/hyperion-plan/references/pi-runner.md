# Pi delegation

Hyperion has one required tool, `hyperion_plan`, and an optional `hyperion_agent` fallback for the pinned Pi SDK's missing managed-subagent tool. Prefer an available host delegate. Set `HYPERION_DISABLE_AGENTS=1` before loading the extension to expose only the plan tool. No installation, delegation or resumption happens on load.

## Explicit foreground assignments

`hyperion_agent` has `run` and `inspect` actions. Run supplies an assignment ID, canonical `plan_path`, exact `request_id`, selected `step_id`, instructions, explicit context and exact read/write paths inside the coordinator's working directory (relative paths resolve there). An explicit allowlist does not permit external files. Call `run` directly: it reads current canonical state, validates scope/paths and records the `in_progress` checkpoint before launch. Already-started steps remain supported without a second checkpoint. Only the current user's delegation permission authorizes a launch; saved selection and boolean claims are not proof of consent. Scope, actor, prerequisites, pause/cancel and current requirements are checked by the executor before launch and during bounded tools. Requested effort uses supported SDK controls; unsupported levels are reported.

Omit `step_id` only for an explicit independent plan-review request. Reviews use the same lifecycle with no write permissions. Supply requirements and identified code, not parent conversation or a suggested verdict. Fresh context is not an OS sandbox. The fallback has no shell, tests, provisioning, ambient extensions or nested delegation. Use an explicitly chosen host facility for broader capabilities, and report missing required checks honestly.

Each call runs one foreground assignment; the handler admits at most two live children in one currently authorized `request_id` cohort. It awaits SDK/tool settlement and returns its actual identity, transcript and full unverified report without truncating the report itself. Native evidence validation uses the session bounds below; oversized sessions remain unknown rather than yielding truncated or trusted evidence. It uses native SDK compaction defaults as context grows; model/provider context and output limits still apply. Native compact-and-continue/recovery stays within the same assignment and is not a relaunch or scheduler retry. Transient agent-level retries remain disabled. Native history retains tool failures even when they disappear from compacted model context; compaction cannot turn a failed assignment into success. Caller cancellation, authority checks and assignment/settlement deadlines remain unchanged.

It imports no plan model or persistence service and never completes a step. The executor stores plan/request/step correlation with native `hyperion.agent` session entries. The result includes `checkpointed` and the last observed `plan_revision`; the coordinator inspects the report and performs a separate evidence-bearing completion checkpoint, reconciling any later writes. Findings grant no fix authority.

Pre-launch failures return `state: "rejected"`, `isError: true`, `settled: true`, empty native identity/transcript fields, and `rejection.code`, `workspace`, optional offending `path`, and an actionable `limitation`. Failed preflight creates no child or start checkpoint. Rejections are retained in the source session and displayed in Agents as **Not launched**, without a transcript lookup. Repeated IDs inspect the rejection rather than retry it; a new attempt still needs current user permission and a fresh assignment identity. A rejection never certifies settlement of another native session or clears unknown writers.

## Bounded fork/join

The coordinator chooses eligible selected steps; the handler does not choose work or fill capacity. Canonical file claims reserve IDs and scope before asynchronous launch. Writable files are also readable claims. Read/read overlap is allowed; write/write, write/read, duplicate active step ownership, capacity overflow and foreign live cohorts reject. Sequential mode and reviews require exclusive admission. Prerequisites, selected review/handover barriers, ownership and unknown historical writers still constrain admission.

Concurrent starts serialize reservation and canonical checkpoints under the existing plan lock. A known same-request sibling may advance the revision; changed requirements, request or owner do not qualify for that exception. Call `run` directly for each child; do not write a separate start checkpoint first. In-progress steps are not permission to redispatch uncertain work. Repeated live IDs join the existing attempt; recorded IDs are inspected, never relaunched.

Where Codemode is available, use `Promise.allSettled` for the two explicitly authorized calls. A rejected call can leave a peer running: await all call results and inspect every assignment's settlement before integration or completion. Script failure does not undo completed mutations; ending a script cancels outstanding calls, not necessarily their writers synchronously. Never replay an interrupted script to recover results.

## Cancellation and history

Abort, shutdown and session switching stop admission and abort and join all known foreground children. Tool admission rechecks live scope; built-in filesystem operations are bounded and awaited. Unjoined work remains unknown, not success. Host abort acknowledgement, a returned JavaScript promise or final assistant prose alone cannot establish quiescence. Unknown writers hold new execution, completion, workspace reuse and transfer.

The original coordinator must already have a persisted Pi session. Native parent `hyperion.agent` entries durably reserve assignment identity, canonical file claims and coordinator/plan/request/step correlation before asynchronous child construction; the SDK can defer creating the child file until its first assistant entry. Native session IDs and paths remain authoritative. Pi sessions are the only execution-history/report store: there is no `run.json`, second transcript store or plan-schema migration. After observed SDK/tool/abort settlement, a child `hyperion.agent-settlement` marker is persisted before the parent terminal result.

Session files are history, not live handles. Restoring the original coordinator does not recreate children or continue scripts. Sleep, network interruption and process death do not guarantee continuation. There is no scheduler, automatic refill/retry/relaunch, cross-coordinator ownership adoption, global workspace arbitration or crash-recovery engine. Handoff stays host-owned.

## Read-only result inspection

Inspect an existing assignment by ID, or omit `assignment_id` and supply both `plan_path` and `request_id` to inspect the current canonical request's group. Inspection checks the actual original coordinator and current canonical scope. Group results include `assignments`, `outcomes` counts for settled/failed/rejected/unresolved evidence, and `read_only: true`.

Parent terminal records use `source: "parent"`. For an unfinished parent, inspection can obtain report text from a matching child session only with a valid settlement marker. It checks native location/identity, correlation, intent/context/scope digests, exact claims, branch ordering and report reference. Reads use raw, non-migrating version-3 JSONL, bounded to 8 MiB and 50,000 lines. Missing, corrupt, aliased, oversized or mismatched sessions, absent markers and final prose alone remain unknown.

Recovered results use `source: "child-session"`, with the original `parent_state` and `parent_settled`. A recovered `settled: true` or group count is child evidence only: it never rewrites parent lifecycle, completes canonical steps or clears unknown-writer fences. No reconciliation/adoption API is supplied. Legacy ID-only terminal inspection stays compatible without invented claims; unfinished legacy records remain conservative holds.

Historical `.hyperion-dispatch` ledgers, handover records, reports, test artifacts and machine-local configuration are retained untouched. Bounded executor preflight reads lifecycle fields only; it does not recertify artifacts. Active/uncertain or malformed records, unreconciled waves and unfinished transfers hold new execution. Read-only plan inspection remains available.

**Before upgrading/reloading:** settle and reconcile old managed work using the old version/owning host. Do not delete history, fabricate settlement or assume package replacement stopped old writers. If the old host is unavailable, record the limitation; do not launch replacement work. Transferred-source owner fences remain effective across branch changes.

## Removed APIs

`hyperion_review`, `hyperion_review_setup`, `hyperion_wave`, `hyperion_handover` and standalone `pi-runner.js`/`pi-handover-*` bundles are removed, with no launch aliases. Hyperion does not capture Git snapshots, provision tests, certify artifacts, reserve waves, resume assignments from history or navigate coordinator handovers. Read-only child-result inspection is not the retired recovery engine. Shared CLI/Codex review and ownership metadata remain compatible; direct CLI/filesystem writers are not supervised by the Pi runtime.

See [review outcomes](review-checks.md), [independent plan review](plan-review.md), [host-owned handoff](pi-handover.md) and the [architecture boundary](host-contracts.md#pi-simplification-target).

## Evidence

`tests/pi-subagents.test.cjs` uses actual offline SDK sessions to check identity, explicit context/tools, exact paths, effort, cancellation and no implicit replay. The same suite runs credential-proxy cases in isolated subprocesses with network denial. `tests/pi/fixture.ts` is the shared offline fixture, never imported by production. Core behavior is tested against pinned Pi 0.87.1. Four isolated Pi 1.0.3 tests use actual QuickJS Codemode and nested tool execution with offline SDK children: overlapping joined results, partial conflict rejection, cancellation settlement fences and original-coordinator restoration without replay. Set `HYPERION_PI_103_DIR` to an existing Pi 1.0.3 coding-agent package when it is not in the standard release location; unavailable integration is reported as skipped, not a pass. These deterministic checks are not independent reviews, installed-session dogfooding, real macOS sleep/process-death tests or live-model routing evaluations. Retired runtime tests were removed with their capabilities; all surviving tests remain in the five consolidated suites.
