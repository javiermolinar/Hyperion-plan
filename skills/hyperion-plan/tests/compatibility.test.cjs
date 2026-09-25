const { test } = require("node:test");
const assert = require("node:assert/strict");
const api = require("../dist/index.cjs");
const fixture = require("./fixtures/python-baseline.json");
for (const [index, c] of fixture.cases.entries())
  test(`Python compatibility ${index + 1}: ${c.test.split(".").at(-1)} / ${c.fn}`, () => {
    // Freshness is advisory now; retain the frozen fixture and assert the new contract.
    if (c.error?.startsWith("Step needs review:") && c.fn === "checkpoint") {
      const [result, changed] = api[c.fn](...c.args);
      assert.equal(changed, true);
      assert.equal(result.steps.find(s => s.id === c.args[2]).status, c.args[3]);
      return;
    }
    if (c.fn === "revise" && c.test.endsWith(".test_agent_revision_preserves_receipts") && !c.error) {
      const actual = api[c.fn](...c.args), expected = api.clone(c.result);
      for (const step of expected.steps) {
        const old = c.args[0].steps.find(s => s.id === step.id);
        if (old?.status === "in_progress" && api.stepFingerprint(old).scope !== api.stepFingerprint(step).scope)
          step.needs_replanning = true;
      }
      assert.deepEqual(actual, expected);
      return;
    }
    if (c.fn === "applyRequest" && c.test.endsWith(".test_agent_revision_preserves_receipts") && !c.error) {
      const expected = api.clone(c.result);
      expected[0].steps.find(s => s.id === "inspect").needs_replanning = true;
      assert.deepEqual(api[c.fn](...c.args), expected);
      return;
    }
    if (c.error) {
      assert.throws(() => api[c.fn](...c.args));
      return;
    }
    if (c.fn === "revise" && c.test.endsWith(".test_decomposition_rewires_dependencies_without_inheriting_authorization")) {
      // The legacy draft put the UI before its newly added prerequisites.
      // Reject that order now, then verify every original result field with
      // only the prerequisite order corrected. Keep the captured fixture intact.
      assert.throws(() => api.revise(...c.args), /Keep “Build the UI” after “Build client”/);
      const args = api.clone(c.args), expected = api.clone(c.result);
      const order = ["base", "api-contract", "api-client", "ui", "docs"];
      for (const plan of [args[1], expected])
        plan.steps = order.map(id => plan.steps.find(step => step.id === id));
      assert.deepEqual(api.revise(...args), expected);
      return;
    }
    const actual = api[c.fn](...c.args);
    if (c.fn === "prNotes") {
      // Only the public product heading changed; preserve every captured
      // requirement and evidence field in the immutable baseline.
      assert.equal(actual, c.result.replace(/^# Plan Companion — PR notes/, "# Hyperion Plan — PR notes"));
      return;
    }
    if (c.fn === "summary") {
      // Lifecycle adds explicit defaults for legacy plans; all original fields
      // must still match the immutable Python fixture exactly.
      const { lifecycle, render_policy, ...legacy } = actual;
      assert.equal(lifecycle, "active");
      assert.equal(render_policy, "on_change");
      assert.deepEqual(legacy, c.result);
      return;
    }
    assert.deepEqual(actual, c.result);
  });
