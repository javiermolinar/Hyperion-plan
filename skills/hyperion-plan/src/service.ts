import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Plan, record, requireValue as require, validate } from "./model";
import { parseJSON } from "./json";
import { initialize, digestText, summary } from "./transitions";
import { assertExecutionOwner } from "./handovers";
import { prNotes } from "./exports";
import {
  atomicText,
  atomicWrite,
  loadMarkdown,
  markdownStatePath,
  notesPath,
  readText,
  resolvePlanPath,
  saveMarkdown,
  withLock,
} from "./storage";

import type { PlanSnapshot, PlanMutationResult } from "./hosts/contracts";
export type { PlanSnapshot, PlanMutationResult } from "./hosts/contracts";

export type PlanMutation = (plan: Plan) => [Plan, boolean];

/** Resolve a user-selected path without scanning for plans or guessing a default. */
export function selectedPlanPath(input: string, cwd = process.cwd(), followRedirects = true): string {
  const expanded = input === "~"
    ? os.homedir()
    : input.startsWith("~/")
      ? path.join(os.homedir(), input.slice(2))
      : path.resolve(cwd, input);
  return followRedirects ? resolvePlanPath(expanded) : expanded;
}

function readSnapshot(planPath: string, refresh: boolean): PlanSnapshot {
  const isMarkdown = path.extname(planPath).toLowerCase() === ".md";
  if (isMarkdown) {
    const statePath = markdownStatePath(planPath);
    const stateBefore = fs.existsSync(statePath) ? readText(statePath) : null;
    let [plan, dirty, sourceDigest] = loadMarkdown(planPath);
    const stateAfter = fs.existsSync(statePath) ? readText(statePath) : null;
    require(stateBefore === stateAfter && digestText(readText(planPath)) === sourceDigest,
      "Plan changed while reading; retry against the latest snapshot");
    let exportWarning: string | undefined;
    if (refresh && dirty) {
      saveMarkdown(planPath, plan, sourceDigest);
      sourceDigest = digestText(readText(planPath));
      dirty = false;
      try {
        atomicText(notesPath(planPath), prNotes(plan));
      } catch (error) {
        exportWarning = `Plan is refreshed; PR notes export needs retry: ${(error as Error).message}`;
      }
    }
    return {
      path: planPath,
      plan: validate(plan),
      refresh_required: dirty,
      source_digest: sourceDigest,
      summary: summary(plan),
      ...(exportWarning ? { export_warning: exportWarning } : {}),
    };
  }

  const text = readText(planPath), before = digestText(text);
  const data = parseJSON(text);
  // Resolution happens only at the explicit-path boundary, never during a read.
  require(!record(data) || data.format !== "plan-companion-redirect",
    "Expected a canonical plan, not a migration redirect");
  const plan = validate(data);
  require(digestText(readText(planPath)) === before,
    "Plan changed while reading; retry against the latest snapshot");
  return {
    path: planPath,
    plan,
    refresh_required: false,
    source_digest: before,
    summary: summary(plan),
  };
}

/** Read without writing, or run the CLI-equivalent external-Markdown refresh. */
export async function loadPlanSnapshot(
  input: string,
  options: { cwd?: string; refresh?: boolean; actorId?: string; followRedirects?: boolean; beforeWrite?: () => void } = {},
): Promise<PlanSnapshot> {
  const planPath = selectedPlanPath(input, options.cwd, options.followRedirects);
  if (!options.refresh) return readSnapshot(planPath, false);
  require(fs.existsSync(planPath), `Plan does not exist: ${planPath}`);
  return withLock(planPath, () => {
    options.beforeWrite?.();
    const current = readSnapshot(planPath, false);
    if (!current.refresh_required) return current;
    assertExecutionOwner(current.plan, options.actorId);
    return readSnapshot(planPath, true);
  });
}

/**
 * Apply one shared-core mutation under the plan lock. The supplied transform
 * owns validation and revision semantics; this adapter owns storage and actor
 * checks only.
 */
export async function mutatePlan(
  input: string,
  actorId: string | undefined,
  mutation: PlanMutation,
  options: { cwd?: string; beforeWrite?: () => void; expectedPlanId?: string; afterWrite?: () => void; checkExecutionOwner?: boolean } = {},
): Promise<PlanMutationResult> {
  const planPath = selectedPlanPath(input, options.cwd);
  require(fs.existsSync(planPath), `Plan does not exist: ${planPath}`);
  return withLock(planPath, () => {
    // The host may have become busy or replaced its session while awaiting the lock.
    // Check before even refreshing external Markdown: refresh is also a write.
    options.beforeWrite?.();
    let current = readSnapshot(planPath, false);
    // A refresh is itself a write. Fence replacement identity before it, not
    // only in the transform that runs after external Markdown is refreshed.
    require(options.expectedPlanId === undefined || current.plan.plan_id === options.expectedPlanId,
      "The selected plan was replaced.");
    if (options.checkExecutionOwner !== false) assertExecutionOwner(current.plan, actorId);
    if (current.refresh_required) current = readSnapshot(planPath, true);
    const [candidate, changed] = mutation(current.plan);
    const plan = validate(candidate);
    let sourceDigest = current.source_digest;
    let exportWarning: string | undefined;
    if (changed) {
      if (path.extname(planPath).toLowerCase() === ".md")
        saveMarkdown(planPath, plan, current.source_digest);
      else {
        require(digestText(readText(planPath)) === current.source_digest,
          "Plan changed during this operation; refresh instead of overwriting it");
        atomicWrite(planPath, plan);
      }
      sourceDigest = digestText(readText(planPath));
      try {
        atomicText(notesPath(planPath), prNotes(plan));
      } catch (error) {
        exportWarning = `Plan is saved; PR notes export needs retry: ${(error as Error).message}`;
      }
    }
    // Host bookkeeping observes the saved canonical bytes before releasing the same lock.
    options.afterWrite?.();
    return {
      path: planPath,
      plan,
      refresh_required: false,
      source_digest: sourceDigest,
      summary: summary(plan),
      changed,
      ...(exportWarning ? { export_warning: exportWarning } : {}),
    };
  });
}

/** Create only at an explicitly selected Markdown path. */
export async function createPlan(
  input: string,
  title: string,
  options: { cwd?: string; preamble?: string; beforeWrite?: () => void } = {},
): Promise<PlanSnapshot> {
  const planPath = selectedPlanPath(input, options.cwd);
  require(path.extname(planPath).toLowerCase() === ".md", "New plans must use a .md path");
  return withLock(planPath, () => {
    // Creation may have waited for the lock; reject cancellation before any
    // canonical Markdown, sidecar, recovery copy or export is written.
    options.beforeWrite?.();
    require(!fs.existsSync(planPath), "Plan already exists; open it or choose another path");
    const plan = initialize({ title, steps: [], ...(options.preamble ? { preamble: options.preamble } : {}) });
    saveMarkdown(planPath, plan);
    let exportWarning: string | undefined;
    try {
      atomicText(notesPath(planPath), prNotes(plan));
    } catch (error) {
      exportWarning = `Plan is created; PR notes export needs retry: ${(error as Error).message}`;
    }
    return {
      path: planPath,
      plan,
      refresh_required: false,
      source_digest: digestText(readText(planPath)),
      summary: summary(plan),
      ...(exportWarning ? { export_warning: exportWarning } : {}),
    };
  });
}
