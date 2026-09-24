# Parallel execution

Read this when an applied implementation request selects `execution_mode: "auto"` or `"parallel"`. Use available subagent tools such as `spawn_agent` for bounded implementation work in the current task. Do not create user-facing tasks for parallel workers; the existing independent-review and handover workflows retain their own authorized fresh-task behavior.

The card and CLI record the preference and readiness; the coordinator dispatches the work during an authorized implementation turn. They do not start a daemon or guarantee concurrency. New cards use auto: the model decides whether delegation is worthwhile; there is no user toggle. Explicit sequential mode and absent legacy mode mean sequential. A saved parallel preference does not resume a paused run or authorize work beyond the selected steps.

## Choose and dispatch a wave

1. Read `status`, the selected steps, and `next`. Reconcile any required refresh first. `next.execution_mode` reports the effective mode; `parallel_candidates` contains ready selected implementation steps in auto or parallel mode. Prerequisites must already be complete, and blockers or freshness warnings prevent readiness. In-progress steps are reported separately and must not be redispatched.
2. Inspect the candidates' actual files, interfaces, generated outputs, tests, and shared resources. Missing dependency edges do not prove independence. Assign disjoint ownership where practical; serialize overlapping changes or shared-resource operations unless a concrete isolation and integration strategy makes them safe. Keep the plan's recorded dependencies accurate when discovering an actual ordering requirement.
3. Choose a wave within the host's available agent capacity, allowing for the coordinator and existing workers. Checkpoint each step as `in_progress` immediately before dispatch. Give its worker the stable step ID, exact authorized scope, relevant context, file ownership, acceptance criteria, checks, and required result evidence. Explicitly prohibit canonical plan mutations and work outside that assignment. Apply the step's effort preference only through a supported tool parameter; report limitations honestly.
4. Persist the actual agent ID and assignment immediately after dispatch. Use a durable dispatch ledger beside the canonical plan, linked from progress notes, with plan/request IDs, step IDs, owned files, agent IDs, status, and result/evidence paths. Keep dispatch status and returned evidence current. This ledger is coordinator bookkeeping, not another plan or a new source of authorization.

If subagent tools are unavailable, capacity is exhausted, or no candidates can safely overlap, state the constraint and perform the approved work sequentially. Do not describe sequential execution as parallel. Do not ask for new approval merely to serialize the same approved scope.

## Integrate and verify

Workers return changed files, behavior delivered, checks run with their results, unresolved risks, and any incomplete acceptance criteria. The coordinator remains the single writer of the canonical plan and the only agent recording completion. Inspect worker changes, reconcile conflicts without discarding unrelated work, and run checks appropriate to the integrated result. A worker reporting success is evidence to assess, not completion by itself.

Save each verified outcome at its step boundary. Keep incomplete work in progress with observed blockers or partial evidence. Re-read `next` after integration before dispatching another wave; completion can change dependency readiness and freshness. Never expand selected scope to fill spare capacity.

## Barriers, retries, and ownership

- Treat the first unfinished selected review or handover as a barrier. No implementation after that point may run concurrently with earlier work or cross the barrier. Drain all workers and finish integration and verification before running the review or transferring execution. Follow the existing review and handover references; selection of a review does not authorize fixes.
- Before a retry or after compaction, reconcile the ledger, canonical step state, actual worker status, and working-tree changes. Reuse a known live worker or its returned evidence. Do not spawn duplicate work merely because an implementation request was retried or a response was lost. When dispatch status is ambiguous, resolve it before assigning the same files again.
- On pause, cancellation, scope change, or handover, stop dispatch and quiesce affected workers. Interrupt them when necessary and verify that they have stopped writing before integrating or transferring ownership. Record outstanding changes and evidence. Never transfer a checkout while a source worker can still write to it, and never resume those workers after transfer. Preserve the ledger path and actual agent IDs in the continuation brief.
