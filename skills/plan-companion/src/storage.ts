import * as fs from "node:fs";
import { parseJSON } from "./json";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import {
  Plan,
  Status,
  Execution,
  validate,
  requireValue as require,
  clone,
  preserveHistory,
  invalidateDependents,
  equal,
  record,
  identifier,
} from "./model";
import { digestText, stepFingerprint } from "./transitions";
import { loads, dumps, uuid5 } from "./markdown";
import { prNotes } from "./exports";
export const readText = (p: string) =>
  fs.readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
export const markdownStatePath = (p: string) =>
  path.join(path.dirname(p), path.parse(p).name + ".state.json");
export const recoveryDirectory = (p: string) =>
  path.join(path.dirname(p), ".plan-history", path.parse(p).name + "-recovery");
export const notesPath = (p: string) =>
  path.join(path.dirname(p), path.parse(p).name + "-pr-notes.md");
export function resolvePlanPath(input: string): string {
  let p = path.resolve(input);
  const seen = new Set<string>();
  while (fs.existsSync(p) && path.extname(p).toLowerCase() === ".json") {
    const real = fs.realpathSync(p);
    require(!seen.has(real), "Migration redirect cycle");
    seen.add(real);
    const value: unknown = parseJSON(readText(p));
    if (!record(value) || value.format !== "plan-companion-redirect") break;
    require(typeof value.migrated_to ===
      "string", "Invalid migration destination");
    p = path.resolve(path.dirname(p), value.migrated_to);
  }
  return p;
}
/** Resolve existing ancestors too, so new destinations cannot hide behind aliases. */
export function canonicalPath(input: string): string {
  const p = path.resolve(input);
  try {
    return fs.realpathSync(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(p);
    if (parent === p) throw error;
    return path.join(canonicalPath(parent), path.basename(p));
  }
}
export function atomicText(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), ".plan-" + randomUUID());
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, p);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export const atomicWrite = (p: string, value: unknown) =>
  atomicText(p, JSON.stringify(value, null, 2) + "\n");
export function saveRecovery(
  p: string,
  text: string,
  preserveDigest?: string,
): void {
  const dir = recoveryDirectory(p),
    current = path.join(dir, "current.md");
  if (fs.existsSync(current)) {
    const previous = readText(current);
    if (previous === text) return;
    const prev = path.join(dir, "previous.md");
    const preservePrevious =
      preserveDigest !== undefined &&
      fs.existsSync(prev) &&
      digestText(readText(prev)) === preserveDigest &&
      digestText(previous) !== preserveDigest;
    if (!preservePrevious) atomicText(prev, previous);
  }
  atomicText(current, text);
}
interface State {
  schema_version: 1;
  plan_id: string;
  revision: number;
  source_digest: string;
  applied_requests: Record<string, string>;
  steps: Record<string, { status: Status; scope: string }>;
  execution?: Execution;
}
function readState(p: string): State | undefined {
  if (!fs.existsSync(p)) return;
  const value: unknown = parseJSON(readText(p));
  require(record(value), "Invalid execution state file");
  const state = value as unknown as State;
  identifier(state.plan_id);
  require(Number.isSafeInteger(state.revision) &&
    state.revision >= 1, "Invalid saved revision");
  require(typeof state.source_digest === "string" &&
    /^[a-f0-9]{64}$/.test(state.source_digest), "Invalid source digest");
  require(record(state.steps), "Invalid saved step records");
  for (const [id, step] of Object.entries(state.steps)) {
    identifier(id);
    require(record(step) &&
      ["pending", "in_progress", "completed"].includes(step.status) &&
      typeof step.scope === "string" &&
      /^[a-f0-9]{64}$/.test(step.scope), "Invalid saved step record");
  }
  return state;
}
export function loadMarkdown(p: string): [Plan, boolean, string] {
  const text = readText(p),
    sourceDigest = digestText(text),
    fallbackId = uuid5(fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
  const result = loads(text, fallbackId),
    state = readState(markdownStatePath(p));
  let dirty = !state;
  if (state) {
    require(state.plan_id ===
      result.plan_id, "Markdown and execution state belong to different plans");
    result.applied_requests = state.applied_requests ?? {};
    if (sourceDigest === state.source_digest) {
      require(result.revision ===
        state.revision, "Inconsistent saved Markdown revision");
      require(equal(
        Object.fromEntries(result.steps.map((s) => [s.id, s.status])),
        Object.fromEntries(
          Object.entries(state.steps).map(([id, s]) => [id, s.status]),
        ),
      ), "Saved Markdown task records do not match execution state; restore the missing or changed rows");
      if (state.execution != null) result.execution = state.execution;
    } else {
      try {
        preserveHistory(state.steps ?? {}, result.steps);
      } catch (e) {
        throw new Error(
          `${(e as Error).message}. Restore the missing rows before refreshing; recovery copies, when available, are in ${recoveryDirectory(p)}`,
        );
      }
      dirty = true;
      result.revision = state.revision + 1;
      const changed = new Set<string>();
      for (const step of result.steps) {
        const old = Object.hasOwn(state.steps, step.id)
          ? state.steps[step.id]
          : undefined;
        if (!old) {
          if (step.status === "completed") step.completion_source = "user";
          continue;
        }
        const fp = stepFingerprint(step);
        if (old.status !== step.status) {
          changed.add(step.id);
          step.completion_source = step.status === "completed" ? "user" : null;
          delete step.progress_note;
          delete step.blocked_by;
          if (step.status === "completed") {
            step.review_state = "current";
            delete step.review_note;
          }
        }
        if (old.scope !== fp.scope) {
          changed.add(step.id);
          if (step.status !== "completed") {
            step.review_state = "needs_review";
            step.review_note =
              "Edited in Markdown. Check the updated scope and notes before running.";
          } else {
            step.completion_source = "user";
            delete step.progress_note;
          }
        }
      }
      validate(result);
      invalidateDependents(
        result,
        changed,
        "A prerequisite was edited in Markdown. Recheck this step.",
      );
      if (state.execution != null) {
        result.execution = clone(state.execution);
        const remaining = new Set(
          result.steps.filter((s) => !changed.has(s.id)).map((s) => s.id),
        );
        result.execution.selected_step_ids =
          state.execution.selected_step_ids.filter((id) => remaining.has(id));
      }
    }
  } else
    for (const step of result.steps)
      if (step.status === "completed" && !("completion_source" in step))
        step.completion_source = "user";
  // Direct Markdown closure and recovery after an interrupted finish must also
  // withhold the old selection, even when the sidecar has not caught up yet.
  if (result.lifecycle === "finished") delete result.execution;
  return [validate(result), dirty, sourceDigest];
}
/** writeState is injectable for testing interruption between canonical and sidecar writes. */
export function saveMarkdown(
  p: string,
  plan: Plan,
  expectedDigest?: string,
  writeState = atomicWrite,
): void {
  validate(plan);
  const statePath = markdownStatePath(p),
    previousState = readState(statePath);
  if (previousState) {
    require(previousState.plan_id ===
      plan.plan_id, "Markdown and execution state belong to different plans");
    preserveHistory(previousState.steps ?? {}, plan.steps);
  }
  const checkDigest = () => {
    if (expectedDigest !== undefined)
      require(fs.existsSync(p) &&
        digestText(readText(p)) ===
          expectedDigest, "Markdown changed during this operation; refresh instead of overwriting it");
  };
  checkDigest();
  const text = dumps(plan);
  const roundTrip = validate(loads(text, plan.plan_id));
  require(equal(
    roundTrip.steps.map((s) => [s.id, s.status]),
    plan.steps.map((s) => [s.id, s.status]),
  ), "Markdown serialization changed task identity or status; source was not changed");
  const state: State = {
    schema_version: 1,
    plan_id: plan.plan_id,
    revision: plan.revision,
    source_digest: digestText(text),
    applied_requests: plan.applied_requests ?? {},
    steps: Object.fromEntries(
      plan.steps.map((s) => [s.id, stepFingerprint(s)]),
    ),
  };
  if (plan.execution != null) state.execution = plan.execution;
  if (previousState && fs.existsSync(p)) {
    const previousText = readText(p);
    if (digestText(previousText) === previousState.source_digest)
      saveRecovery(p, previousText, previousState.source_digest);
  }
  saveRecovery(p, text, previousState?.source_digest);
  checkDigest();
  atomicText(p, text);
  writeState(statePath, state);
}
export function read(p: string): unknown {
  p = resolvePlanPath(p);
  return path.extname(p).toLowerCase() === ".md"
    ? loadMarkdown(p)[0]
    : parseJSON(readText(p));
}
/** A short-lived directory lock; no daemon. Legacy Python writers must be stopped during migration. */
export async function withLock<T>(
  p: string,
  action: () => T | Promise<T>,
): Promise<T> {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const canonical = fs.existsSync(p)
    ? fs.realpathSync(p)
    : path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  const release = await lockfile.lock(canonical, {
    realpath: false,
    lockfilePath: canonical + ".lockdir",
    stale: 30000,
    update: 10000,
    retries: { retries: 100, minTimeout: 50, maxTimeout: 100, factor: 1 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}
export async function migrate(source: string, output: string): Promise<Plan> {
  output = path.resolve(output);
  require(path.extname(output).toLowerCase() ===
    ".md", "Migration output must be Markdown");
  const resolved = resolvePlanPath(source);
  if (path.resolve(resolved) !== path.resolve(source)) {
    require(path.resolve(resolved) ===
      output, "Plan was already migrated to another path");
    return validate(read(output));
  }
  require(path.extname(source).toLowerCase() ===
    ".json", "Migrate a legacy JSON plan");
  const sourcePlan = validate(read(source)),
    plan = clone(sourcePlan);
  plan.revision++;
  return withLock(output, () => {
    if (fs.existsSync(output))
      require(equal(
        read(output),
        plan,
      ), "Migration destination already contains a different plan");
    else {
      require(!fs.existsSync(
        markdownStatePath(output),
      ), "Destination has existing execution state");
      saveMarkdown(output, plan);
    }
    require(equal(
      read(output),
      plan,
    ), "Migration verification failed; original plan was preserved");
    const archive = path.join(
      path.dirname(source),
      ".plan-history",
      `${path.parse(source).name}-r${sourcePlan.revision}.json`,
    );
    if (fs.existsSync(archive))
      require(equal(
        parseJSON(readText(archive)),
        sourcePlan,
      ), "Migration archive already contains different data");
    else atomicWrite(archive, sourcePlan);
    atomicWrite(source, {
      format: "plan-companion-redirect",
      plan_id: plan.plan_id,
      migrated_to: output,
    });
    atomicText(notesPath(output), prNotes(plan));
    return plan;
  });
}
