import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  Plan,
  Status,
  ExecutionState,
  requireValue as require,
  validate,
  identifier,
  record,
} from "./model";
import {
  editStep,
  editNote,
  nextSteps,
  planChanges,
  StepEdit,
  NoteEdit,
} from "./agent";
import { commandHelp, help } from "./cli-help";
import {
  initialize,
  applyRequest,
  revise,
  checkpoint,
  setLifecycle,
  reviewStep,
  updatePlanReview,
  summary,
  digestText,
} from "./transitions";
import {
  read,
  resolvePlanPath,
  canonicalPath,
  readText,
  loadMarkdown,
  saveMarkdown,
  saveRecovery,
  atomicWrite,
  atomicText,
  notesPath,
  markdownStatePath,
  migrate,
  withLock,
} from "./storage";
import { assertExecutionOwner, updateHandover, handoverBrief } from "./handovers";
import { render, prNotes, reviewBrief } from "./exports";
async function main() {
  let [command, ...argv] = process.argv.slice(2);
  if (["step", "note"].includes(command) && argv[0] && !argv[0].startsWith("-"))
    command += " " + argv.shift();
  if (
    !command ||
    ["--help", "-h"].includes(command) ||
    argv.some((v) => v === "--help" || v === "-h")
  ) {
    if (command && !["--help", "-h", "step", "note"].includes(command))
      require(Object.hasOwn(commandHelp, command), "Unknown command: " +
        command);
    console.log(help(["--help", "-h"].includes(command) ? undefined : command));
    return;
  }
  require(Object.hasOwn(commandHelp, command), "Unknown command: " +
    command +
    "; use --help");
  const options = Object.fromEntries(
    ["plan", ...Object.keys(commandHelp[command].options)].map((k) => [
      k,
      {
        type: ["preview", "dry-run"].includes(k)
          ? ("boolean" as const)
          : ("string" as const),
      },
    ]),
  );
  const { values: v } = parseArgs({ args: argv, options, strict: true });
  const arg = (k: string) =>
    typeof v[k] === "string" ? (v[k] as string) : undefined;
  require(arg("plan"), "Missing --plan");
  for (const key of ["init", "revise", "plan-review", "handover"].includes(command)
    ? ["input"]
    : command === "apply"
      ? ["request"]
      : ["render", "migrate", "handover-brief"].includes(command)
        ? ["output"]
        : [])
    require(arg(key), `Missing --${key}`);
  const revision =
    arg("base-revision") !== undefined
      ? Number(arg("base-revision"))
      : undefined;
  const targeted = command.startsWith("step ") || command.startsWith("note ");
  if (["revise", "checkpoint", "review", "finish", "reopen", "plan-review", "handover"].includes(command) || targeted)
    require(Number.isSafeInteger(
      revision,
    ), "Missing or invalid --base-revision");
  if (["review", "review-brief"].includes(command) || targeted)
    require(arg("step-id"), "Missing --step-id");
  if (command === "review") {
    require(arg("state"), "Missing --state");
    require(arg("note") !== undefined, "Missing --note");
  }
  if (command.startsWith("note ")) {
    require(arg("note-id"), "Missing --note-id");
    require((arg("text") !== undefined) !==
      (arg("text-file") !==
        undefined), "Supply exactly one of --text or --text-file");
  }
  if (command === "handover-brief") require(arg("request-id"), "Missing --request-id");
  const actor = arg("task-id") ?? process.env.CODEX_THREAD_ID;
  const writesPlan = !["status", "show", "next", "render", "export", "review-brief", "handover-brief"].includes(command);
  const dryRun = !!v["dry-run"],
    readOnly = dryRun || ["show", "next"].includes(command);
  let p = path.resolve(arg("plan")!);
  if (command !== "migrate") p = resolvePlanPath(p);
  const execute = async () => {
    const exporting = ["render", "export", "review-brief", "handover-brief"].includes(command);
    const exportOutput = exporting
      ? (arg("output") ??
        (command === "export"
          ? notesPath(p)
          : path.join(
              path.dirname(p),
              path.parse(p).name +
                "-review-" +
                identifier(arg("step-id")) +
                ".md",
            )))
      : undefined;
    if (exportOutput !== undefined)
      require(![p, markdownStatePath(p)]
        .map(canonicalPath)
        .includes(
          canonicalPath(exportOutput),
        ), "Output must not overwrite plan storage");
    if (command === "migrate") {
      const plan = await migrate(p, arg("output")!);
      console.log(
        JSON.stringify({
          plan_path: path.resolve(arg("output")!),
          revision: plan.revision,
          result: "migrated",
        }),
      );
      return;
    }
    const markdown = path.extname(p).toLowerCase() === ".md";
    let sourceDigest: string | undefined,
      current: Plan | undefined,
      refreshRequired = false;
    if (command !== "init") {
      if (markdown) {
        const stateBefore =
          readOnly && fs.existsSync(markdownStatePath(p))
            ? readText(markdownStatePath(p))
            : null;
        let dirty: boolean;
        [current, dirty, sourceDigest] = loadMarkdown(p);
        refreshRequired = dirty;
        if (writesPlan) assertExecutionOwner(current, actor);
        if (readOnly) {
          const stateAfter = fs.existsSync(markdownStatePath(p))
            ? readText(markdownStatePath(p))
            : null;
          require(stateAfter === stateBefore &&
            digestText(readText(p)) ===
              sourceDigest, "Plan changed while reading; retry against the latest snapshot");
        } else if (dirty) {
          saveMarkdown(p, current, sourceDigest);
          sourceDigest = digestText(readText(p));
          atomicText(notesPath(p), prNotes(current));
        } else {
          const text = readText(p);
          require(digestText(text) ===
            sourceDigest, "Markdown changed during this operation; refresh instead of overwriting it");
          saveRecovery(p, text, sourceDigest);
        }
      } else { current = validate(read(p)); if (writesPlan) assertExecutionOwner(current, actor); }
    }
    if (command === "show") {
      const { applied_requests, ...publicPlan } = current!;
      const id = arg("step-id");
      const step =
        id === undefined
          ? undefined
          : current!.steps.find((s) => s.id === identifier(id));
      require(id === undefined || step, `Unknown step: ${id}`);
      console.log(
        JSON.stringify(
          {
            plan_id: current!.plan_id,
            revision: current!.revision,
            plan_path: p,
            refresh_required: refreshRequired,
            ...(id === undefined ? { plan: publicPlan } : { step }),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === "next") {
      console.log(
        JSON.stringify(
          { ...nextSteps(current!, refreshRequired), plan_path: p },
          null,
          2,
        ),
      );
      return;
    }
    if (command === "status") {
      console.log(
        JSON.stringify(
          {
            ...summary(current!),
            plan_path: path.resolve(p),
            pr_notes_path: path.resolve(notesPath(p)),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (["render", "export", "review-brief", "handover-brief"].includes(command)) {
      const output = exportOutput!;
      atomicText(
        output,
        command === "render"
          ? render(current!, p, !!v.preview)
          : command === "export"
            ? prNotes(current!)
            : command === "handover-brief" ? handoverBrief(current!, arg("request-id")!) : reviewBrief(current!, arg("step-id")!),
      );
      console.log(path.resolve(output));
      return;
    }
    let plan: Plan,
      changed: boolean,
      request: Record<string, unknown> | undefined;
    if (command === "init") {
      require(!fs.existsSync(p), "Plan already exists; use revise");
      plan = initialize(read(arg("input")!));
      changed = true;
    } else if (command === "apply") {
      request = read(arg("request")!) as Record<string, unknown>;
      [plan, changed] = applyRequest(current!, request);
    } else if (command.startsWith("step ")) {
      const action = command.slice(5) as StepEdit["action"];
      const edit = {
        action,
        stepId: arg("step-id")!,
        placement: { before: arg("before"), after: arg("after") },
      };
      if (action === "add" || action === "update") {
        const fields = arg("input") ? read(arg("input")!) : {};
        require(record(fields), "Expected a JSON object of step fields");
        for (const [flag, field] of [
          ["title", "title"],
          ["description", "description"],
          ["done-when", "done_when"],
        ])
          if (arg(flag) !== undefined) fields[field] = arg(flag);
        [plan, changed] = editStep(current!, revision!, {
          ...edit,
          action,
          fields,
        });
      } else
        [plan, changed] = editStep(current!, revision!, { ...edit, action });
    } else if (command.startsWith("note ")) {
      [plan, changed] = editNote(current!, revision!, {
        action: command.slice(5) as NoteEdit["action"],
        stepId: arg("step-id")!,
        noteId: arg("note-id")!,
        text: arg("text") ?? readText(arg("text-file")!),
      });
    } else if (command === "finish" || command === "reopen")
      [plan, changed] = setLifecycle(current!, revision!, command === "finish" ? "finished" : "active");
    else if (command === "checkpoint")
      [plan, changed] = checkpoint(
        current!,
        revision!,
        arg("step-id"),
        arg("status") as Status | undefined,
        arg("note"),
        arg("blocked-by"),
        arg("execution-state") as ExecutionState | undefined,
      );
    else if (command === "handover")
      [plan, changed] = updateHandover(current!, revision!, read(arg("input")!), actor);
    else if (command === "plan-review")
      [plan, changed] = updatePlanReview(current!, revision!, read(arg("input")!));
    else if (command === "review")
      [plan, changed] = reviewStep(
        current!,
        revision!,
        arg("step-id")!,
        arg("state") as "current" | "needs_review",
        arg("note")!,
      );
    else {
      plan = revise(current!, read(arg("input")!) as Plan, revision!);
      changed = true;
    }
    if (dryRun) {
      console.log(
        JSON.stringify(
          {
            plan_id: plan.plan_id,
            base_revision: current?.revision ?? null,
            result: "preview",
            would_change: changed,
            proposed_revision: plan.revision,
            refresh_required: refreshRequired,
            changes: planChanges(current, plan),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (changed) {
      if (markdown) saveMarkdown(p, plan, sourceDigest);
      else atomicWrite(p, plan);
    }
    const result: Record<string, unknown> = {
      plan_id: plan.plan_id,
      revision: plan.revision,
      result: changed
        ? "saved"
        : command === "apply"
          ? "already_applied"
          : "unchanged",
    };
    if (targeted) result.changes = planChanges(current, plan);
    if (command === "finish" || command === "reopen" || request?.intent === "finish" || request?.intent === "reopen") {
      result.lifecycle = plan.lifecycle ?? "active";
      result.render_policy = plan.lifecycle === "finished" ? "on_request" : "on_change";
    }
    try {
      atomicText(notesPath(p), prNotes(plan));
      result.pr_notes_path = path.resolve(notesPath(p));
    } catch (e) {
      result.export_warning = `Plan is saved; PR notes export needs retry: ${(e as Error).message}`;
    }
    if (command === "apply") {
      result.intent = request!.intent ?? "edit";
      result.selected_step_ids = changed
        ? (request!.selected_step_ids ?? [])
        : [];
      result.target_step_ids = changed ? (request!.target_step_ids ?? []) : [];
    }
    console.log(JSON.stringify(result));
  };
  if (readOnly) await execute();
  else await withLock(p, execute);
}
main().catch((e) => {
  console.error("Error: " + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
