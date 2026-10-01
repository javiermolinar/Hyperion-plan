import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { EffortEvidence } from "../hosts/contracts";
import type { ReasoningEffort } from "../model";
import { requireValue as require } from "../model";

type Level = AgentSession["thinkingLevel"];
type EffortSession = Pick<AgentSession, "thinkingLevel" | "model" | "isIdle" | "getAvailableThinkingLevels" | "setThinkingLevel" | "waitForIdle" | "abort">;
const leases = new WeakSet<EffortSession>();

/** Resolve against the actual session's public SDK capability list, never clamp. */
export function applySessionEffort(session: EffortSession, requested: ReasoningEffort, original: Level): EffortEvidence {
  require(session.isIdle, "Effort must be applied at an idle model-turn boundary");
  const before = session.thinkingLevel;
  const candidate = requested === "inherit" ? original : requested === "none" ? "off" : requested;
  const supported = session.getAvailableThinkingLevels();
  let limitation: string | undefined;
  if (!supported.includes(candidate as Level)) {
    limitation = `Requested ${requested} (${candidate}) is unsupported; retained ${before}.`;
  } else {
    session.setThinkingLevel(candidate as Level, { persist: false });
    if (session.thinkingLevel !== candidate) {
      session.setThinkingLevel(before, { persist: false });
      limitation = `SDK did not apply ${candidate}; restored ${session.thinkingLevel}.`;
    }
  }
  return { requested, actual: session.thinkingLevel, baseline: original,
    model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    ...(limitation ? { limitation } : {}) };
}

/** One controller per coordinator session. Captures its original setting once. */
export function createSessionEffortController(session: EffortSession) {
  const original = session.thinkingLevel;
  return {
    original,
    async run<T>(requested: ReasoningEffort, task: (evidence: EffortEvidence) => Promise<T>, signal?: AbortSignal): Promise<T> {
      require(!leases.has(session), "An effort scope already owns this session");
      require(session.isIdle, "Effort must be applied at an idle model-turn boundary");
      signal?.throwIfAborted();
      leases.add(session);
      let abort: Promise<void> | undefined;
      let abortError: unknown;
      const cancel = () => { abort ??= session.abort().catch(error => { abortError = error; }); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const evidence = applySessionEffort(session, requested, original);
        const result = await task(evidence);
        signal?.throwIfAborted();
        return result;
      } finally {
        signal?.removeEventListener("abort", cancel);
        try {
          await abort;
          await session.waitForIdle();
          // A model change may make the original setting unavailable. Do not
          // silently clamp a restored preference either; return a concrete error.
          require(session.getAvailableThinkingLevels().includes(original), `Cannot restore original effort ${original} on the current model`);
          session.setThinkingLevel(original, { persist: false });
          require(session.thinkingLevel === original, "SDK did not restore original effort");
          if (abortError) throw abortError;
        } finally { leases.delete(session); }
      }
    },
  };
}
