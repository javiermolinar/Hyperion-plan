// Test-only provider. No network or credentials; it asserts the actual model request.
import * as fs from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { workflowFixture } from './workflow-fixture';

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
