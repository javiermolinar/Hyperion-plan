// Offline SDK fixture only; production never imports this file.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Subagents, inspectAssignment, inspectAssignments, SETTLEMENT_ENTRY, type Assignment, type AgentRecord } from "../../src/pi/subagents";
import { assertAgentIdle, registerAgentTool } from "../../src/pi/executor";
export { assertAgentIdle };
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import core from '../../dist/index.cjs';
export { Subagents, inspectAssignment, inspectAssignments, SETTLEMENT_ENTRY, SessionManager, getCurrentTools, getCurrentSystemPrompt };
export async function fixture(cwd: string, respond: (context: any, signal?: AbortSignal) => any, reasoning = false) {
  const runtime = await ModelRuntime.create({ authPath: path.join(cwd, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(cwd, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const requests: any[] = [], settings: any[] = [], history: AgentRecord[] = [];
  const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
  runtime.registerProvider("offline-agent", { baseUrl: "http://invalid.test", api: "openai-completions", apiKey: "offline",
    models: [{ id: "scripted", name: "Offline assignment", reasoning, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream(); streams.push(stream);
      queueMicrotask(async () => {
        const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        try {
          requests.push(structuredClone(context)); settings.push(options?.reasoning);
          const requestId = requests.length;
          const answer = await respond(context, options?.signal); options?.signal?.throwIfAborted();
          stream.push({ type: "start", partial: message });
          if (answer.tool) {
            const toolCall = { type: "toolCall", id: `call-${requestId}`, ...answer.tool };
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
    id: "assignment", cwd,
    correlation: { coordinator_id: "coordinator", plan_path: path.join(cwd, "plan.md"), plan_id: "fixture-plan",
      request_id: "fixture-run", step_id: "work", scope_digest: "a".repeat(64) },
    instructions: "Implement only output.txt; return evidence, not canonical completion.", context: "EXPLICIT_REQUIREMENT",
    readPaths: [], writePaths: [path.join(cwd, "output.txt")], protectedPaths: [path.join(cwd, "plan.md")],
    sessionDir: path.join(cwd, "sessions", "hyperion-agents", createHash("sha256").update("coordinator").digest("hex")),
    effort: "high", model: runtime.getModel("offline-agent", "scripted")!,
    modelRuntime: runtime, thinkingLevel: "off", history: () => history, record: event => history.push(structuredClone(event)),
    withPermission: async work => work(), timeoutMs: 5000, settleTimeoutMs: 100,
  };
  fs.writeFileSync(path.join(cwd, "plan.md"), "Canonical plan must remain unchanged");
  const inspectionScope = { coordinator_id: options.correlation.coordinator_id, coordinator_session_dir: path.join(cwd, "sessions"),
    workspace: cwd, plan_path: options.correlation.plan_path, plan_id: options.correlation.plan_id, request_id: options.correlation.request_id };
  return { options, history, requests, streams, settings, inspectionScope, handler: new Subagents() };
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


/** Pi 1.0.3-only integration, supplied by an isolated subprocess; baseline dependencies stay pinned. */
export async function codemodeFixture(sdk: any, cwd: string, scenario: string) {
  const makeGate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { open, promise }; };
  const both = makeGate(), aborted = makeGate(), finish = makeGate(), drained = makeGate();
  const observed = new Map<string, AgentRecord>();
  let entered = 0, aborts = 0, active = 0, maxActive = 0, childRequests = 0;
  let script = "", lastContext: any;
  const events: any[] = [];
  const f = await fixture(cwd, async (context, signal) => {
    const parent = getCurrentTools(context.messages).some(t => t.name === "codemode");
    if (parent) {
      if (context.messages.at(-1).role === "toolResult") return { text: "Observed Codemode result; canonical completion remains separate." };
      return { tool: { name: "codemode", arguments: { code: script } } };
    }
    childRequests++;
    const id = /CHILD_(\w+)/.exec(getCurrentSystemPrompt(context.messages))![1];
    if (context.messages.at(-1).role === "toolResult") return { text: "REPORT_" + id };
    active++; maxActive = Math.max(maxActive, active); entered++;
    if (entered === 2) both.open();
    await both.promise;
    if (scenario === "cancel") {
      signal!.addEventListener("abort", () => { if (++aborts === 2) aborted.open(); }, { once: true });
      if (signal!.aborted && ++aborts === 2) aborted.open();
      await finish.promise; signal!.throwIfAborted();
    }
    active--;
    return { tool: { name: "write", arguments: { path: scenario === "partial-rejection" ? "first.txt" : id + ".txt", content: id } } };
  });
  let plan = core.initialize({ title: "Offline actual Codemode fork/join", steps: [
    { id: "first", title: "First", done_when: "first.txt contains first" },
    { id: "second", title: "Second", done_when: "second.txt contains second" },
  ] });
  plan = core.applyRequest(plan, { plan_id: plan.plan_id, base_revision: plan.revision, request_id: "codemode-run",
    intent: "implement", selected_step_ids: ["first", "second"], execution_mode: "auto", operations: [] })[0];
  const planPath = path.join(cwd, "plan.md"); core.saveMarkdown(planPath, plan);
  const args = ["first", "second"].map(id => ({ action: "run", assignment_id: "codemode-" + id, plan_path: planPath,
    request_id: "codemode-run", step_id: id, instructions: "Execute CHILD_" + id, context: "CHILD_" + id,
    write_paths: [scenario === "partial-rejection" ? "shared.txt" : id + ".txt"] }));
  // In the rejected cohort the sole admitted child still uses its exact assigned file.
  if (scenario === "partial-rejection") {
    args[1].write_paths = ["first.txt"]; args[0].write_paths = ["first.txt"];
  }
  script = "const args = " + JSON.stringify(args) + ";\n" +
    "const joined = await Promise.allSettled(args.map(a => tools.hyperion_agent(a).then(JSON.parse)));\n" +
    'text("JOIN=" + JSON.stringify(joined.map(r => r.status === "fulfilled" ? { status: r.status, state: r.value.state, native_id: r.value.native_id } : { status: r.status, reason: String(r.reason) })));\n' +
    'store("cohort", args);';
  const createParent = async (manager: any) => {
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: path.join(cwd, "parent-agent"),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Offline fixture. Invoke exactly the scripted tool; no ambient files or network.",
      extensionFactories: [
        (pi: any) => {
          registerAgentTool(pi, { record(ctx, record) {
            lastContext = ctx; observed.set(record.id, record);
            if (observed.size === 2 && [...observed.values()].every(r => r.settled || r.state === "unknown")) drained.open();
          }, event() {} });
          pi.on("session_start", (_event: any, ctx: any) => { lastContext = ctx; });
          pi.on("tool_result", (event: any) => { if (scenario === "partial-rejection" && event.toolName === "hyperion_agent" && event.isError) both.open(); });
        },
        sdk.createCodemodeExtension({ mode: "on" }),
      ] });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd, agentDir: path.join(cwd, "parent-agent"), resourceLoader: loader,
      sessionManager: manager, modelRuntime: f.options.modelRuntime, model: f.options.model, thinkingLevel: "off",
      settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false },
        defaultTools: ["codemode", "hyperion_agent"] }) });
    session.subscribe((event: any) => { if (event.type === "tool_execution_start") events.push(structuredClone(event)); });
    await session.bindExtensions({});
    assert.deepEqual(session.getActiveToolNames().sort(), ["codemode", "hyperion_agent"]);
    return session;
  };
  const manager = sdk.SessionManager.create(cwd, path.join(cwd, "parent"));
  let parent = await createParent(manager);
  const history = () => manager.getEntries().filter((e: any) => e.type === "custom" && e.customType === "hyperion.agent").map((e: any) => e.data);
  const latest = () => [...new Map(history().map((r: any) => [r.id, r])).values()] as AgentRecord[];
  try {
    const pending = parent.prompt("FORK: execute this authorized fixture cohort.");
    if (scenario === "cancel") {
      await both.promise;
      const cancelling = parent.abort();
      await aborted.promise;
      // Host abort acknowledgement is not native child quiescence.
      assert.throws(() => assertAgentIdle(lastContext), /live or unknown writers|unknown writers/);
      finish.open(); await cancelling;
    }
    await pending;
    if (scenario === "cancel") await drained.promise;
    const nested = events.filter(e => e.toolName === "hyperion_agent" && e.parentToolCallId);
    assert.equal(nested.length, 2, "actual nested execution, not direct handler calls");
    assert.ok(nested.every(e => e.toolCallId.startsWith(e.parentToolCallId + "/")));
    assert.equal(new Set(nested.map(e => e.toolCallId)).size, 2);
    const records = latest();
    const current = core.loadMarkdown(planPath)[0];
    if (scenario === "partial-rejection") {
      assert.equal(records.filter(r => r.state === "succeeded").length, 1);
      assert.equal(records.filter(r => r.state === "rejected").length, 1);
      assert.equal(current.revision, plan.revision + 1);
      const result = parent.messages.find((m: any) => m.role === "toolResult" && m.toolName === "codemode");
      assert.ok(result && !result.isError, JSON.stringify(result));
      const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      assert.match(text, /"status":"rejected"/); assert.match(text, /"state":"succeeded"/);
    } else {
      assert.equal(maxActive, 2, "two native child model operations actually overlap");
      assert.equal(records.length, 2);
      assert.ok(records.every(r => r.settled && r.state === (scenario === "cancel" ? "cancelled" : "succeeded")), JSON.stringify(records));
      assert.equal(current.revision, plan.revision + 2);
      assert.deepEqual(current.steps.map((s: any) => s.status), ["in_progress", "in_progress"]);
      if (scenario !== "cancel") {
        for (const id of ["first", "second"]) assert.equal(fs.readFileSync(path.join(cwd, id + ".txt"), "utf8"), id);
        const result = parent.messages.find((m: any) => m.role === "toolResult" && m.toolName === "codemode");
        assert.ok(result && !result.isError, JSON.stringify(result));
        const output = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
        const joined = JSON.parse(/JOIN=([^\n]+)/.exec(output)![1]);
        assert.equal(joined.length, 2); assert.ok(joined.every((r: any) => r.status === "fulfilled" && r.state === "succeeded"));
        assert.equal(new Set(joined.map((r: any) => r.native_id)).size, 2);
      } else for (const id of ["first", "second"]) assert.equal(fs.existsSync(path.join(cwd, id + ".txt")), false);
    }
    let restored = false;
    if (scenario === "restore") {
      const first = history().find((r: any) => r.id === "codemode-first" && r.state === "launching")!;
      // Simulated loss of parent terminal evidence; no process/laptop sleep claim.
      manager.appendCustomEntry("hyperion.agent", { ...first, state: "unknown", settled: false });
      const recordBefore = JSON.stringify(history()), sourceBefore = fs.readFileSync(planPath, "utf8");
      const countBefore = childRequests, originalId = manager.getSessionId(), parentFile = manager.getSessionFile();
      parent.dispose();
      const reopened = sdk.SessionManager.open(parentFile);
      assert.equal(reopened.getSessionId(), originalId);
      parent = await createParent(reopened);
      script = 'const saved = load("cohort"); if (!saved || saved.length !== 2) throw Error("missing native store");\n' +
        'const group = JSON.parse(await tools.hyperion_agent({ action: "inspect", plan_path: saved[0].plan_path, request_id: saved[0].request_id }));\n' +
        'text("RECOVERY=" + JSON.stringify(group));\n' +
        'const repeated = await Promise.allSettled(saved.map(a => tools.hyperion_agent(a).then(JSON.parse))); text("REPEATED=" + JSON.stringify(repeated.map(r => r.status)));';
      await parent.prompt("RESTORE: inspect the same coordinator; never replay its fork.");
      const result = [...parent.messages].reverse().find((m: any) => m.role === "toolResult" && m.toolName === "codemode");
      assert.ok(result && !result.isError, JSON.stringify(result));
      const output = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      assert.match(output, /"source":"child-session"/); assert.match(output, /"parent_settled":false/);
      assert.match(output, /REPORT_first/);
      assert.equal(childRequests, countBefore, "no child resurrection or interrupted-script replay");
      const reopenedHistory = reopened.getEntries().filter((e: any) => e.type === "custom" && e.customType === "hyperion.agent").map((e: any) => e.data);
      assert.equal(JSON.stringify(reopenedHistory), recordBefore); assert.equal(fs.readFileSync(planPath, "utf8"), sourceBefore);
      assert.throws(() => assertAgentIdle(lastContext), /unknown writers/);
      restored = true;
    }
    return { scenario, sdk_version: "1.0.3", max_active: maxActive, nested_calls: nested.length, restored, child_requests: childRequests };
  } finally { finish.open(); parent.dispose(); }
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
