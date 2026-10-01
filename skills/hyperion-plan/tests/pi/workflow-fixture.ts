// Test-only, bounded work for the real terminal harness. No worker or network calls.
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import core from '../../dist/index.cjs';

export function workflowFixture(pi, log) {
  const root = process.env.HYPERION_WORKFLOW_ROOT;
  if (!root) return undefined;
  assert.equal(fs.realpathSync(root), fs.realpathSync(process.cwd()));
  assert.equal(fs.readFileSync(path.join(root, 'fixture-marker'), 'utf8'), 'hyperion-terminal-workflow');
  const planPath = path.join(root, 'plan.md');
  const output = path.join(root, 'approved.txt');
  pi.registerCommand('fixture-theme', { description: 'Test-only theme switch', handler: async (name, ctx) => {
    assert.ok(['light', 'dark'].includes(name));
    assert.equal(ctx.ui.setTheme(name).success, true);
    log({ event: 'theme', name });
  } });
  pi.registerTool({ name: 'fixture_step', label: 'Fixture checkpoint', description: 'Test-only selected step checkpoint.',
    parameters: Type.Object({ phase: Type.Union([Type.Literal('start'), Type.Literal('complete')]), request_id: Type.String() }),
    async execute(_id, args, _signal, _update, ctx) {
      const result = await core.mutatePlan(planPath, ctx.sessionManager.getSessionId(), plan => {
        assert.equal(plan.execution.request_id, args.request_id);
        assert.equal(plan.execution.state, 'approved');
        assert.deepEqual(plan.execution.selected_step_ids, ['approved']);
        assert.equal(plan.steps.find(s => s.id === 'unselected').status, 'pending');
        const step = plan.steps.find(s => s.id === 'approved');
        assert.equal(step.status, args.phase === 'start' ? 'pending' : 'in_progress');
        if (args.phase === 'complete') assert.equal(fs.readFileSync(output, 'utf8'), 'approved');
        return core.checkpoint(plan, plan.revision, 'approved', args.phase === 'start' ? 'in_progress' : 'completed',
          args.phase === 'start' ? 'Scripted fixture started after native Run.' : 'Scripted fixture verified exact approved file contents.');
      });
      if (args.phase === 'start') fs.writeFileSync(output, 'approved', { flag: 'wx' });
      assert.equal(fs.existsSync(path.join(root, 'unselected.txt')), false);
      log({ event: 'checkpoint', phase: args.phase, revision: result.plan.revision, request_id: args.request_id });
      return { content: [{ type: 'text', text: `Fixture ${args.phase} checkpoint saved.` }], details: { phase: args.phase } };
    },
  });
  pi.registerTool({ name: 'fixture_reconcile', label: 'Fixture intent reconciliation', description: 'Test-only same-request reconciliation of a known acceptance-only blocker.',
    parameters: Type.Object({ request: Type.String() }),
    async execute(_id, args, signal, _update, ctx) {
      const request = JSON.parse(args.request);
      assert.equal(request.intent, 'implement');
      assert.deepEqual(request.selected_step_ids, ['approved']);
      assert.deepEqual(request.operations, []);
      const result = await core.mutatePlan(planPath, ctx.sessionManager.getSessionId(), plan => {
        assert.equal(plan.plan_id, request.plan_id);
        const step = plan.steps.find(s => s.id === 'approved');
        assert.equal(step.blocked_by, 'Fixture acceptance-only limitation; execution is available.');
        const reconciled = core.clone(plan);
        delete reconciled.steps.find(s => s.id === 'approved').blocked_by;
        const updated = core.revise(plan, reconciled, plan.revision);
        return core.applyRequest(updated, { ...request, base_revision: updated.revision });
      }, { beforeWrite: () => signal?.throwIfAborted() });
      log({ event: 'intent_reconciled', request_id: request.request_id, revision: result.plan.revision });
      return { content: [{ type: 'text', text: 'Fixture intent reconciled under the original Run.' }], details: {} };
    },
  });
  return messages => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content :
      (lastUser?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (!text?.startsWith('Hyperion Plan request from its native Pi screen.')) return undefined;
    const last = messages.at(-1);
    if (last?.role === 'toolResult' && last.isError) throw new Error(JSON.stringify(last.content));
    const intent = text.includes('current user intent') ? JSON.parse(text.slice(text.lastIndexOf('\n\n') + 2)) : undefined;
    const [plan] = core.loadMarkdown(planPath);
    if (intent?.action.type === 'note' || intent?.action.type === 'add') {
      const note = intent.action.type === 'note';
      const exists = note ? plan.steps[0].comments.some(c => c.id === intent.request_id) : plan.steps.some(s => s.id === 'added');
      if (exists) return note ? 'Fixture note saved; no implementation authorized.' : 'Fixture addition saved; no implementation authorized.';
      assert.equal(typeof intent.user_text, 'string');
      return { type: 'toolCall', id: 'fixture-plan-edit', name: 'hyperion_plan', arguments: {
        action: 'edit', path: planPath, plan_id: plan.plan_id, base_revision: plan.revision, request_id: intent.request_id,
        operations: JSON.stringify([note ? { type: 'add_comment', step_id: 'approved', comment_id: intent.request_id, text: intent.user_text }
          : { type: 'add_step', step_id: 'added', title: intent.user_text, reasoning_effort: 'medium' }]),
      } };
    }
    if (!text.includes('The user explicitly authorized Run') && intent?.action.type !== 'run') {
      log({ event: 'question', text });
      return 'Fixture question received; no implementation authorized.';
    }
    assert.match(text, /step IDs only: approved\./);
    const requestId = intent?.request_id ?? /accepted plan request ID is ([^;]+);/.exec(text)?.[1];
    assert.ok(requestId);
    if (intent && plan.execution?.request_id !== requestId)
      return { type: 'toolCall', id: 'fixture-reconcile', name: 'fixture_reconcile', arguments: { request: JSON.stringify(intent.request) } };
    assert.equal(plan.execution.request_id, requestId);
    assert.deepEqual(plan.execution.selected_step_ids, ['approved']);
    const step = plan.steps.find(s => s.id === 'approved');
    if (step.status === 'completed') return 'Fixture Run verified; unselected work untouched.';
    return { type: 'toolCall', id: `fixture-${step.status}`, name: 'fixture_step',
      arguments: { phase: step.status === 'pending' ? 'start' : 'complete', request_id: requestId } };
  };
}
