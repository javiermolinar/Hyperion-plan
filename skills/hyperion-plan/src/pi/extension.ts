import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerPlanTool, registerAgentTool, registerOwnerFence } from "./executor";
import { registerContext, PROGRESS_TYPE } from "./context";
import { openPlan, planToolPresentation, progressView, registerAgentView } from "./ui";

export default function (pi: ExtensionAPI): void {
  let screenOpen = false;
  const show = async (args: string, ctx: ExtensionContext) => {
    if (screenOpen) { ctx.ui.notify("The Hyperion view is already open.", "info"); return; }
    screenOpen = true;
    try { await openPlan(args, ctx, pi, ctx.mode === "tui" ? context.captureSession(ctx) : undefined, agents.open); } finally { screenOpen = false; }
  };
  const context = registerContext(pi, progressView);
  pi.registerMessageRenderer(PROGRESS_TYPE, (message, _options, theme) =>
    new Text(`${theme.fg("accent", "HYPERION · PROGRESS")}\n${typeof message.content === "string" ? message.content : ""}`, 1, 1));
  registerPlanTool(pi, { ...context, open: ctx => show("", ctx), presentation: planToolPresentation });
  registerOwnerFence(pi);
  const agents = registerAgentView(pi);
  if (process.env.HYPERION_DISABLE_AGENTS !== "1") registerAgentTool(pi, agents);
  pi.registerCommand("hyperion", {
    description: "Open a canonical Hyperion plan and its agents in one terminal view",
    handler: show,
  });
}
