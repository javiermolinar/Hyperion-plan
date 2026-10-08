import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPlanTool, registerAgentTool } from "./executor";
import { registerContext, PROGRESS_TYPE } from "./context";
import { openPlan, planToolPresentation, registerAgentView } from "./ui";
import { registerPlanFooter } from "./footer";

export default function (pi: ExtensionAPI): void {
  let screenOpen = false;
  const show = async (args: string, ctx: ExtensionContext) => {
    if (screenOpen) { ctx.ui.notify("The Hyperion view is already open.", "info"); return; }
    screenOpen = true;
    try { await openPlan(args, ctx, pi, ctx.mode === "tui" ? context.captureSession(ctx) : undefined, agents.open); } finally { screenOpen = false; }
  };
  const footer = registerPlanFooter(pi);
  const context = registerContext(pi, footer.update);
  // Keep old transcripts readable without restoring the superseded progress panes.
  pi.registerMessageRenderer(PROGRESS_TYPE, () => ({ render: () => [], invalidate() {} }));
  registerPlanTool(pi, { ...context, open: ctx => show("", ctx), presentation: planToolPresentation });
  const agents = registerAgentView(pi, footer.agents);
  if (process.env.HYPERION_DISABLE_AGENTS !== "1") registerAgentTool(pi, agents);
  pi.registerCommand("hyperion", {
    description: "Open a canonical Hyperion plan and its agents in one terminal view",
    handler: show,
  });
}
