# Pi host-owned handoff

Hyperion no longer creates, supervises or navigates Pi coordinator handovers. The `hyperion_handover` tool, its command routes and standalone runtime bundles are removed. A generic worker is not a new coordinator.

Use an available host facility only under the user's current handoff/session permission. It must support the shared protocol: verified source-writer settlement, fresh destination context, read-only readiness, canonical ownership transfer using actual native identities, then destination continuation and source inactivity. See [shared handovers](handovers.md). Do not substitute history forking, independent terminal creation or worker success for this protocol. If the host cannot support it, leave the checkpoint incomplete and report the limitation. Do not manually complete it or silently skip it to execute later work.

Shared canonical handover records, owner checks, paused/cancelled state and checkpoint ordering remain unchanged for CLI/Codex compatibility. Existing `hyperion.handover` and `hyperion.handover-source` session tags still fence source model tools and user bash across branch changes. Navigation alone never transfers ownership.

Before upgrading/reloading, reconcile old active work using the old version/owning host. Preserve `.hyperion-dispatch` records and transcripts. The executor reads historical lifecycle state only: unknown writers, unfinished handovers, malformed records and unreconciled waves hold new Pi execution. It does not repair phases, adopt destinations, relaunch work or certify old reports. A missing process or new installation is not settlement evidence. Read-only inspection remains available.
