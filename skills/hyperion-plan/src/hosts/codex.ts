import type { PlanUiAdapter, PlanSubmission, HostCapabilities } from "./contracts";
import { requestInstructions } from "../instructions";
import { OWNERSHIP_INSTRUCTIONS } from "../execution-instructions";

/** Keep the published widget draft encoding compatible with existing cards. */
export interface CodexDraft {
  modelContent?: {
    kind: string;
    ui_version: number;
    plan_id: string;
    base_revision: number;
    operations: unknown;
    selected_step_ids?: string[];
  };
  privateContent?: {
    handover_reason?: string;
    questions?: Record<string, string>;
    highlighted_group?: number;
    execution_mode?: "auto" | "sequential" | "parallel";
    review_focus?: string;
    expanded?: string[];
    milestones?: Record<string, boolean>;
    settings?: string[];
    request_ids?: Record<string, string | null>;
    note_editors?: { step_id: string; id: string }[];
  };
}

interface CodexBridge {
  widgetState?: CodexDraft;
  setWidgetState?: (state: unknown) => Promise<void> | undefined;
  sendFollowUpMessage?: (message: { prompt: string; title?: string }) => Promise<void>;
}

export interface CodexRuntime {
  openai?: CodexBridge;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

declare global {
  interface Window { openai?: CodexBridge }
}

export const CODEX_SUBMISSION_UNAVAILABLE = "Open this card inside Codex to submit. Your edits and selection are preserved.";

export function codexPrompt(submission: PlanSubmission): string {
  return "Use $hyperion-plan. Read the skill at " + submission.skill_path +
    ".\nPlan file: " + submission.plan_path +
    "\nAdapt explanations and necessary questions to the user’s demonstrated familiarity with this task. Short messages alone do not imply low expertise. For unfamiliar users, clarify functional goals and explain architectural tradeoffs in plain language; do not repeat resolved questions.\n" +
    requestInstructions(submission.request, { freshTask: "fresh Codex task", freshTasks: "fresh Codex tasks" }) +
    "\n" + OWNERSHIP_INSTRUCTIONS + "\n\nChange request JSON:\n" +
    JSON.stringify(submission.request, null, 2);
}

/** The browser bridge delivers requests. Only the coordinator can confirm a save. */
export function createCodexUiAdapter(runtime: CodexRuntime): PlanUiAdapter<CodexDraft> {
  return {
    capabilities(): HostCapabilities {
      return {
        submission: typeof runtime.openai?.sendFollowUpMessage === "function"
          ? { mode: "native" } : { mode: "unsupported", reason: CODEX_SUBMISSION_UNAVAILABLE },
        draftPersistence: typeof runtime.openai?.setWidgetState === "function"
          ? { mode: "native" } : { mode: "unsupported", reason: "Host draft storage is unavailable; keep local drafts." },
        sessionNavigation: { mode: "native" },
        workers: { mode: "agent-mediated" },
        independentReviews: { mode: "agent-mediated" },
        handovers: { mode: "agent-mediated" },
        effortControl: { mode: "agent-mediated" },
        verifiedCancellation: { mode: "agent-mediated" },
      };
    },
    readDraft: () => runtime.openai?.widgetState,
    async saveDraft(draft) {
      // Missing storage has always meant local-only drafts in published cards.
      await runtime.openai?.setWidgetState?.(draft);
    },
    onDraft(listener) {
      const receive = (event: Event) => listener(
        (event as CustomEvent<{ globals?: { widgetState?: CodexDraft } }>).detail?.globals?.widgetState,
      );
      runtime.addEventListener("openai:set_globals", receive);
      return () => runtime.removeEventListener("openai:set_globals", receive);
    },
    async submit(submission) {
      const bridge = runtime.openai;
      if (typeof bridge?.sendFollowUpMessage !== "function") throw new Error(CODEX_SUBMISSION_UNAVAILABLE);
      await bridge.sendFollowUpMessage({ prompt: codexPrompt(submission), title: submission.title });
      return { phase: "delivered", request_id: submission.request.request_id };
    },
    sessionLink(session) {
      return session.host === "codex" ? `codex://threads/${encodeURIComponent(session.native_id)}` : undefined;
    },
  };
}
