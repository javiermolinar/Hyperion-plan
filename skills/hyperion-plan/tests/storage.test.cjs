const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync, spawn } = require("node:child_process");
const a = require("../dist/index.cjs");
const cli = path.resolve(__dirname, "../dist/plan.cjs");
function scratch(t) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "plan-companion-node-"));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
}
function legacy(t) {
  const dir = scratch(t);
  for (const f of [
    "plan.md",
    "plan.state.json",
    "request.json",
    "expected.json",
  ])
    fs.copyFileSync(
      path.join(__dirname, "fixtures/legacy", f),
      path.join(dir, f),
    );
  return path.join(dir, "plan.md");
}
function run(...args) {
  const r = spawnSync(process.execPath, [cli, ...args.map(String)], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function fail(...args) {
  const r = spawnSync(process.execPath, [cli, ...args.map(String)], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0, r.stdout);
  return r.stderr;
}
function bytes(p) {
  return [p, a.markdownStatePath(p), a.notesPath(p)].map((f) =>
    fs.existsSync(f) ? fs.readFileSync(f) : null,
  );
}
function writeRequest(p, request) {
  const f = path.join(path.dirname(p), "incoming.json");
  a.atomicWrite(f, request);
  return f;
}
function request(p, extra = {}) {
  const plan = a.read(p);
  return {
    plan_id: plan.plan_id,
    base_revision: plan.revision,
    request_id: "new-" + plan.revision,
    intent: "edit",
    operations: [],
    ...extra,
  };
}
function checkpoint(p, id, status, note) {
  return run(
    "checkpoint",
    "--plan",
    p,
    "--base-revision",
    a.read(p).revision,
    "--step-id",
    id,
    "--status",
    status,
    ...(note ? ["--note", note] : []),
  );
}

test("old Python Markdown/sidecar loads byte-for-byte with original approvals and receipts", (t) => {
  const p = legacy(t),
    before = bytes(p),
    expected = JSON.parse(
      fs.readFileSync(path.join(path.dirname(p), "expected.json")),
    );
  const status = JSON.parse(run("status", "--plan", p));
  assert.equal(status.revision, expected.revision);
  assert.deepEqual(status.execution.selected_step_ids, [
    "work",
    "other",
    "review",
  ]);
  assert.deepEqual(a.read(p), expected);
  assert.deepEqual(bytes(p), before);
  const retry = JSON.parse(
    run(
      "apply",
      "--plan",
      p,
      "--request",
      path.join(path.dirname(p), "request.json"),
    ),
  );
  assert.equal(retry.result, "already_applied");
  assert.deepEqual(a.read(p), expected);
});
for (const state of ["paused", "cancelled"])
  test(`stored ${state} authority remains stopped after TypeScript refresh`, (t) => {
    const p = legacy(t),
      current = a.read(p);
    const [stopped] = a.checkpoint(
      current,
      current.revision,
      null,
      null,
      null,
      null,
      state,
    );
    a.saveMarkdown(p, stopped);
    run("status", "--plan", p);
    const before = bytes(p);
    assert.match(
      fail(
        "checkpoint",
        "--plan",
        p,
        "--base-revision",
        stopped.revision,
        "--step-id",
        "work",
        "--status",
        "in_progress",
      ),
      /paused or cancelled/,
    );
    assert.deepEqual(bytes(p), before);
    assert.equal(a.read(p).execution.state, state);
  });
test("plain Markdown import assigns stable IDs and grants no approval", (t) => {
  const p = path.join(scratch(t), "plan.md");
  fs.writeFileSync(
    p,
    "# Task\n\nA shared goal.\n\n- [ ] First\n  Some intent.\n- [x] Second\n",
  );
  run("status", "--plan", p);
  const plan = a.read(p);
  assert.equal(plan.preamble, "A shared goal.");
  assert.equal(plan.steps[0].description, "Some intent.");
  assert.equal(plan.steps[1].completion_source, "user");
  assert.equal(plan.execution, undefined);
  const before = fs.readFileSync(p);
  run("status", "--plan", p);
  assert.deepEqual(fs.readFileSync(p), before);
});
test("migration archives JSON, redirects old cards, rejects stale requests and is repeatable", (t) => {
  const dir = scratch(t),
    source = path.join(dir, "plan.json"),
    dest = path.join(dir, "plan.md");
  const original = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures/legacy/expected.json")),
  );
  a.atomicWrite(source, original);
  run("migrate", "--plan", source, "--output", dest);
  assert.deepEqual(a.read(dest), {
    ...original,
    revision: original.revision + 1,
  });
  assert.deepEqual(a.read(source), a.read(dest));
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(dir, `.plan-history/plan-r${original.revision}.json`),
      ),
    ),
    original,
  );
  run("migrate", "--plan", source, "--output", dest);
  const before = bytes(dest);
  const req = writeRequest(dest, {
    ...request(dest),
    base_revision: original.revision,
    operations: [
      {
        type: "add_comment",
        step_id: "work",
        comment_id: "stale",
        text: "Old card",
      },
    ],
  });
  assert.match(fail("apply", "--plan", source, "--request", req), /Stale plan/);
  assert.deepEqual(bytes(dest), before);
});
test("UI edits persist prose only in Markdown and exports, with idempotent retry", (t) => {
  const p = legacy(t),
    req = writeRequest(
      p,
      request(p, {
        operations: [
          {
            type: "add_comment",
            step_id: "review",
            comment_id: "focus",
            text: "Check keyboard focus too",
          },
        ],
      }),
    );
  run("apply", "--plan", p, "--request", req);
  for (const f of [p, a.notesPath(p)])
    assert.match(fs.readFileSync(f, "utf8"), /Check keyboard focus too/);
  const state = fs.readFileSync(a.markdownStatePath(p), "utf8");
  for (const prose of [
    "Check keyboard focus too",
    "Completed work",
    "Retain keyboard access",
  ])
    assert.ok(!state.includes(prose));
  const before = bytes(p);
  assert.equal(
    JSON.parse(run("apply", "--plan", p, "--request", req)).result,
    "already_applied",
  );
  assert.deepEqual(bytes(p), before);
});
test("direct scope edit rejects a stale card and revokes only changed approval", (t) => {
  const p = legacy(t),
    req = writeRequest(
      p,
      request(p, {
        operations: [
          {
            type: "add_comment",
            step_id: "work",
            comment_id: "stale",
            text: "Old request",
          },
        ],
      }),
    );
  fs.writeFileSync(
    p,
    fs.readFileSync(p, "utf8").replace("Pending work", "Changed requirements"),
  );
  assert.match(fail("apply", "--plan", p, "--request", req), /Stale plan/);
  const result = a.read(p);
  assert.deepEqual(result.execution.selected_step_ids, ["other", "review"]);
  assert.equal(result.steps[2].review_state, "needs_review");
  assert.equal(result.steps[0].progress_note, "Observed test evidence");
  assert.ok(!fs.readFileSync(p, "utf8").includes("Old request"));
});
test("direct plan title edit preserves unchanged step approvals", (t) => {
  const p = legacy(t),
    old = a.read(p);
  fs.writeFileSync(
    p,
    fs
      .readFileSync(p, "utf8")
      .replace("# Portable migration → á 😀", "# Updated title"),
  );
  run("status", "--plan", p);
  const result = a.read(p);
  assert.equal(result.revision, old.revision + 1);
  assert.deepEqual(result.execution, old.execution);
  assert.equal(result.steps[2].review_state, undefined);
});
test("direct checkbox records user completion separately from execution selection", (t) => {
  const p = legacy(t);
  fs.writeFileSync(
    p,
    fs
      .readFileSync(p, "utf8")
      .replace("- [ ] Pending work", "- [x] Pending work"),
  );
  run("status", "--plan", p);
  const result = a.read(p);
  assert.equal(result.steps[2].completion_source, "user");
  assert.ok(!result.execution.selected_step_ids.includes("work"));
});
test("invalid direct Markdown preserves editor bytes, accepted sidecar and exports", (t) => {
  const p = legacy(t);
  run("export", "--plan", p);
  const state = fs.readFileSync(a.markdownStatePath(p)),
    notes = fs.readFileSync(a.notesPath(p));
  const bad =
    fs.readFileSync(p, "utf8") + "Unindented text must not disappear.\n";
  fs.writeFileSync(p, bad);
  fail("status", "--plan", p);
  assert.equal(fs.readFileSync(p, "utf8"), bad);
  assert.deepEqual(fs.readFileSync(a.markdownStatePath(p)), state);
  assert.deepEqual(fs.readFileSync(a.notesPath(p)), notes);
});
for (const target of ["done", "active"])
  for (const suffix of [".md", ".json"])
    test(`revision cannot omit original ${target} in ${suffix}`, (t) => {
      let p = legacy(t);
      if (suffix === ".json") {
        const current = a.read(p);
        p = path.join(path.dirname(p), "legacy.json");
        a.atomicWrite(p, current);
      }
      run("export", "--plan", p);
      const old = a.read(p),
        candidate = a.clone(old);
      candidate.steps = candidate.steps.filter(
        (s) => ![target, "review"].includes(s.id),
      );
      const draft = path.join(path.dirname(p), "draft.json");
      a.atomicWrite(draft, candidate);
      const before = bytes(p);
      assert.match(
        fail(
          "revise",
          "--plan",
          p,
          "--input",
          draft,
          "--base-revision",
          old.revision,
        ),
        /plan history/,
      );
      assert.deepEqual(bytes(p), before);
    });
for (const target of ["done", "active"])
  test(`batched reset/remove/re-add cannot erase ${target}`, (t) => {
    const p = legacy(t);
    run("export", "--plan", p);
    const before = bytes(p),
      req = writeRequest(
        p,
        request(p, {
          operations: [
            { type: "set_status", step_id: target, status: "pending" },
            { type: "remove_step", step_id: target },
            { type: "add_step", step_id: target, title: "Replacement" },
          ],
        }),
      );
    assert.match(fail("apply", "--plan", p, "--request", req), /plan history/);
    assert.deepEqual(bytes(p), before);
  });
for (const target of ["done", "active"])
  test(`direct omission of ${target} preserves recovery and all accepted bookkeeping`, (t) => {
    const p = legacy(t);
    run("status", "--plan", p);
    run("export", "--plan", p);
    const good = fs.readFileSync(p),
      before = bytes(p),
      history = path.join(a.recoveryDirectory(p), "current.md");
    const current = a.read(p);
    current.steps = current.steps.filter(
      (s) => ![target, "review"].includes(s.id),
    );
    const edited = a.dumps(current);
    fs.writeFileSync(p, edited);
    assert.match(fail("status", "--plan", p), /Restore the missing rows/);
    assert.equal(fs.readFileSync(p, "utf8"), edited);
    assert.deepEqual(bytes(p).slice(1), before.slice(1));
    assert.deepEqual(fs.readFileSync(history), good);
    fs.copyFileSync(history, p);
    run("status", "--plan", p);
    assert.deepEqual(bytes(p), before);
  });
test("legacy sidecar protects omissions before any recovery copy exists", (t) => {
  const p = legacy(t),
    good = fs.readFileSync(p),
    state = fs.readFileSync(a.markdownStatePath(p)),
    plan = a.read(p);
  plan.steps = plan.steps.filter((s) => s.id !== "active");
  fs.writeFileSync(p, a.dumps(plan));
  assert.match(fail("status", "--plan", p), /plan history/);
  assert.equal(fs.existsSync(a.recoveryDirectory(p)), false);
  assert.deepEqual(fs.readFileSync(a.markdownStatePath(p)), state);
  fs.writeFileSync(p, good);
  run("status", "--plan", p);
  assert.deepEqual(
    fs.readFileSync(path.join(a.recoveryDirectory(p), "current.md")),
    good,
  );
});
test("recovery stays bounded through successful saves and pending removal", (t) => {
  const p = legacy(t);
  let current = a.read(p);
  for (let i = 0; i < 5; i++) {
    const candidate = a.clone(current);
    candidate.title = "Revision " + i;
    current = a.revise(current, candidate, current.revision);
    a.saveMarkdown(p, current);
  }
  const candidate = a.clone(current);
  candidate.steps = candidate.steps.filter((s) => s.id !== "other");
  current = a.revise(current, candidate, current.revision);
  a.saveMarkdown(p, current);
  assert.deepEqual(fs.readdirSync(a.recoveryDirectory(p)).sort(), [
    "current.md",
    "previous.md",
  ]);
  assert.deepEqual(
    fs.readFileSync(path.join(a.recoveryDirectory(p), "current.md")),
    fs.readFileSync(p),
  );
  assert.equal(a.read(p).steps.length, 4);
});
test("repeated interrupted sidecar writes retain the copy matching accepted source", (t) => {
  const p = legacy(t),
    current = a.read(p);
  a.saveMarkdown(p, current);
  const accepted = fs.readFileSync(p),
    state = fs.readFileSync(a.markdownStatePath(p));
  for (let i = 0; i < 3; i++) {
    const candidate = a.clone(current);
    candidate.title = "Uncommitted " + i;
    candidate.revision += i + 1;
    assert.throws(
      () =>
        a.saveMarkdown(p, candidate, a.digestText(a.readText(p)), () => {
          throw Error("Interrupted sidecar write");
        }),
      /Interrupted/,
    );
    assert.deepEqual(fs.readFileSync(a.markdownStatePath(p)), state);
    const copies = fs
      .readdirSync(a.recoveryDirectory(p))
      .map((f) => fs.readFileSync(path.join(a.recoveryDirectory(p), f)));
    assert.equal(copies.length, 2);
    assert.ok(copies.some((copy) => copy.equals(accepted)));
  }
  fs.writeFileSync(p, accepted);
  run("status", "--plan", p);
  assert.deepEqual(a.read(p), current);
});
test("copying Markdown without sidecar imports no execution authority or receipts", (t) => {
  const p = legacy(t),
    copy = path.join(path.dirname(p), "copy.md");
  fs.copyFileSync(p, copy);
  run("status", "--plan", copy);
  const result = a.read(copy);
  assert.equal(result.execution, undefined);
  assert.deepEqual(result.applied_requests, {});
});
test("concurrent editor source digest prevents overwrite", (t) => {
  const p = legacy(t),
    current = a.read(p),
    digest = a.digestText(a.readText(p));
  fs.writeFileSync(
    p,
    fs.readFileSync(p, "utf8").replace("Pending work", "Keep this edit"),
  );
  assert.throws(() => a.saveMarkdown(p, current, digest), /changed during/);
  assert.match(fs.readFileSync(p, "utf8"), /Keep this edit/);
});
for (const [target, change] of [
  ["review", { depends_on: ["done", "work"] }],
  ["review", { checks: ["Different checks"] }],
  ["review", { run_after: "active" }],
  ["work", { description: "Changed scope" }],
  ["work", { done_when: "Different acceptance" }],
  [
    "work",
    { comments: [{ id: "new", text: "New scope note", state: "pending" }] },
  ],
])
  test(`CLI revise/review/start needs new approval for ${JSON.stringify(change)}`, (t) => {
    const p = legacy(t);
    let current = a.read(p);
    const candidate = a.clone(current);
    Object.assign(
      candidate.steps.find((s) => s.id === target),
      change,
    );
    const draft = path.join(path.dirname(p), "draft.md");
    fs.writeFileSync(draft, a.dumps(candidate));
    run(
      "revise",
      "--plan",
      p,
      "--input",
      draft,
      "--base-revision",
      current.revision,
    );
    current = a.read(p);
    assert.deepEqual(
      current.execution.selected_step_ids,
      ["work", "other", "review"].filter((id) => id !== target),
    );
    run(
      "review",
      "--plan",
      p,
      "--base-revision",
      current.revision,
      "--step-id",
      target,
      "--state",
      "current",
      "--note",
      "Inspected new scope",
    );
    run("export", "--plan", p);
    const before = bytes(p);
    assert.match(
      fail(
        "checkpoint",
        "--plan",
        p,
        "--base-revision",
        a.read(p).revision,
        "--step-id",
        target,
        "--status",
        "in_progress",
      ),
      /outside/,
    );
    assert.deepEqual(bytes(p), before);
    checkpoint(p, "other", "in_progress");
    // Renew only cases whose prerequisites have completed.
    if (!change.depends_on && !change.run_after) {
      const req = writeRequest(
        p,
        request(p, {
          intent: "implement",
          selected_step_ids: [target],
          operations: [],
        }),
      );
      run("apply", "--plan", p, "--request", req);
      checkpoint(p, target, "in_progress");
      checkpoint(p, target, "completed", "Verified renewed scope");
      assert.match(
        fs.readFileSync(a.notesPath(p), "utf8"),
        /Verified renewed scope/,
      );
      assert.ok(a.read(p).applied_requests["python-approval"]);
    }
  });
test("ordinary progress revision preserves approvals and paused state", (t) => {
  const p = legacy(t),
    current = a.read(p),
    candidate = a.clone(current);
  candidate.steps[2].progress_note = "Observed progress";
  candidate.title = "Progress update";
  const updated = a.revise(current, candidate, current.revision);
  assert.deepEqual(updated.execution, current.execution);
  a.saveMarkdown(p, updated);
  checkpoint(p, "work", "in_progress");
  checkpoint(p, "work", "completed", "Passed relevant checks");
  assert.equal(a.read(p).steps[2].completion_source, "agent");
});
test("export failure returns warning after canonical state is saved", (t) => {
  const p = legacy(t);
  fs.mkdirSync(a.notesPath(p));
  const result = JSON.parse(checkpoint(p, "work", "in_progress"));
  assert.match(result.export_warning, /Plan is saved/);
  assert.equal(a.read(p).steps[2].status, "in_progress");
  fs.rmdirSync(a.notesPath(p));
  run("export", "--plan", p);
  assert.match(fs.readFileSync(a.notesPath(p), "utf8"), /in_progress/);
});
test("render and exports cannot overwrite canonical files", (t) => {
  const p = legacy(t);
  for (const dest of [p, a.markdownStatePath(p)])
    for (const command of ["render", "export", "review-brief"]) {
      const before = bytes(p);
      assert.match(
        fail(
          command,
          "--plan",
          p,
          "--output",
          dest,
          ...(command === "review-brief" ? ["--step-id", "review"] : []),
        ),
        /must not overwrite/,
      );
      assert.deepEqual(bytes(p), before);
    }
});
test("two concurrent CLI writers serialize revisions and preserve only accepted receipt", async (t) => {
  const p = legacy(t);
  const first = writeRequest(
    p,
    request(p, {
      request_id: "first",
      operations: [
        {
          type: "add_comment",
          step_id: "work",
          comment_id: "first",
          text: "First writer",
        },
      ],
    }),
  );
  const second = path.join(path.dirname(p), "second.json");
  a.atomicWrite(
    second,
    request(p, {
      request_id: "second",
      operations: [
        {
          type: "add_comment",
          step_id: "work",
          comment_id: "second",
          text: "Second writer",
        },
      ],
    }),
  );
  function start(file) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [
        cli,
        "apply",
        "--plan",
        p,
        "--request",
        file,
      ]);
      let out = "",
        err = "";
      child.stdout.on("data", (v) => (out += v));
      child.stderr.on("data", (v) => (err += v));
      child.on("exit", (code) => resolve({ code, out, err }));
    });
  }
  const results = await Promise.all([start(first), start(second)]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
  assert.match(results.find((r) => r.code === 1).err, /Stale plan/);
  const plan = a.read(p);
  assert.equal(plan.revision, 3);
  assert.equal(plan.steps[2].comments.length, 1);
  assert.equal(Object.keys(plan.applied_requests).length, 2);
  assert.equal(fs.existsSync(p + ".lockdir"), false);
});
test("legacy redirect cycle fails without changing files", (t) => {
  const dir = scratch(t),
    p = path.join(dir, "a.json"),
    q = path.join(dir, "b.json");
  a.atomicWrite(p, { format: "plan-companion-redirect", migrated_to: q });
  a.atomicWrite(q, { format: "plan-companion-redirect", migrated_to: p });
  assert.match(fail("status", "--plan", p), /cycle/);
});
for (const field of [
  "description",
  "done_when",
  "checks",
  "depends_on",
  "comments",
  "review_state",
  "complexity",
  "short_title",
])
  test(`runtime validation rejects explicit null ${field}`, () => {
    const current = a.initialize({
      title: "Invalid input",
      steps: [{ id: "work", title: "Work" }],
    });
    current.steps[0][field] = null;
    assert.throws(() => a.validate(current));
  });
test("request validation rejects null intent and null target/selection arrays", () => {
  const current = a.initialize({
    title: "Invalid request",
    steps: [{ id: "work", title: "Work" }],
  });
  for (const field of ["intent", "selected_step_ids", "target_step_ids"])
    assert.throws(() =>
      a.applyRequest(current, {
        plan_id: current.plan_id,
        base_revision: 1,
        request_id: "bad",
        intent: "implement",
        selected_step_ids: ["work"],
        operations: [],
        [field]: null,
      }),
    );
});
test("request IDs matching object prototype names are real idempotent receipts", () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    const current = a.initialize({
      title: "Receipt keys",
      steps: [{ id: "work", title: "Work" }],
    });
    const req = {
      plan_id: current.plan_id,
      base_revision: 1,
      request_id: id,
      intent: "implement",
      selected_step_ids: ["work"],
      operations: [],
    };
    const [accepted] = a.applyRequest(current, req);
    assert.equal(Object.hasOwn(accepted.applied_requests, id), true);
    const [retry, changed] = a.applyRequest(accepted, req);
    assert.equal(changed, false);
    assert.deepEqual(retry, accepted);
  }
});
test("prototype-like stable IDs remain usable through revise, save, and batch removal", (t) => {
  const p = legacy(t),
    current = a.read(p);
  const candidate = a.clone(current);
  candidate.steps.push({
    id: "constructor",
    title: "New step",
    status: "pending",
  });
  const revised = a.revise(current, candidate, current.revision);
  assert.equal(revised.steps.at(-1).review_state, undefined);
  a.saveMarkdown(p, revised);
  assert.equal(a.read(p).steps.at(-1).id, "constructor");
  const result = a.applyOperations(revised, [
    { type: "add_step", step_id: "__proto__", title: "Planned work" },
    { type: "remove_step", step_id: "__proto__" },
  ]);
  assert.deepEqual(result, revised);
});
