# Pi delegation

Hyperion has one required tool, `hyperion_plan`, and an optional `hyperion_agent` fallback for the pinned Pi SDK's missing managed-subagent tool. Prefer an available host delegate. Set `HYPERION_DISABLE_AGENTS=1` before loading the extension to expose only the plan tool. No installation, delegation or resumption happens on load.

## Explicit foreground assignments

`hyperion_agent` has `run` and `inspect` actions. Run supplies an assignment ID, canonical `plan_path`, exact `request_id`, selected `step_id`, instructions, explicit context and exact read/write paths inside the coordinator's working directory (relative paths resolve there). An explicit allowlist does not permit external files. Call `run` directly: it reads current canonical state, validates scope/paths and records the `in_progress` checkpoint before launch. Already-started steps remain supported without a second checkpoint. Only the current user's delegation permission authorizes a launch; saved selection and boolean claims are not proof of consent. Scope, actor, prerequisites, pause/cancel and current requirements are checked by the executor before launch and during bounded tools. Requested effort uses supported SDK controls; unsupported levels are reported.

Omit `step_id` only for an explicit independent plan-review request. Reviews use the same lifecycle with no write permissions. Supply requirements and identified code, not parent conversation or a suggested verdict. Fresh context is not an OS sandbox. The fallback has no shell, tests, provisioning, ambient extensions or nested delegation. Use an explicitly chosen host facility for broader capabilities, and report missing required checks honestly.

The handler runs one foreground assignment, awaits SDK/tool settlement and returns its actual identity, transcript and full unverified report, without a Hyperion character cap. It uses native SDK compaction defaults as context grows; model/provider context and output limits still apply. Native compact-and-continue/recovery stays within the same assignment and is not a relaunch or scheduler retry. Transient agent-level retries remain disabled. Native history retains tool failures even when they disappear from compacted model context; compaction cannot turn a failed assignment into success. Caller cancellation, authority checks and assignment/settlement deadlines remain unchanged.

It imports no plan model or persistence service and never completes a step. The executor stores plan/request/step correlation with native `hyperion.agent` session entries. The result includes `checkpointed` and the last observed `plan_revision`; the coordinator inspects the report and performs a separate evidence-bearing completion checkpoint, reconciling any later writes. Findings grant no fix authority.

Pre-launch failures return `state: "rejected"`, `isError: true`, `settled: true`, empty native identity/transcript fields, and `rejection.code`, `workspace`, optional offending `path`, and an actionable `limitation`. Failed preflight creates no child or start checkpoint. Rejections are retained in the source session and displayed in Agents as **Not launched**, without a transcript lookup. Repeated IDs inspect the rejection rather than retry it; a new attempt still needs current user permission and a fresh assignment identity. A rejection never certifies settlement of another native session or clears unknown writers.

## Cancellation and history

Abort, shutdown and session switching stop foreground work. Tool admission rechecks live scope; built-in filesystem operations are bounded and awaited. Unjoined work returns unknown, not success. Source session entries reserve assignment identity before prompting. Repeated IDs inspect the same record, never relaunch. Restored unfinished records remain unknown and hold new execution/completion; inspect the actual native session. There is no scheduler, automatic refill, global workspace arbitration or crash-recovery engine. A separate host owns any explicitly authorized concurrency or handoff.

Historical `.hyperion-dispatch` ledgers, handover records, reports, test artifacts and machine-local configuration are retained untouched. Bounded executor preflight reads lifecycle fields only; it does not recertify artifacts. Active/uncertain or malformed records, unreconciled waves and unfinished transfers hold new execution. Read-only plan inspection remains available.

**Before upgrading/reloading:** settle and reconcile old managed work using the old version/owning host. Do not delete history, fabricate settlement or assume package replacement stopped old writers. If the old host is unavailable, record the limitation; do not launch replacement work. Transferred-source owner fences remain effective across branch changes.

## Removed APIs

`hyperion_review`, `hyperion_review_setup`, `hyperion_wave`, `hyperion_handover` and standalone `pi-runner.js`/`pi-handover-*` bundles are removed, with no launch aliases. Hyperion no longer captures Git snapshots, provisions tests, certifies artifacts, reserves waves, recovers assignments or navigates coordinator handovers. Shared CLI/Codex review and ownership metadata remain compatible; direct CLI/filesystem writers are not supervised by the Pi runtime.

See [review outcomes](review-checks.md), [independent plan review](plan-review.md), [host-owned handoff](pi-handover.md) and the [architecture boundary](host-contracts.md#pi-simplification-target).

## Evidence

`tests/pi-subagents.test.cjs` uses actual offline SDK sessions to check identity, explicit context/tools, exact paths, effort, cancellation and no implicit replay. The same suite runs credential-proxy cases in isolated subprocesses with network denial. `tests/pi/fixture.ts` is the shared offline fixture, never imported by production. These deterministic checks are not independent reviews, installed-session dogfooding or live-model routing evaluations. Retired runtime tests were removed with their capabilities; all surviving tests remain in the five consolidated suites.
