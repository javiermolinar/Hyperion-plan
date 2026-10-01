# Host contracts and compatibility boundary

`src/hosts/contracts.ts` defines the shared transport/read-model boundary. It does not implement worker dispatch. The existing `ChangeRequest`, core transitions and storage remain authoritative. No canonical Markdown, sidecar, receipt hash, native task ID or published card requires migration.

## Ownership of responsibilities

| Responsibility | Owner |
| --- | --- |
| Render DOM or terminal controls; focus, selection and drafts | Host frontend |
| Persist/restore host drafts; deliver follow-ups; build native session links | UI adapter |
| Validate request intent, revision, scope, prerequisites and receipts | Shared core |
| Lock, refresh and persist canonical state; check actual actor identity | Shared storage/service |
| Decide whether approved work is independent, integrate it, verify and checkpoint | Coordinator |
| Execute one bounded assignment and return correlated evidence | Execution adapter, when implemented |

`PlanSnapshot` includes canonical identity/revision, source digest, refresh status and summary. It is a read model, not a grant of execution authority. `PlanMutationResult` additionally describes whether a save changed state. `service.ts` re-exports these types for existing consumers.

`PlanUiAdapter<Draft>` owns host transport, not rendering or request construction. Draft encoding is deliberately host-specific: Codex retains its `modelContent`/`privateContent` widget state and Pi retains its session entries. Stable IDs, base revisions, retry IDs and unsent changes must survive delivery failures. A snapshot refresh must reconcile conflicts rather than silently overwrite drafts.

`SubmissionOutcome` distinguishes delivery from canonical acceptance/rejection. The browser receives only delivery confirmation; the coordinator must apply the request. Pi may apply under the shared lock before delivering an implementation turn. Even a saved request whose follow-up failed does not start work. Neither accepted nor delivered means started or completed. Only later observed checkpoints establish progress.

## Action inventory

| Existing action | Contract | Authorization |
| --- | --- | --- |
| Open/show/discover, details, navigation | Read canonical snapshot or host view | None |
| Explicit empty-plan creation | Shared `createPlan` service | Creation only |
| Selection, expansion, questions being typed, draft notes | Host draft persistence | None |
| Pending-row reorder | Draft `reorder_steps`, included in next request | No canonical save until request application |
| Save edits / add / remove / change effort or groups | `ChangeRequest` with `intent: edit` and operations | Edits only |
| Ask about a step | `intent: ask`, one target and isolated question | Answer or explicitly requested plan edits; no implementation |
| Refresh plan assumptions | `intent: review` | Plan freshness only |
| Split step / replan dependencies | `intent: decompose` / `replan` | Plan edits only; new work remains unselected |
| Independent plan review | `intent: review`, `review_mode: independent` | One fresh review and reconciliation, not implementation |
| Run implementation or code-review steps | `intent: implement`, selected stable IDs | Only accepted scope, subject to current user request and mode |
| Continue in fresh context | `intent: handover` plus existing transfer lifecycle | Readiness then ownership transfer; no scope expansion |
| Finish / reopen | `intent: finish` / `reopen` | Lifecycle only; reopen never restores approval |

The browser remains a published snapshot. It does not poll the filesystem. Pi can reload canonical state at settlement; this does not grant approval or erase conflicting edits.

## Capabilities and identities

A capability is `native`, `agent-mediated`, or `unsupported` with a reason. It describes availability, not permission. Agent-mediated capability requires checking the actual tools in the execution session; a browser cannot promise worker capacity or verified cancellation. Unsupported features must be reported, not simulated. Pi supplies bounded SDK implementation waves and snapshot-bound fresh reviews through explicit coordinator tools, with sequential fallback. Its separate persistent coordinator adapter provides readiness, ownership transfer, public navigation and conservative same-destination recovery. These narrower implementations do not claim a complete generic HostExecutionAdapter lifecycle.

`HostSession` pairs a host name with an unchanged native ID. The actor passed to shared mutations is the actual session/task ID, not a newly prefixed ID or another owner's identity. Native navigation URLs are generated only by the matching host adapter. Existing Codex owner strings and saved handovers retain their meaning. UI navigation never transfers ownership.

## Future assignments and evidence

`WorkAssignment` records plan/request/step identity, scope digest, actual owner, role, checkout, owned paths, acceptance criteria, evidence location and requested effort. It is bookkeeping, not approval. `AssignmentRecord` separates prepared intent, ambiguous launching, a persisted running handle and a settled correlated result. An uncertain launch must be reconciled, never blindly duplicated.

`AssignmentResult` records actual session identity, outcome, changed paths, evidence, requested/actual effort and quiescence. The coordinator checks correlation and current scope, integrates changes and verifies acceptance before any completion checkpoint. A worker's successful result is not canonical completion. An aborted call, timeout, process exit or first rejected promise alone cannot establish that all writers stopped; `Quiescence` explicitly permits an unknown state that blocks transfer and workspace reuse.

A handover destination is not a worker that returns a result: it becomes the coordinator through the existing prepare/readiness/transfer/continuation protocol. Its lifecycle must survive source cleanup. These types intentionally do not provide a launcher, ledger writer, pool, automatic recovery or task creation; the Pi-specific runner, wave, review and handover modules provide those bounded implementations.

## Supported baseline and verification

The Pi adapter is compiled against Pi/TUI **0.87.1**, whose Node baseline is **22.19+**. This is the tested baseline, not a claim that older releases cannot work. Mouse/fullscreen behavior belongs to the Pi screen and TUI integration, never to the shared core; keyboard operation remains available without fullscreen mouse support. Execution uses public SDK APIs and is verified against that pinned version rather than copied upstream private loader APIs.

Codex browser bundles and the shared CLI do not import Pi SDK/TUI modules. Host contracts have no DOM, `window.openai`, process-control or cmux dependency. Test capability failures, canonical compatibility and simulated adapter delivery separately from real host operation. A simulated browser callback is not evidence of a real Codex send dialog or conversation submission.
