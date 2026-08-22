import {
  AIGatewayModelRouting,
  AIGatewayModels,
  ZuploContext,
  ZuploRequest,
} from "@zuplo/runtime";

export interface RoundRobinEmbeddingsOptions {
  /** Explicit list of provider names to balance across (e.g. ["jinaai", "jinaai02"]). If omitted, all active providers with embeddings capability are used. */
  providers?: string[];
  /** Specific embeddings model to match (e.g. "jina-embeddings-v5-text-small"). If omitted, matches any active embeddings model. */
  targetModel?: string;
  /** Balancing strategy: "round-robin" | "random". Default is "round-robin". */
  strategy?: "round-robin" | "random";
  /** Whether to configure an alternate provider as automated fallback. Default is true. */
  enableFallback?: boolean;
  /** Timeout in seconds before falling back to backup provider. Default is 15s. */
  fallbackTimeoutSeconds?: number;
}

let requestCounter = 0;

export default async function roundRobinEmbeddings(
  request: ZuploRequest,
  context: ZuploContext,
  options: RoundRobinEmbeddingsOptions = {},
): Promise<ZuploRequest | Response> {
  const url = request.url.toLowerCase();

  // Guard: Only execute for embeddings requests
  if (!url.includes("/embeddings")) {
    return request;
  }

  const allowed = options.providers?.map((p) => p.toLowerCase());
  const catalog = await AIGatewayModels.load(context);

  // Filter all active embeddings candidate models
  const candidates = catalog
    .filter(
      ({ providerName }) =>
        !allowed || allowed.includes(providerName.toLowerCase()),
    )
    .flatMap((provider) =>
      provider.models.map((model) => ({
        providerName: provider.providerName,
        model,
      })),
    )
    .filter(
      ({ model }) =>
        model.capability === "embeddings" && model.status === "active",
    )
    .filter(
      ({ model }) =>
        !options.targetModel ||
        model.model.toLowerCase() === options.targetModel.toLowerCase(),
    );

  if (candidates.length === 0) {
    context.log.error(
      "No eligible embeddings providers/models found in AI Gateway catalog.",
    );
    return new Response(
      JSON.stringify({
        error: {
          message: "No active embeddings provider available.",
          type: "service_unavailable",
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  // Determine primary index based on strategy
  let primaryIndex = 0;
  if (options.strategy === "random") {
    primaryIndex = Math.floor(Math.random() * candidates.length);
  } else {
    primaryIndex = requestCounter % candidates.length;
    requestCounter = (requestCounter + 1) % 1_000_000;
  }

  const primary = candidates[primaryIndex];
  const existingRouting = AIGatewayModelRouting.get(context) ?? {};

  let embeddingsRouting: any = `${primary.providerName}/${primary.model.model}`;

  // Configure automatic fallback to next available provider if enabled and multiple candidates exist
  if (options.enableFallback !== false && candidates.length > 1) {
    const backupIndex = (primaryIndex + 1) % candidates.length;
    const backup = candidates[backupIndex];

    if (
      backup.providerName !== primary.providerName ||
      backup.model.model !== primary.model.model
    ) {
      embeddingsRouting = {
        main: `${primary.providerName}/${primary.model.model}`,
        backup: `${backup.providerName}/${backup.model.model}`,
        fallbackTimeoutSeconds: options.fallbackTimeoutSeconds ?? 15,
      };
    }
  }

  // Update model routing in Zuplo context
  await AIGatewayModelRouting.set(context, {
    ...existingRouting,
    embeddings: embeddingsRouting,
  });

  context.log.info(
    `[Embeddings Route] Selected provider '${primary.providerName}' (Model: '${primary.model.model}') using ${options.strategy ?? "round-robin"} strategy.`,
  );

  return request;
}
