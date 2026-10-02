// Offline SDK fixture only; production never imports this file.
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Subagents, inspectAssignment, type Assignment, type AgentRecord } from "../../src/pi/subagents";
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import core from '../../dist/index.cjs';
export { Subagents, inspectAssignment, getCurrentTools, getCurrentSystemPrompt };
export async function fixture(cwd: string, respond: (context: any, signal?: AbortSignal) => any, reasoning = false) {
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(cwd, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const requests: any[] = [], settings: any[] = [], history: AgentRecord[] = [];
  runtime.registerProvider("offline-agent", { baseUrl: "http://invalid.test", api: "openai-completions", apiKey: "offline",
    models: [{ id: "scripted", name: "Offline assignment", reasoning, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        try {
          requests.push(structuredClone(context)); settings.push(options?.reasoning);
          const answer = await respond(context, options?.signal); options?.signal?.throwIfAborted();
          stream.push({ type: "start", partial: message });
          if (answer.tool) {
            const toolCall = { type: "toolCall", id: `call-${requests.length}`, ...answer.tool };
            message.content = [toolCall]; message.stopReason = "toolUse";
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          } else {
            message.content = [{ type: "text", text: answer.text }];
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({ type: "text_delta", contentIndex: 0, delta: answer.text, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: answer.text, partial: message });
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error"; message.errorMessage = String(error);
          stream.push({ type: "error", reason: message.stopReason, error: message });
        }
        stream.end();
      });
      return stream;
    },
  });
  const options: Assignment = {
    id: "assignment", cwd, instructions: "Implement only output.txt; return evidence, not canonical completion.", context: "EXPLICIT_REQUIREMENT",
    readPaths: [], writePaths: [path.join(cwd, "output.txt")], protectedPaths: [path.join(cwd, "plan.md")],
    sessionDir: path.join(cwd, "sessions"), effort: "high", model: runtime.getModel("offline-agent", "scripted")!,
    modelRuntime: runtime, thinkingLevel: "off", history: () => history, record: event => history.push(structuredClone(event)),
    withPermission: async work => work(), timeoutMs: 5000, settleTimeoutMs: 100,
  };
  fs.writeFileSync(path.join(cwd, "plan.md"), "Canonical plan must remain unchanged");
  return { options, history, requests, settings, handler: new Subagents() };
}

export default function (pi) {
  const log = (event) => {
    if (process.env.HYPERION_TEST_TRACE) fs.appendFileSync(process.env.HYPERION_TEST_TRACE, JSON.stringify(event) + "\n");
  };
  const workflow = workflowFixture(pi, log);
  pi.on("session_start", (_event, ctx) => log({ event: "session_start", mode: ctx.mode, tools: pi.getActiveTools() }));
  pi.on("tool_result", event => log({ event: "tool_result", name: event.toolName, details: event.details, isError: event.isError }));
  pi.on("agent_settled", (_event, ctx) => log({ event: "settled", idle: ctx.isIdle() }));
  pi.registerProvider("hyperion-test", {
    baseUrl: "http://invalid.test", apiKey: "test-only", api: "openai-completions",
    models: [{ id: "scripted", name: "Scripted integration fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
        try {
          const tools = getCurrentTools(context.messages);
          log({ event: "request", tools: tools.map(tool => tool.name), system: getCurrentSystemPrompt(context.messages) });
          if (!tools.some(tool => tool.name === "hyperion_plan")) throw new Error("Model request is missing hyperion_plan");
          if (!getCurrentSystemPrompt(context.messages).includes("Hyperion is this session's planning interface")) throw new Error("Model request is missing Hyperion awareness context");
          options?.signal?.throwIfAborted();
          stream.push({ type: "start", partial: message });
          const last = context.messages.at(-1);
          const response = workflow?.(context.messages);
          if (typeof response === 'string' || (!response && last?.role === "toolResult")) {
            if (last?.isError) throw new Error(`Tool failed: ${JSON.stringify(last.content)}`);
            const text = typeof response === 'string' ? response : "Plan request accepted. Ending the turn for the native screen.";
            message.content = [{ type: "text", text: "" }];
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            message.content[0].text = text;
            stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
            stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          } else {
            // Deterministic routing is deliberate: this tests integration, not LLM understanding.
            const toolCall = response ?? { type: "toolCall", id: `open-${Date.now()}`, name: "hyperion_plan",
              arguments: { action: "open" } };
            message.content = [toolCall];
            stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
            stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial: message });
            stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
            message.stopReason = "toolUse";
          }
          stream.push({ type: "done", reason: message.stopReason, message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? "aborted" : "error";
          message.errorMessage = error instanceof Error ? error.message : String(error);
          log({ event: "failure", error: message.errorMessage });
          stream.push({ type: "error", reason: message.stopReason, error: message });
        }
        stream.end();
      });
      return stream;
    },
  });
}

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
    const chat = /^(Note for approved|Add step|Ask about approved): ([\s\S]+)$/.exec(text ?? '');
    const lifecycle = text === 'Finish plan' ? 'finish' : text === 'Reopen plan' ? 'reopen' : undefined;
    if (!chat && !lifecycle && !text?.startsWith('Hyperion Plan request from its native Pi screen.')) return undefined;
    const last = messages.at(-1);
    if (last?.role === 'toolResult' && last.isError) throw new Error(JSON.stringify(last.content));
    const [plan] = core.loadMarkdown(planPath);
    if (lifecycle) {
      if (plan.lifecycle === (lifecycle === 'finish' ? 'finished' : 'active')) return 'Fixture lifecycle saved; no implementation authorized.';
      return { type: 'toolCall', id: `fixture-${lifecycle}`, name: 'hyperion_plan', arguments: {
        action: lifecycle, path: planPath, plan_id: plan.plan_id, base_revision: plan.revision,
      } };
    }
    if (chat) {
      if (chat[1] === 'Ask about approved') { log({ event: 'question', text }); return 'Fixture question received; no implementation authorized.'; }
      const note = chat[1] === 'Note for approved', requestId = note ? 'chat-note' : 'chat-add';
      const exists = note ? plan.steps[0].comments.some(c => c.id === requestId) : plan.steps.some(s => s.id === 'added');
      if (exists) return note ? 'Fixture note saved; no implementation authorized.' : 'Fixture addition saved; no implementation authorized.';
      return { type: 'toolCall', id: 'fixture-plan-edit', name: 'hyperion_plan', arguments: {
        action: 'edit', path: planPath, plan_id: plan.plan_id, base_revision: plan.revision, request_id: requestId,
        operations: JSON.stringify([note ? { type: 'add_comment', step_id: 'approved', comment_id: requestId, text: chat[2] }
          : { type: 'add_step', step_id: 'added', title: chat[2], reasoning_effort: 'medium' }]),
      } };
    }
    const intent = text.includes('current user intent') ? JSON.parse(text.slice(text.lastIndexOf('\n\n') + 2)) : undefined;
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
