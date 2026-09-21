import { createHash } from "node:crypto";
import { parseJSON } from "./json";
import { decodeHTML } from "entities";
import { Plan, Step, Note, record, requireValue as require } from "./model";
const TASK = /^[-*+] \[([ xX])\] (.+)$/s;
const META = /^<!-- (plan-companion|plan-step|plan-note): (.+) -->$/s;
export const FIELDS: Record<string, string> = {
  Description: "description",
  "Done when": "done_when",
  Result: "progress_note",
  "Blocked by": "blocked_by",
  Freshness: "review_note",
  "Complexity rationale": "complexity_reason",
  "Estimate note": "estimate_note",
  "Scope warning": "scope_warning",
};
export function uuid5(text: string): string {
  const ns = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"),
    h = createHash("sha1").update(ns).update(text).digest().subarray(0, 16);
  h[6] = (h[6] & 15) | 0x50;
  h[8] = (h[8] & 63) | 0x80;
  const s = h.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;");
const inline = (text: string) => escape(text).replaceAll("\n", "&#10;");
function metadata(kind: string, value: unknown) {
  const payload = JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("--", "\\u002d\\u002d");
  return `<!-- ${kind}: ${payload} -->`;
}
const quoted = (text: string) =>
  text.split("\n").map((line) => "> " + escape(line));
export function dumps(plan: Plan): string {
  const header = Object.fromEntries(
    Object.entries(plan).filter(
      ([k]) =>
        ![
          "title",
          "steps",
          "execution",
          "applied_requests",
          "preamble",
        ].includes(k),
    ),
  );
  const lines = [
    "# " + inline(plan.title),
    metadata("plan-companion", header),
    "",
  ];
  if (plan.preamble) lines.push(...plan.preamble.split("\n"), "");
  for (const step of plan.steps) {
    lines.push(
      `- [${step.status === "completed" ? "x" : " "}] ${inline(step.title)}`,
    );
    const meta = Object.fromEntries(
      Object.entries(step).filter(
        ([k]) =>
          ![
            "title",
            "status",
            "comments",
            ...Object.values(FIELDS),
            "checks",
          ].includes(k),
      ),
    );
    if (step.status === "in_progress") meta.in_progress = true;
    if ("checks" in step && !step.checks!.length) meta.checks = [];
    const body = [metadata("plan-step", meta)];
    for (const [label, field] of Object.entries(FIELDS))
      if (
        field in step &&
        (step[field] || !["description", "done_when"].includes(field))
      )
        body.push("", `**${label}**`, ...quoted(step[field] as string));
    if (step.checks?.length) {
      body.push("", "**Checks**");
      for (const check of step.checks) {
        const parts = escape(check).split("\n");
        body.push("- " + parts[0], ...parts.slice(1).map((p) => "  " + p));
      }
    }
    if (step.comments?.length) {
      body.push("", "**Notes**");
      for (const note of step.comments) {
        body.push(
          metadata(
            "plan-note",
            Object.fromEntries(
              Object.entries(note).filter(
                ([k]) => !["text", "response"].includes(k),
              ),
            ),
          ),
          ...quoted(note.text),
        );
        if ("response" in note)
          body.push("**Response**", ...quoted(note.response!));
        body.push("");
      }
    }
    lines.push(...body.map((line) => (line ? "  " + line : "")), "");
  }
  return lines.join("\n").trimEnd() + "\n";
}
export function loads(text: string, fallbackId: string): Plan {
  require(Buffer.byteLength(text) <= 500000, "Markdown plan is too large");
  let title: string | undefined,
    header: Record<string, unknown> | undefined,
    current: { task: RegExpMatchArray; body: string[] } | undefined;
  const prefix: string[] = [],
    blocks: { task: RegExpMatchArray; body: string[] }[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(TASK),
      meta = line.match(META);
    if (match) {
      current = { task: match, body: [] };
      blocks.push(current);
    } else if (current) {
      require(!line ||
        line.startsWith(
          "  ",
        ), "Step details must be indented by two spaces; source was not changed");
      current.body.push(line.startsWith("  ") ? line.slice(2) : "");
    } else if (line.startsWith("# ") && title === undefined)
      title = decodeHTML(line.slice(2));
    else if (meta && meta[1] === "plan-companion") {
      require(!header, "Duplicate plan metadata");
      const value: unknown = parseJSON(meta[2]);
      require(record(value), "Invalid plan metadata");
      header = value;
    } else prefix.push(line);
  }
  require(title !== undefined, "Markdown plan needs a '# Title' heading");
  const info = header ?? {
    schema_version: 1,
    plan_id: fallbackId,
    revision: 1,
  };
  require(!["execution", "applied_requests", "steps", "title"].some(
    (k) => k in info,
  ), "Plan metadata contains reserved fields");
  const plan = {
    ...info,
    title,
    steps: [],
    applied_requests: {},
  } as unknown as Plan;
  if (prefix.join("\n").trim())
    plan.preamble = prefix.join("\n").replace(/^\n+|\n+$/g, "");
  for (const [index, { task, body }] of blocks.entries()) {
    const step = {
      id: uuid5(`${plan.plan_id}/step/${index}/${task[2]}`),
      title: decodeHTML(task[2]),
      description: "",
      done_when: "",
      comments: [],
    } as unknown as Step;
    let section: string | undefined,
      values: string[] = [],
      checkLines: string[] = [],
      note: Note | undefined,
      noteResponse = false,
      sawMeta = false;
    const seenNoteLines = new Map<Note, Set<string>>(),
      seenSections = new Set<string>();
    function flushField() {
      if (section && Object.hasOwn(FIELDS, section))
        step[FIELDS[section]] = values.join("\n");
      else if (section === undefined && values.length)
        step.description +=
          (step.description ? "\n" : "") +
          values.join("\n").replace(/^\n+|\n+$/g, "");
      values = [];
    }
    function flushCheck() {
      if (checkLines.length) {
        (step.checks ??= []).push(decodeHTML(checkLines.join("\n")));
        checkLines = [];
      }
    }
    for (const line of body) {
      const meta = line.match(META),
        label = line.match(/^\*\*(.+)\*\*$/);
      if (meta) {
        const data: unknown = parseJSON(meta[2]);
        require(record(data), "Invalid Markdown metadata");
        if (meta[1] === "plan-step") {
          require(!sawMeta &&
            section === undefined &&
            !["title", "status", "comments", ...Object.values(FIELDS)].some(
              (k) => k in data,
            ), "Invalid or duplicate step metadata");
          sawMeta = true;
          for (const [key, value] of Object.entries(data))
            Object.defineProperty(step, key, {
              value,
              writable: true,
              enumerable: true,
              configurable: true,
            });
        } else if (meta[1] === "plan-note" && section === "Notes") {
          require(!["text", "response"].some(
            (k) => k in data,
          ), "Note text belongs in Markdown");
          note = { ...data, text: "" } as Note;
          step.comments!.push(note);
          noteResponse = false;
        } else throw new Error("Unexpected Markdown metadata");
      } else if (
        label &&
        (Object.hasOwn(FIELDS, label[1]) ||
          ["Checks", "Notes", "Response"].includes(label[1]))
      ) {
        if (label[1] === "Response") {
          require(section === "Notes" && note, "A response needs a note");
          require(!(
            "response" in note
          ), "Duplicate note response; source was not changed");
          noteResponse = true;
          note.response = "";
        } else {
          flushField();
          flushCheck();
          require(!seenSections.has(label[1]) &&
            !(
              label[1] === "Description" && step.description
            ), "Duplicate text section; source was not changed");
          seenSections.add(label[1]);
          section = label[1];
          if (section === "Checks") {
            require(!("checks" in step), "Duplicate checks section");
            step.checks = [];
          }
        }
      } else if (line.startsWith("> ") || line === ">") {
        const value = decodeHTML(line.startsWith("> ") ? line.slice(2) : "");
        if (section === "Notes") {
          if (!note) {
            note = {
              id: uuid5(step.id + "/note/0"),
              state: "pending",
              text: "",
            };
            step.comments!.push(note);
          }
          const key = noteResponse ? "response" : "text";
          const seen = seenNoteLines.get(note) ?? new Set<string>();
          note[key] = (note[key] ?? "") + (seen.has(key) ? "\n" : "") + value;
          seen.add(key);
          seenNoteLines.set(note, seen);
        } else if (section === "Checks")
          throw new Error("Checks must be Markdown bullet items");
        else values.push(value);
      } else if (section === "Checks" && line.startsWith("- ")) {
        flushCheck();
        checkLines = [line.slice(2)];
      } else if (
        section === "Checks" &&
        line.startsWith("  ") &&
        checkLines.length
      )
        checkLines.push(line.slice(2));
      else if (!line) continue;
      else if (section === "Notes")
        throw new Error("Notes use blockquotes; source was not changed");
      else if (section === "Checks")
        throw new Error("Invalid checks list; source was not changed");
      else values.push(decodeHTML(line));
    }
    flushField();
    flushCheck();
    const active = step.in_progress;
    delete step.in_progress;
    step.status =
      task[1].toLowerCase() === "x"
        ? "completed"
        : active
          ? "in_progress"
          : "pending";
    plan.steps.push(step);
  }
  return plan;
}
