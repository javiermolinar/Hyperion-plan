# Source layout and testing

The maintained implementation is TypeScript. This skill is self-contained inside the plugin's `skills/plan-companion/` directory; it can also be installed as a standalone skill.

- `src/model.ts`: shared plan, step, note, request, and operation types; runtime validation; prerequisites; history guards and edit transitions used by CLI and browser draft replay.
- `src/transitions.ts`: request authorization, receipts, revisions, progress, and freshness.
- `src/agent.ts`, `src/cli-help.ts`: focused agent edits built on revision/operation checks, ready-work discovery, change previews, and command-specific help. See [Agent CLI commands](agent-cli.md) for usage.
- `src/markdown.ts`, `src/storage.ts`: Markdown parser/serializer, sidecars, redirects, locks, atomic file writes, and bounded recovery.
- `src/json.ts`: lossless parsing of numeric metadata, retaining Python float formatting and exact large integers for legacy fingerprints, receipts, and saves. Use `parseJSON` for plan/request input and the shared `clone` for copies; native `JSON.parse` loses this information. The parser requires Node 22's JSON source/raw-value support and rejects non-finite numeric metadata before writes.
- `src/exports.ts`, `src/cli.ts`: card/PR/review-brief exports and the on-demand CLI.
- `src/browser.ts`: existing card interactions compiled to a self-contained browser script.
- `assets/plan-card.html`: the original markup and CSS with build-time data/script placeholders.
- `dist/plan.cjs`, `dist/index.cjs`, `dist/browser.js`: shipped executable/library/browser bundles. Never hand-edit these.
- `tests/*.test.cjs`: Node regression and compatibility tests.
- `tests/browser/`: browser suites, shared simulated host, and fixtures.

Keep generated plans, rendered revisions, review evidence, and receipts outside the skill. A task's Markdown and sidecar are live data. Published cards are self-contained and must stay at their original paths.

## Runtime and build

Node.js 22 or newer is required. The shipped bundles include runtime dependencies; using the CLI requires no Python, TypeScript compiler, npm install, network, MCP server, or persistent process. Run it from any working directory:

```sh
node /absolute/path/to/plan-companion/dist/plan.cjs --help
node /absolute/path/to/plan-companion/dist/plan.cjs status --plan /absolute/path/to/plan.md
```

To modify the source, run from this skill directory:

```sh
npm ci
npm run build
npm test
```

`npm run build` checks all source in strict TypeScript mode and uses esbuild to bundle the CLI, library, and browser script. `package-lock.json` pins the toolchain. Commit/distribute rebuilt `dist/` with source. Node's built-in test runner exercises the shipped JavaScript. Runtime dependencies and licenses are listed in `THIRD-PARTY-NOTICES.md`.

## Compatibility coverage

`tests/fixtures/python-baseline.json` freezes 424 observed success/error cases captured from the immutable reviewed Python baseline while its 52 tests passed. Each case names the originating test and function. The fixture is data, not another implementation. It covers validation, request idempotency and selection, progress, pause/cancel, review placement/scope, freshness, Markdown parsing/serialization, fingerprints, and exports.

`tests/storage.test.cjs` separately exercises real CLI/filesystem behavior: old Python-written Markdown, sidecars and receipts; both former P1 defects; direct edits; invalid source preservation; migration/redirects; recovery after repeated interrupted sidecar writes; export failure; and concurrent CLI writes. These are necessary because pure-function compatibility fixtures do not test disk writes or locking. The fixtures in `tests/fixtures/legacy/` are Python-written storage with Unicode content and existing approval.

The original Python implementation is retained only in the immutable review evidence outside this distribution. It is not needed for normal tests or runtime. Captured fixtures intentionally remain stable rather than being regenerated from the implementation under test. The compatibility test explicitly rejects the legacy decomposition draft that placed new prerequisites after their dependent, then verifies the original expected result with only its order corrected.

`tests/agent-cli.test.cjs` exercises the shipped commands through real CLI/filesystem round trips: read-only inspection, approved readiness, paused/cancelled execution, targeted edits and note replies, stale requests, scope invalidation, legacy redirects, and write-free previews including externally edited/plain Markdown. Existing storage tests retain coverage for locking, interrupted saves, and concurrent mutation.

`tests/review-fixes.test.cjs` covers canonical output protection through symlink aliases, Unicode line/paragraph separators in task metadata, lossless numeric receipts/approval refresh, and history/prerequisite invariants across combined operations. `tests/fixtures/legacy-numeric/` contains frozen Python-written plans, receipts, fingerprints, and numeric serialization expectations.

`tests/review-regressions.test.cjs` checks card-note approval revocation and dependent freshness, protected review scope under whole-plan revisions, and prerequisite ordering for targeted and whole-plan changes. CLI cases verify Markdown and JSON persistence, rejected writes, and dry runs. Browser review-fix checks cover dependent deselection while typing notes, draft restoration, and the resulting saved approval state.

## Browser checks

```sh
npm run test:browser
```

Configure an existing Playwright installation and Visualize host assets:

- `PLAYWRIGHT_MODULE`: resolvable module or absolute path to `playwright-core` (default `playwright`).
- `VISUALIZE_ASSETS`: absolute path to the Visualize skill's `assets` directory.
- `CHROMIUM_EXECUTABLE`: optional Chromium executable; otherwise Playwright uses its installed browser.

The eight suites generate cards using the compiled CLI and remove temporary workspaces on exit. They cover selection, saved drafts, history protection, failure/retry, review timing/coverage, persistence, stale edits, preview isolation, and 320/736px light/dark layouts. Repeated host-state notifications also check stable rows, scroll position, open menus, focus, and text selection while preserving late draft restoration. Note keyboard checks cover Enter to save edits, Command+Enter for line breaks, composition/repeat guards, length limits, draft preservation, and retries. Reordering checks cover pointer drag, cancellation, keyboard/menu movement, visible selection/reorder hints, immediate host-state persistence without Save edits, and inclusion with the next explicit plan action. The review-fixes suite covers reopened review controls, rejected prerequisite inversions, lossless numeric rendering, and removal Undo after reordering, including draft restoration and CLI persistence. The lifecycle suite covers finish/reopen requests, preserved drafts and retries, read-only finished cards, and fresh selection after reopening. Callbacks are simulated: passing tests do not prove a real Codex conversation submission or native app scrolling behavior. They do not send messages or launch review tasks.

`tests/reordering.test.cjs` checks shared order validation, dependency and review constraints, preserved history under combined edits, unchanged authorization, receipts, stale rejection, and Markdown/PR-note persistence. Order changes move pending tasks by insertion; protected records keep their relative order and contents, although displayed step numbers can change.

## Migrating an existing installation

Existing Markdown, sidecars, JSON redirects, and published cards need no conversion. The CLI preserves legacy request digests and step fingerprints, so an unchanged step retains its approval. Skill instructions now invoke `node SKILL_DIR/dist/plan.cjs`; update any personal shell aliases using the former Python entrypoint.

Stop old Python helper invocations before replacing the installation. Node uses a short-lived `*.lockdir` directory lock with a 30-second stale threshold; the retired Python helper used `flock` on `*.lock`. They do not coordinate with each other. Concurrent Node invocations serialize. After an abnormal exit, allow the stale interval before retrying; do not manually delete a live lock.

Markdown, sidecar, recovery copies, and exports remain separate atomic writes, not a multi-file transaction. Recovery is bounded to `current.md` and `previous.md`; retain the copy whose SHA-256 matches the accepted sidecar after an interruption. Text deleted before a first backup remains unrecoverable. Keep the sidecar with the plan to retain authority and receipts.

## Distribution

The plugin root contains `.codex-plugin/plugin.json` and this skill. Package it with `dist/` included and `node_modules/`, caches, task data, and temporary output excluded. See the plugin-root `README.md` for installation. Keep one maintained source tree; installed/cache copies are deployment copies, not independent implementations.
