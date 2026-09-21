const { test } = require("node:test");
const assert = require("node:assert/strict");
const api = require("../dist/index.cjs");
const fixture = require("./fixtures/python-baseline.json");
for (const [index, c] of fixture.cases.entries())
  test(`Python compatibility ${index + 1}: ${c.test.split(".").at(-1)} / ${c.fn}`, () => {
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
