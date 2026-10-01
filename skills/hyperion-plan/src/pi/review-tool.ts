import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childModelProxy } from "./model-proxy";
import { nativeReviewFiles, nativeReviewTests } from "./native-review-tests";
import { requireValue as require } from "../model";
import { canonicalPath } from "../storage";
import { PiAssignmentSupervisor, bindPiAssignmentLifecycle } from "./recovery";
import { ReviewSetup } from "./review-setup";
import { loadPlanSnapshot } from "../service";
import { assertReviewAllowed } from "./review-contract";

/** Explicit coordinator invocation only; never called by open, freshness or restoration. */
export function registerPiReviewTool(pi: ExtensionAPI): void {
  const supervisor = new PiAssignmentSupervisor();
  const setup = new ReviewSetup(pi); setup.register();
  bindPiAssignmentLifecycle(pi, supervisor);
  pi.registerTool({
    name: "hyperion_review", label: "Hyperion independent review", executionMode: "sequential",
    description: "Run only a CURRENTLY user-authorized fresh review against a captured Git snapshot. Canonical code-review selection/start or an explicit independent-plan-review request must already exist. Saved approval alone, status questions and Check plan freshness never authorize this tool. Do not use for implementation or fixes. Returns unverified correlated evidence; the coordinator must inspect it and checkpoint separately. Fixed native suites run captured trusted project tests in disposable workspaces with retained logs; no reviewer-supplied commands. Review authority includes those local tests, not an OS sandbox.",
    parameters: Type.Object({
      plan_path: Type.String(), request_id: Type.String(),
      intent: Type.Union([Type.Literal("code-review"), Type.Literal("plan-review")]),
      step_id: Type.Optional(Type.String()),
      files: Type.Array(Type.String(), { minItems: 1, maxItems: 2000, description: "Explicit repository-root-relative source files, including relevant dirty/untracked/deleted paths; no globs, dependency trees or session files." }),
      current_request_authorized: Type.Boolean({ description: "The coordinator confirms this invocation is covered by the user's explicit current review request, not merely saved approval." }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted(); ctx.signal?.throwIfAborted();
      require(params.current_request_authorized, "Explicit current review authority required");
      require(ctx.model, "No current model available for review");
      const actor = ctx.sessionManager.getSessionId(), planPath = canonicalPath(path.resolve(ctx.cwd, params.plan_path));
      const authority = () => ({ currentRunAuthorized: params.current_request_authorized && !signal?.aborted && !ctx.signal?.aborted,
        implementationAllowed: true, actorId: ctx.sessionManager.getSessionId() === actor ? actor : undefined, requestId: params.request_id });
      const guard = async () => {
        signal?.throwIfAborted(); ctx.signal?.throwIfAborted();
        const snapshot = await loadPlanSnapshot(planPath, { followRedirects: false });
        assertReviewAllowed(snapshot.plan, params.intent === "plan-review" ? `plan-review:${params.request_id}` : params.step_id!,
          { ...authority(), refreshRequired: snapshot.refresh_required }, params.intent);
      };
      await guard();
      const source = canonicalPath(execFileSync("git", ["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 5000, encoding: "utf8" }).trim());
      const files = nativeReviewFiles(source, params.files), suites = nativeReviewTests(source, files);
      // Review authority includes read-only environment discovery. Missing test
      // prerequisites are per-suite limitations, not a second permission gate.
      // Recheck cancellation/scope after discovery and again at SDK admission.
      await guard();
      const { model, runtime } = await childModelProxy(ctx, planPath);
      const record = await supervisor.review({ planPath, intent: params.intent, stepId: params.step_id,
        source, files, reviewTests: suites.tests, requiredTestIds: suites.required, attemptId: randomUUID(),
        authority,
        modelRuntime: runtime, model, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
        signal: signal && ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal ?? ctx.signal,
      });
      return { content: [{ type: "text", text: JSON.stringify({ phase: record.phase, assignment_id: record.assignment.assignment_id,
        handle: record.handle, snapshot_digest: record.review?.snapshot.digest, report: record.review_report,
        manifest_path: record.review ? path.join(record.review.snapshot.root, "manifest.json") : undefined,
        requirements_digest: record.review?.requirements_digest, checks: record.review?.checks,
        effort: record.effort, quiescence: record.result?.quiescence, controlled_tests: record.controlled_tests,
        required_test_ids: record.review?.required_test_ids ?? [],
        test_environment: { resources: suites.resolvedResources, limitations: suites.setupProblems },
        error: record.error, result_path: record.result_path,
        warning: "Evidence only; no canonical completion or fixes authorized. Required not-verified checks/blocking findings must remain incomplete." }) }], details: record };
    },
  });
}
