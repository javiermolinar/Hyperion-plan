# Source layout and testing

The maintained implementation is TypeScript. This skill is self-contained inside the plugin's `skills/hyperion-plan/` directory; it can also be installed as a standalone skill.

The [Pi simplification target](host-contracts.md#pi-simplification-target) records the agreed executor/subagent/UI boundaries, optional tool decision, ten-file source/test budget, module disposition and compatibility limits. The current inventory is 15 Pi-specific files: six production modules, six test suites, one offline fixture and two terminal drivers. The five-file budget deviation keeps intent races, passive footer presentation and the two distinct terminal harnesses separate instead of creating a giant integration file. No Pi-only code moved into shared modules.

- `src/model.ts`: shared plan, step, note, request, and operation types; runtime validation; prerequisites; history guards and edit transitions used by CLI and browser draft replay.
- `src/transitions.ts`: request authorization, receipts, revisions, progress, and freshness.
- `src/agent.ts`, `src/cli-help.ts`: focused agent edits built on revision/operation checks, ready-work discovery, change previews, and command-specific help. See [Agent CLI commands](agent-cli.md) for usage.
- `src/markdown.ts`, `src/storage.ts`: Markdown parser/serializer, sidecars, redirects, locks, atomic file writes, and bounded recovery.
- `src/json.ts`: lossless parsing of numeric metadata, retaining Python float formatting and exact large integers for legacy fingerprints, receipts, and saves. Use `parseJSON` for plan/request input and the shared `clone` for copies; native `JSON.parse` loses this information. The parser requires Node 22's JSON source/raw-value support and rejects non-finite numeric metadata before writes.
- `src/exports.ts`, `src/cli.ts`: card/PR/review-brief exports and the on-demand CLI.
- `src/hosts/contracts.ts`: host-neutral snapshot, submission, capability, session, assignment/result and cancellation contracts. See [Host contracts](host-contracts.md) for the action inventory and compatibility boundary; these contracts do not implement worker dispatch.
- `src/browser.ts`: card rendering, local draft/selection interactions and ChangeRequest construction, compiled to a self-contained browser script.
- `src/hosts/codex.ts`: Codex widget draft storage/restoration, follow-up transport, native task links and host-specific prompt wording. No Pi dependency or worker dispatch.
- `src/instructions.ts`: pure intent instructions, with host terminology supplied by the adapter.
- `src/execution-instructions.ts`: browser-safe checkpoint, ownership and delegation fragments reused by host prompts.
- `src/execution-policy.ts`: pure execution admission and worker-evidence contract checks built on core readiness/ownership. No scheduler, dispatch ledger, worker process or canonical writes.
- `assets/plan-card.html`: the original markup and CSS with build-time data/script placeholders.
- `dist/plan.cjs`, `dist/index.cjs`, `dist/browser.js`: shipped executable/library/browser bundles. Never hand-edit these.
- `src/pi/extension.ts`: thin tool/command/event wiring; no plan state machine or dispatch protocol.
- `src/pi/executor.ts`: shared-core request admission, explicit progress/review outcomes, native intent transport and optional assignment preparation. Legacy lifecycle holds and source-owner fences are read-only; the shared core imports no Pi modules.
- `src/pi/subagents.ts`: one optional foreground SDK assignment lifecycle with bounded filesystem tools, native session entries, effort and selected-model proxy. No canonical plan imports/writes, test provisioning, wave scheduler or transfer/recovery engine.
- `src/pi/ui.ts`: local selection/drafts, path picker, native screen/controller, agent observation and tool rendering. No agent launch or transfer protocol; canonical operations go through the executor.
- `src/pi/footer.ts`: passive above-prompt plan status strip, responsive Powerline-style semantic segments, a completed/total-step progress bar and live/unknown agent counts. No timing placeholders, polling timers or clock entries. Preserves Pi's native footer; no execution or canonical writes.
- `src/pi/context.ts`: bounded discovery, branch bindings/drafts, data-only model awareness and canonical footer observation. No execution on restoration.
- `tests/pi-{executor,context,intent,ui,footer,subagents}.test.cjs`: six responsibility-focused suites. Offline SDK flows cover delegation; focused component and real-lock tests cover state and races. Credential-proxy cases run in isolated subprocesses.
- `tests/pi/fixture.ts`: one offline SDK/provider/workflow fixture, never imported by production.
- `tests/pi/terminal-smoke.cjs`, `tests/pi/terminal-workflow.cjs`: distinct VHS capture and browser-controlled PTY drivers; both count toward the file budget.
- `tests/*.test.cjs`: Node regression and compatibility tests.
- `tests/browser/`: browser suites, shared simulated host, and fixtures.

Keep generated plans, rendered revisions, review evidence, and receipts outside the skill. A task's Markdown and sidecar are live data. Published cards are self-contained and must stay at their original paths.

## Runtime and build

The shared CLI requires Node.js 22 or newer. Native Pi is tested with SDK/CLI 0.87.1 and Node 22.22.0; Pi 0.87.1 itself requires Node 22.19 or newer. The shipped bundles include runtime dependencies; using the CLI requires no Python, TypeScript compiler, npm install, network, MCP server, or persistent process. Run it from any working directory:

```sh
node /absolute/path/to/hyperion-plan/dist/plan.cjs --help
node /absolute/path/to/hyperion-plan/dist/plan.cjs status --plan /absolute/path/to/plan.md
```

To modify the source, run from this skill directory:

```sh
npm ci
npm run build
npm test
```

`npm run build` checks all source in strict TypeScript mode and uses esbuild to bundle the CLI, library, and browser script. `package-lock.json` pins the toolchain. Commit/distribute rebuilt `dist/` with source. Node's built-in test runner exercises the shipped JavaScript. Runtime dependencies and licenses are listed in `THIRD-PARTY-NOTICES.md`.

## Coverage and consolidation policy

Keep focused tests for ownership, selected scope, prerequisites, storage/revision races and unknown writers. Prefer actual offline Pi SDK flows for validated dispatch, reports, inspection, coordinator-verified completion, rejection and cancellation. Worker reports never complete canonical work automatically. Keep the small real-terminal smoke suite and the separate keyboard/mouse workflow driver; live-model evaluation remains manual dogfooding, not routine CI.

Consolidate only after replacement assertions pass. The Discard matrix uses the pinned SDK emitter rather than repeating the same scenarios with a serial mock. One Unicode/theme layout matrix covers the main screen's resize and keyboard contracts. Bound-path replacement checks live with discovery/context tests, and delivered Run prompts—not source-string matches—verify Pi's shared policy wording. Observer failures share the full SDK lifecycle scenario; forbidden tools share one transcript that verifies each refusal. The native review flow checks pre-launch write rejection and successful read-only execution. CLI, service, browser and storage checks remain distinct boundaries, not presumed duplicates. Reuse existing suites and the offline fixture; do not introduce helpers or dependencies just to move test code.

## Compatibility coverage

`tests/fixtures/python-baseline.json` freezes 424 observed success/error cases captured from the immutable reviewed Python baseline while its 52 tests passed. Each case names the originating test and function. The fixture is data, not another implementation. Its 48 exact repeated `stepFingerprint` input/output pairs run once each, leaving 376 distinct checks without changing the frozen data or deduplicating stateful cases. Test names retain the original fixture indices. It covers validation, request idempotency and selection, progress, pause/cancel, review placement/scope, freshness, Markdown parsing/serialization, fingerprints, and exports. The PR-notes comparison permits the renamed product heading while checking the remaining output unchanged.

`tests/storage.test.cjs` separately exercises real CLI/filesystem behavior: old Python-written Markdown, sidecars and receipts; both former P1 defects; direct edits; invalid source preservation; migration/redirects; recovery after repeated interrupted sidecar writes; export failure; and concurrent CLI writes. These are necessary because pure-function compatibility fixtures do not test disk writes or locking. The fixtures in `tests/fixtures/legacy/` are Python-written storage with Unicode content and existing approval.

The original Python implementation is retained only in the immutable review evidence outside this distribution. It is not needed for normal tests or runtime. Captured fixtures intentionally remain stable rather than being regenerated from the implementation under test. The compatibility test explicitly rejects the legacy decomposition draft that placed new prerequisites after their dependent, then verifies the original expected result with only its order corrected.

`tests/agent-cli.test.cjs` exercises the shipped commands through real CLI/filesystem round trips: read-only inspection, approved readiness, paused/cancelled execution, targeted edits and note replies, stale requests, scope invalidation, legacy redirects, and write-free previews including externally edited/plain Markdown. Existing storage tests retain coverage for locking, interrupted saves, and concurrent mutation.

`tests/review-fixes.test.cjs` covers canonical output protection through symlink aliases, Unicode line/paragraph separators in task metadata, lossless numeric receipts/approval refresh, and history/prerequisite invariants across combined operations. `tests/fixtures/legacy-numeric/` contains frozen Python-written plans, receipts, fingerprints, and numeric serialization expectations.

`tests/review-regressions.test.cjs` checks card-note approval revocation and dependent freshness, protected review scope under whole-plan revisions, and prerequisite ordering for targeted and whole-plan changes. CLI cases verify Markdown and JSON persistence, rejected writes, and dry runs. Browser review-fix checks cover dependent deselection while typing notes, draft restoration, and the resulting saved approval state.

## Host contract and adapter checks

`tests/host-contracts.test.cjs` checks explicit unsupported capabilities, unchanged native ownership IDs, service snapshot compatibility and a browser-only contract bundle without host runtime dependencies. `tests/codex-adapter.test.cjs` covers late bridge availability, draft subscriptions, delivery versus acceptance, failures/exact retries and native navigation. `tests/fixtures/codex-prompts.json` freezes pre-extraction prompt hashes for all ten intent variants; prompt extraction must preserve them unless a separately justified policy change explicitly updates the comparison. These tests and the browser suites use simulated Codex callbacks, not a live Codex conversation. `tests/execution-policy.test.cjs` tests current-turn authority, current request/owner, readiness, advisory freshness versus hard blockers, review/handover barriers, missing completion evidence and worker/coordinator evidence separation. This establishes the policy contract, not a working dispatch backend.

## Pi tool checks

`tests/pi-executor.test.cjs` covers the shipped tool surface, canonical admission/checkpoints, external review outcomes, ownership/revisions, prerequisites, pause/cancel, legacy holds and source-owner fences. It includes plan-tool lifecycle, queued opening, non-TUI operations, retry receipts, unsent drafts, transcript-free footer updates and finished-plan quietness. Shared-service cases remain here rather than being displaced into core tests. These simulated-host checks do not establish real-host screen delivery.

`npm run test:pi:runtime` selects the actual SDK case in `tests/pi-context.test.cjs`: project package discovery, model-facing tools/context, cold startup, reload, newly enabled tools, and restoration/compaction. It uses the deterministic provider in `tests/pi/fixture.ts` without network requests. Its UI boundary is simulated, not a terminal screenshot or real-model routing evaluation.

`npm run test:pi:terminal` runs `tests/pi/terminal-smoke.cjs`: the actual interactive Pi CLI inside VHS, with isolated settings/workspace and the scripted provider. It asserts reload events, provider-visible tools, queued open, settlement, native overlay rendering, the persistent plan footer, and unchanged approval. Screenshots, ASCII terminal frames, provider traces, plan files, and VHS diagnostics remain in the printed temporary directory. Requires VHS and ttyd. Set `HYPERION_TEST_POWERLINE` to an existing Powerline package directory for an opt-in compatibility capture; no package is installed or user settings loaded. Existing Rod browser-cache versions are linked individually into the isolated test home; user Pi settings and credentials are not loaded. VHS can download its Chromium runtime into that isolated cache when no supported installed/cached browser exists. Input is paced to avoid zero-delay terminal/autocomplete races. No cmux automation, user-session input injection, or user credentials are used.

The context suite also covers discovery ambiguity, defaults, bounded scans, parser errors, symlink containment, excluded fixtures/demos, finished plans, replaced bindings, active-branch restoration and data-only prompt encoding. Redirect targets are never read during discovery, including replacement races; fenced canonical examples are ignored.

`tests/pi-intent.test.cjs` groups natural-language Add/Edit/Note/Ask, failed delivery and real-lock admission races. It tests barriers inserted after Run's initial read, busy/idle and session changes while waiting for a lock, deferred drafts, safe stale selection, and same-session follow-ups. Busy requests queue without another Run; replacement/shutdown prevents cross-session delivery. Finished/blocked/stale/owned-plan intent never forges approval. Prepared/delivered entries are transport evidence, never restoration-triggered execution. These are deterministic adapter checks, not live-model concurrency tests. Shared-core history/order regressions remain in their existing suites.

Review-finding regressions cover replacement identity on manual refresh and snapshot acceptance, independent plan-review completion with unsettled native/legacy activity, malformed-but-parseable handover runtime files, post-commit branch/shutdown draft isolation, and locked replacement rejection before implicit Markdown refresh. The shared service accepts an optional `expectedPlanId`; Pi supplies it on every mutation so identity is checked before refresh writes. Unknown activity still permits recording a review limitation, not a completed outcome. Discard rechecks source-screen/session validity before persisting its empty draft, including after branch switches and shutdown; same-session busy Discard remains local and available. The extension passes a guard captured from the existing context generation to the screen, so validity does not wait for late UI listeners. Context invalidates on native before-tree/switch/fork events, which finish before host branch/session replacement, and on start/tree/shutdown notifications. An attempted navigation invalidates its source screen even if another listener later cancels it; reopening captures fresh validity. Discard regressions use the pinned SDK's actual event emitter, including an earlier delayed post-event listener; other lock and transport races use deterministic host callbacks. Shared CLI ownership guards cover implicit Markdown refresh/recovery writes by status and exports, not just explicit transitions. Non-owner show/next remain write-free. These tests use disposable plans and controlled host/lock timing, not live user-session changes.

The executor suite also covers cancellation while real file locks are held: create must not write canonical/history/export files or bind a plan, and edit/finish/reopen must not persist even an implicit external-Markdown refresh. The service's optional `beforeWrite` guard runs under the acquired lock, before the first canonical write, including creation. A post-create check also prevents binding when cancellation is observed during lock release. Cancellation after a synchronous commit cannot roll that commit back; tests preserve that distinction. These are simulated-host tests with real filesystem locks and abort signals, not a production worker cancellation protocol.

`tests/pi-ui.test.cjs` groups screen state, selection/drafts, command binding and component interaction checks: exactly four responsive main-menu controls (Space/Enter/Esc/A, 42–160 columns), retired shortcuts as non-actions, mouse press/click separation, no refocus after closing, automatic stacked narrow details, wheel behavior, Unicode width, theme invalidation and non-action paste/focus sequences. Legacy intent/Save/Discard fixtures inject receipts at the controller boundary, not through hidden keyboard shortcuts. Production action rows wrap to preserve mouse access; click handlers must not request focus after disposing the overlay.

`npm run test:pi:workflow` runs the actual Pi CLI inside a loopback-only ttyd/xterm terminal controlled by headless Chromium. Requires `ttyd`, `PLAYWRIGHT_MODULE` and optionally `CHROMIUM_EXECUTABLE`, as for browser checks below; it adds no package dependency. It uses isolated homes/workspaces, offline mode, no built-in tools and the scripted provider. The workflow portion of `tests/pi/fixture.ts` enables bounded test-only tools only with a fixture marker and matching working directory. Native Run must authorize exactly `approved`; two real tool calls save start/completion checkpoints and verify the fixture file while unselected work remains untouched. This is test execution, not a production runner or worker session.

The driver bounds polling deadlines even when browser evaluations stall. Setup failures, failed/stalled page closure and failed/stalled diagnostics still stop the ttyd process group and close its log; cleanup escalates from SIGTERM to SIGKILL and preserves the original failure. `tests/pi-ui.test.cjs` checks these failure paths with in-memory browser/process stubs, without requiring Playwright or launching a process. Importing the driver starts nothing and does not load Playwright.

The workflow runs regular-mode keyboard and fullscreen-mode mouse scenarios: Chromium IME composition and Unicode paste in chat, agent-applied Note/Add through the plan tool, unsent chat cancellation, Ask without approval, the four-action menu with no hidden edit/lifecycle keys, actual PTY resize with stacked details and preserved non-default focus/selection, light/dark theme switching, local selection isolation and A/B agent-view retention, and Enter Run through coordinator reconciliation of a known fixture-only acceptance blocker before canonical approval and start/completion. It also checks completion feedback, bound reopen and finish/reopen without recovered approval. Legacy draft persistence/conflict behavior remains covered by component tests. Terminal buffers, PNGs, canonical fixture files, traces and result JSON remain under the printed temporary artifact path. Screenshots use ttyd's DOM renderer to avoid headless WebGL scaling artifacts. The terminal and Pi palettes are changed together. The ttyd Unicode-11 renderer does not reliably handle ZWJ emoji; this terminal fixture uses a single-code-point emoji while component tests retain ZWJ width coverage. Chromium composition exercises terminal input delivery, not native OS IME candidate-window positioning.

`npm run test:pi:agents` exercises the actual SDK generic lifecycle plus credential-free model-proxy regressions. It covers explicit read/write scope and context, native identity, effort, cancellation, restored unknown-state holds, repeated-ID inspection and result-versus-completion separation. It also exercises actual SDK compaction on growing read-only context, cancellation during native summarization, preservation of earlier tool failures across compaction, and complete report return/history/inspection beyond the former 30,000-character cap. The child uses native compaction defaults rather than disabling context management; provider limits and existing assignment deadlines still apply. The native-tool fixture uses the executor admission path with a real offline child SDK session: validated start, report inspection, acceptance checks and a separate coordinator completion. Stale revisions, missing completion evidence and unknown writers reject writes; repeated IDs cannot launch again. Native caller cancellation retains the start without completing work, and rejected dispatches cannot clear restored unknown writers. Retired review certification/provisioning, managed-wave and handover-runtime tests were removed with those APIs. These deterministic fixtures are not independent review or live-model routing evidence. See [Pi delegation](pi-runner.md).

Keep real-model natural-language evaluations separate and opt-in. Passing a scripted-provider scenario proves tool/context transport and UI delivery, not that an arbitrary model will choose the right action.

## Browser checks

```sh
npm run test:browser
```

Configure an existing Playwright installation and Visualize host assets:

- `PLAYWRIGHT_MODULE`: resolvable module or absolute path to `playwright-core` (default `playwright`).
- `VISUALIZE_ASSETS`: absolute path to the Visualize skill's `assets` directory.
- `CHROMIUM_EXECUTABLE`: optional Chromium executable; otherwise Playwright uses its installed browser.

The browser suites generate cards using the compiled CLI and remove temporary workspaces on exit. They cover selection, saved drafts, history protection, failure/retry, review timing/coverage, persistence, stale edits, preview isolation, and 320/736px light/dark layouts. Repeated host-state notifications also check stable rows, scroll position, group highlighting, focus, and text selection while preserving late draft restoration. The Ask Codex suite covers Enter to send a question, Command+Enter for line breaks, composition/repeat guards, length limits, question isolation from plan edits and selected work, legacy note drafts, and exact retries. It consolidates the former note-keyboard and host-state suites around the current UI. Reordering checks cover pointer drag, cancellation, keyboard movement, visible selection/reorder hints, immediate host-state persistence without Save edits, and inclusion with the next explicit plan action. The review-fixes suite covers reopened review controls, rejected prerequisite inversions, lossless numeric rendering, and independent question drafts during reordering, including restoration and CLI persistence. The lifecycle suite covers finish/reopen requests, preserved drafts and retries, read-only finished cards, and fresh selection after reopening. The milestones suite exercises a 27-step plan, collapsed navigation and restoration, explicit step selection, separate plan/code review requests, and evidence disclosure. Callbacks are simulated: passing tests do not prove a real Codex conversation submission or native app scrolling behavior. They do not send messages or launch review tasks.

`tests/reordering.test.cjs` checks shared order validation, dependency and review constraints, preserved history under combined edits, unchanged authorization, receipts, stale rejection, and Markdown/PR-note persistence. Order changes move pending tasks by insertion; protected records keep their relative order and contents, although displayed step numbers can change.

## Migrating an existing installation

The skill is named `hyperion-plan`; Pi's single terminal command is `/hyperion`. Install the renamed skill and remove the old `plan-companion` installation to avoid duplicate entries. The `plan-companion` Markdown marker, redirect format, and saved widget-state identifiers remain unchanged so existing plans and drafts stay compatible. Previously rendered cards still reference the old skill name and installation path; render a fresh card with the new CLI before submitting changes.

Existing Markdown, sidecars, JSON redirects, and published cards need no conversion. The CLI preserves legacy request digests and step fingerprints, so an unchanged step retains its approval. Skill instructions now invoke `node SKILL_DIR/dist/plan.cjs`; update any personal shell aliases using the former Python entrypoint.

Stop old Python helper invocations before replacing the installation. Node uses a short-lived `*.lockdir` directory lock with a 30-second stale threshold; the retired Python helper used `flock` on `*.lock`. They do not coordinate with each other. Concurrent Node invocations serialize. After an abnormal exit, allow the stale interval before retrying; do not manually delete a live lock.

Markdown, sidecar, recovery copies, and exports remain separate atomic writes, not a multi-file transaction. Recovery is bounded to `current.md` and `previous.md`; retain the copy whose SHA-256 matches the accepted sidecar after an interruption. Text deleted before a first backup remains unrecoverable. Keep the sidecar with the plan to retain authority and receipts.

## Distribution

The plugin root contains `.codex-plugin/plugin.json` and this skill. Package it with `dist/` included and `node_modules/`, caches, task data, and temporary output excluded. See the plugin-root `README.md` for installation. Keep one maintained source tree; installed/cache copies are deployment copies, not independent implementations.

Independent plan review coverage lives in `tests/plan-review.test.cjs` and `tests/browser/plan-review.cjs`: durable requests, retries, authority isolation, revision checks, outcome validation, canonical Markdown, dialog scope/focus, findings, and narrow layouts. The browser host is simulated; it does not launch reviewer tasks.

Context handovers are implemented in `src/handovers.ts` with shared metadata validation in `src/model.ts`. `tests/handovers.test.cjs` covers advisory marker scope isolation, actual event positions, held execution, stale preparation, ownership, paused-scope preservation, retry recovery, cancellation, and canonical CLI persistence. `tests/browser/handovers.cjs` covers marker drafts, mid-step action requests, failure/reload retries, events, finished/preview isolation, and narrow layouts. Browser task creation remains simulated; no compaction hook or usage monitor is installed.

Reasoning-effort browser checks cover clickable brain-icon badges, optional dropdown adjustment, no edits on expansion, draft retry/reload, reset to task default, and responsive layout. New plan effort choices are agent-driven through the skill instructions; the browser does not infer task difficulty or change saved effort automatically.

`tests/handover-checkpoints.test.cjs` covers ordered handover boundaries, readiness, old approvals, transfer-only completion, cancellation, review-scope isolation, moving/removing checkpoints, and CLI persistence. `tests/browser/handover-checkpoints.cjs` covers automatic checkpoint inclusion in approved runs, explicit work selection, retries, transfer display, moving checkpoints and requesting changes through Ask Codex, preview isolation, and responsive layout. Task creation is simulated; these tests do not create real tasks.

## v1.4 interface coverage

`tests/ask-codex.test.cjs` verifies question validation, retry receipts, stale requests, scope/freshness isolation, CLI persistence, model-assigned parallel groups and dependency/barrier validation. `tests/browser/ask-codex.cjs` replaces the former note-keyboard and host-state suites and covers question drafts, exact failed-send retries, late host restoration, focus and selection, keyboard behavior, no implicit note edits, legacy unsent notes, group highlighting, finished/demo/offline isolation and responsive layout. The existing control, review, Markdown, reordering, lifecycle and handover suites now exercise the current UI. Removed step-menu mutations remain covered at the CLI/model layer. Browser host callbacks are simulated; tests do not launch real work or send conversation messages.

`tests/freshness.test.cjs` and `tests/browser/freshness.cjs` cover advisory change warnings, latest-plan selection validation, safe stale-card reconciliation, atomic scope/dependency/review updates, preserved interrupted work, explicit resume, and actionable disabled-control explanations. Frozen compatibility fixtures remain unchanged; the harness documents intentional behavior changes. Browser follow-ups use a simulated host.
