# Pi host-owned handoff

Hyperion no longer creates, supervises or navigates Pi coordinator handovers. The `hyperion_handover` tool, its command routes and standalone runtime bundles are removed. A generic worker is not a new coordinator.

Ordinary Pi sessions do not own plans. Under current user permission, continue in another session with the same canonical plan and checkout after settling actual writers; a brief may carry requirements and evidence. No prepare/readiness/ownership handshake is required merely to change coordinator sessions. Never infer execution permission from stored approval or automatically resume work.

Ownership belongs to agent assignments in their original coordinator/request cohort: file claims and live/unknown-writer fences remain until observed settlement. A new session does not adopt, relaunch or certify another session's uncertain children. Pi does not provide global workspace arbitration.

Read-only inspection preserves legacy `execution_owner`, handover events and `hyperion.handover*` tags as history, not permission gates. A successful explicit Pi plan mutation removes the saved owner and cancels unfinished ad-hoc coordinator handshakes with a retirement note. It does not claim ownership transfer, writer settlement or fresh execution approval; runtime evidence is retained and checked separately. The old tags no longer block unrelated tools or user bash.

Explicit `kind: "handover"` plan checkpoints remain real boundaries. They still use the [shared transfer lifecycle](handovers.md); do not complete or skip one manually. Shared CLI/Codex ownership behavior, paused/cancelled execution and checkpoint ordering are unchanged.

Before upgrading/reloading, reconcile old active work using the old version/owning host. Preserve `.hyperion-dispatch` records and transcripts. The executor reads historical lifecycle state only: unknown writers, unfinished handovers, malformed records and unreconciled waves hold new Pi execution. It does not repair phases, adopt destinations, relaunch work or certify old reports. A missing process or new installation is not settlement evidence. Read-only inspection remains available.
