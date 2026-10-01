import * as path from "node:path";
import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requireValue as require } from "../model";
import { dispatchDirectory } from "./dispatch-ledger";

/** Proxy only the explicitly selected model through the public registry facade.
 * No private runtime access, ambient provider catalog or parent history. */
export async function childModelProxy(ctx: ExtensionContext, planPath: string) {
  require(ctx.model, "No current model available for child assignment");
  const model = structuredClone(ctx.model), registry = ctx.modelRegistry;
  const runtime = await ModelRuntime.create({ authPath: path.join(dispatchDirectory(planPath), "child-proxy-auth.json"),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "in-process-registry-proxy",
    models: [model], streamSimple: (selected, context, options) => {
      // The child key only admits this in-process proxy. Forwarding it would
      // override the source registry's real credentials (including OAuth).
      const { apiKey: _childApiKey, ...sourceOptions } = options ?? {};
      return registry.streamSimple(selected, context, sourceOptions);
    } });
  return { model, runtime };
}
