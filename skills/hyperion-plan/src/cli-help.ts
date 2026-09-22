interface CommandHelp {
  summary: string;
  options: Record<string, string>;
  example?: string;
}
const revision = {
  "base-revision":
    "Current revision from status/show; stale writes are rejected.",
};
const dryRun = {
  "dry-run":
    "Preview validated changes without writing plans, receipts, exports, recovery files, or locks.",
};
const stepId = { "step-id": "Stable step ID, never a displayed step number." };
const placement = {
  before: "Place before this stable step ID.",
  after: "Place after this stable step ID (exclusive with --before).",
};
const fields = {
  input: "JSON file of step fields; see references/agent-cli.md.",
  title: "Set the title.",
  description: "Set the description.",
  "done-when":
    "Set the acceptance criteria. Text flags override fields from --input.",
};
const note = {
  ...stepId,
  "note-id": "Stable note ID (required).",
  text: "Note text, or the response for note reply.",
  "text-file": "Read literal UTF-8 text from a file instead of --text.",
};
export const commandHelp: Record<string, CommandHelp> = {
  "plan-review": {
    summary: "Record an independent plan review's progress or reconciled findings.",
    options: { ...revision, input: "JSON update: request_id, state, task_id, report_path, note, findings.", ...dryRun },
  },
  init: {
    summary: "Create a plan from a Markdown or JSON draft.",
    options: { input: "Draft file (required).", ...dryRun },
  },
  status: {
    summary: "Refresh Markdown bookkeeping and report progress/approved scope.",
    options: {},
  },
  show: {
    summary: "Read full plan or step details without writing files.",
    options: { ...stepId },
    example: "show --plan plan.md --step-id api",
  },
  next: {
    summary:
      "Read approved ready work, active work, and blockers in plan order. Does not start or authorize work.",
    options: {},
  },
  apply: {
    summary: "Apply an explicit card request with idempotent receipts.",
    options: { request: "Change-request JSON file (required).", ...dryRun },
    example: "apply --plan plan.md --request request.json --dry-run",
  },
  revise: {
    summary:
      "Replace plan content while preserving history and invalidating changed approval.",
    options: {
      input: "Revised Markdown or JSON file (required).",
      ...revision,
      ...dryRun,
    },
  },
  checkpoint: {
    summary:
      "Record approved work starting, completing, becoming blocked, or changing execution state.",
    options: {
      ...revision,
      ...stepId,
      status: "pending, in_progress, or completed.",
      note: "Progress or completion evidence (required when completing).",
      "blocked-by": "Blocker text; an empty string clears it.",
      "execution-state":
        "approved, paused, or cancelled; only change when the user requests it.",
      ...dryRun,
    },
  },
  finish: {
    summary: "Finish a plan, preserve task history, and stop automatic cards. Clears implementation approval; unfinished tasks stay unfinished.",
    options: { ...revision, ...dryRun },
    example: "finish --plan plan.md --base-revision 4",
  },
  reopen: {
    summary: "Reactivate a finished plan without restoring implementation approval.",
    options: { ...revision, ...dryRun },
    example: "reopen --plan plan.md --base-revision 5",
  },
  review: {
    summary:
      "Record plan freshness; this does not run an independent code review or grant approval.",
    options: {
      ...revision,
      ...stepId,
      state: "current or needs_review (required).",
      note: "Evidence or reason (required).",
      ...dryRun,
    },
  },
  render: {
    summary:
      "Render a fresh card using the installed renderer; existing published cards remain snapshots.",
    options: {
      output: "New HTML output path (required).",
      preview: "Label as a demo and disable conversation submission.",
    },
  },
  export: {
    summary: "Export plan context to Markdown PR notes.",
    options: { output: "Optional output path; defaults beside the plan." },
  },
  "review-brief": {
    summary:
      "Export a review's checks and covered context; does not launch a reviewer.",
    options: { ...stepId, output: "Optional output Markdown path." },
  },
  migrate: {
    summary:
      "Migrate legacy JSON to Markdown, retaining history and a redirect.",
    options: { output: "Destination Markdown path (required)." },
  },
  "step add": {
    summary: "Add a pending step; it receives no execution approval.",
    options: { ...revision, ...stepId, ...fields, ...placement, ...dryRun },
    example:
      'step add --plan plan.md --base-revision 4 --step-id docs --title "Update docs" --after api',
  },
  "step update": {
    summary:
      "Patch step fields; changed scope loses prior approval and needs freshness review.",
    options: { ...revision, ...stepId, ...fields, ...dryRun },
    example:
      'step update --plan plan.md --base-revision 4 --step-id api --done-when "Both clients pass" --dry-run',
  },
  "step move": {
    summary:
      "Move a pending step while retaining prerequisites, protected history, and review timing/scope.",
    options: { ...revision, ...stepId, ...placement, ...dryRun },
    example:
      "step move --plan plan.md --base-revision 4 --step-id docs --after api",
  },
  "step remove": {
    summary: "Remove a pending step only when no remaining work depends on it.",
    options: { ...revision, ...stepId, ...dryRun },
  },
  "note add": {
    summary:
      "Add a pending note. Like revision, changed notes invalidate that step's approval.",
    options: { ...revision, ...note, ...dryRun },
    example:
      'note add --plan plan.md --base-revision 4 --step-id api --note-id constraint --text "Retain compatibility"',
  },
  "note reply": {
    summary:
      "Acknowledge an existing note and save a response, preserving its original text.",
    options: { ...revision, ...note, ...dryRun },
    example:
      "note reply --plan plan.md --base-revision 5 --step-id api --note-id constraint --text-file response.txt",
  },
};
export function help(command?: string): string {
  const spec = command ? commandHelp[command] : undefined;
  if (spec)
    return [
      `Hyperion Plan — ${command}`,
      spec.summary,
      `Usage: node dist/plan.cjs ${command} --plan PATH [options]`,
      "",
      "  --plan PATH  Canonical plan.md (legacy JSON/redirects are supported).",
      ...Object.entries(spec.options).map(
        ([name, text]) =>
          `  --${name}${["preview", "dry-run"].includes(name) ? "" : " VALUE"}  ${text}`,
      ),
      "  --help  Show this command's help.",
      ...(spec.example
        ? ["", `Example: node dist/plan.cjs ${spec.example}`]
        : []),
      "",
      "See references/agent-cli.md for field schemas, scope rules, and examples.",
    ].join("\n");
  const entries = Object.entries(commandHelp).filter(
    ([name]) => !command || name.startsWith(command + " "),
  );
  return [
    "Hyperion Plan — versioned Markdown plans",
    "Usage: node dist/plan.cjs COMMAND --plan PATH [options]",
    "",
    ...entries.map(([name, entry]) => `  ${name.padEnd(15)} ${entry.summary}`),
    "",
    "Use COMMAND --help for its options. Plan edits do not authorize implementation; apply records explicit implementation requests.",
  ].join("\n");
}
