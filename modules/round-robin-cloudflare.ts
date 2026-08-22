import {
  AIGatewayModelRouting,
  AIGatewayModels,
  ZuploContext,
  ZuploRequest,
} from "@zuplo/runtime";

export interface RoundRobinCloudflareOptions {
  /**
   * Explicit list of Cloudflare provider names configured in Zuplo Settings
   * (e.g. ["cloudflare", "cloudflare-2"]).
   * If omitted, all active providers containing "cloudflare" or "cf" are automatically discovered.
   */
  providers?: string[];

  /**
   * Target model to match (e.g. "@cf/google/gemma-4-26b-a4b-it" or "@cf/meta/llama-3.3-70b-instruct").
   */
  targetModel?: string;

  /**
   * Target capability: "completions" (default) or "embeddings".
   */
  capability?: "completions" | "embeddings";

  /**
   * Balancing strategy: "round-robin" (default) | "random".
   */
  strategy?: "round-robin" | "random";

  /**
   * Whether to configure the next available account as an automated fallback.
   * If true (default), when the primary account hits Cloudflare's 10k neuron limit or times out,
   * Zuplo automatically fails over to the backup account.
   */
  enableFallback?: boolean;

  /**
   * Timeout in seconds before triggering fallback to the backup provider. Default is 15s.
   */
  fallbackTimeoutSeconds?: number;
}

let requestCounter = 0;

export default async function roundRobinCloudflare(
  request: ZuploRequest,
  context: ZuploContext,
  options: RoundRobinCloudflareOptions = {},
): Promise<ZuploRequest | Response> {
  const capability = options.capability ?? "completions";
  const url = request.url.toLowerCase();

  // Guard: If this policy is configured for completions, skip embeddings requests
  if (capability === "completions" && url.includes("/embeddings")) {
    return request;
  }
  // Guard: If configured for embeddings, skip non-embeddings requests
  if (capability === "embeddings" && !url.includes("/embeddings")) {
    return request;
  }

  const catalog = await AIGatewayModels.load(context);
  const targetModel = options.targetModel;

  // 1. Identify eligible Cloudflare providers
  const allowed = options.providers?.map((p) => p.toLowerCase());
  const candidates = catalog
    .filter(({ providerName }) => {
      const lower = providerName.toLowerCase();
      if (allowed && allowed.length > 0) {
        return allowed.includes(lower);
      }
      return lower.includes("cloudflare") || lower.startsWith("cf");
    })
    .flatMap((provider) =>
      provider.models.map((model) => ({
        providerName: provider.providerName,
        model,
      })),
    )
    .filter(
      ({ model }) =>
        model.capability === capability && model.status === "active",
    )
    .filter(
      ({ model }) =>
        !targetModel ||
        model.model.toLowerCase() === targetModel.toLowerCase(),
    );

  if (candidates.length === 0) {
    context.log.error(
      `No eligible Cloudflare providers/models found in AI Gateway catalog for capability='${capability}' and model='${targetModel ?? "any"}'.`,
    );
    return new Response(
      JSON.stringify({
        error: {
          message: `No active Cloudflare AI provider available for capability '${capability}'${targetModel ? ` and model '${targetModel}'` : ""}. Please verify Cloudflare providers in Zuplo settings.`,
          type: "service_unavailable",
          param: targetModel ?? null,
          code: "cloudflare_pool_empty",
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  // 2. Select primary provider using Round-Robin or Random strategy
  let primaryIndex = 0;
  if (options.strategy === "random") {
    primaryIndex = Math.floor(Math.random() * candidates.length);
  } else {
    primaryIndex = requestCounter % candidates.length;
    requestCounter = (requestCounter + 1) % 1_000_000;
  }

  const primary = candidates[primaryIndex];
  const existingRouting = AIGatewayModelRouting.get(context) ?? {};

  let routeConfig: any = `${primary.providerName}/${primary.model.model}`;

  // 3. Configure automatic fallback to the next Cloudflare account if multiple accounts exist
  if (options.enableFallback !== false && candidates.length > 1) {
    const backupIndex = (primaryIndex + 1) % candidates.length;
    const backup = candidates[backupIndex];

    if (
      backup.providerName !== primary.providerName ||
      backup.model.model !== primary.model.model
    ) {
      routeConfig = {
        main: `${primary.providerName}/${primary.model.model}`,
        backup: `${backup.providerName}/${backup.model.model}`,
        fallbackTimeoutSeconds: options.fallbackTimeoutSeconds ?? 15,
      };
    }
  }

  // 4. Update AI Gateway model routing in Zuplo context
  const updatedRouting: Record<string, any> = {
    ...existingRouting,
    [capability]: routeConfig,
  };

  await AIGatewayModelRouting.set(context, updatedRouting);

  const fallbackInfo =
    typeof routeConfig === "object" && routeConfig.backup
      ? ` -> Fallback: '${routeConfig.backup}'`
      : "";

  context.log.info(
    `[Cloudflare AI Pool] Selected provider '${primary.providerName}' (Model: '${primary.model.model}')${fallbackInfo} using ${options.strategy ?? "round-robin"} strategy across ${candidates.length} active account(s).`,
  );

  return request;
}
