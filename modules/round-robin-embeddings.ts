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
  /** Timeout in seconds before falling back to backup provider. Default is 5s. */
  fallbackTimeoutSeconds?: number;
  /** Whether to enable circuit breaker. Default is true. */
  enableCircuitBreaker?: boolean;
  /** Cooldown duration in minutes when provider fails. Default is 15m. */
  cooldownMinutes?: number;
}

interface ProviderCircuitState {
  failures: number;
  lastFailureTime: number;
  cooldownUntil: number;
  lastErrorStatus?: number;
}

// In-memory circuit breaker map persisted across requests within the worker isolate
const circuitBreakerMap = new Map<string, ProviderCircuitState>();
let requestCounter = 0;

/**
 * Returns true if the provider is currently healthy (not in cooldown).
 */
export function isProviderHealthy(providerName: string): boolean {
  const state = circuitBreakerMap.get(providerName.toLowerCase());
  if (!state) return true;
  return Date.now() >= state.cooldownUntil;
}

/**
 * Mark a provider in cooldown.
 */
export function tripCircuitBreaker(
  providerName: string,
  cooldownMinutes: number = 15,
  status?: number,
): void {
  const key = providerName.toLowerCase();
  const existing = circuitBreakerMap.get(key) ?? {
    failures: 0,
    lastFailureTime: 0,
    cooldownUntil: 0,
  };
  const cooldownMs = cooldownMinutes * 60 * 1000;
  circuitBreakerMap.set(key, {
    failures: existing.failures + 1,
    lastFailureTime: Date.now(),
    cooldownUntil: Date.now() + cooldownMs,
    lastErrorStatus: status,
  });
}

/**
 * Clear cooldown/failure status for a successful provider.
 */
export function resetCircuitBreaker(providerName: string): void {
  const key = providerName.toLowerCase();
  const existing = circuitBreakerMap.get(key);
  if (existing && existing.failures > 0) {
    circuitBreakerMap.set(key, {
      ...existing,
      failures: 0,
    });
  }
}

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
  const cooldownMinutes = options.cooldownMinutes ?? 15;
  const useCircuitBreaker = options.enableCircuitBreaker !== false;
  const fallbackTimeoutSeconds = options.fallbackTimeoutSeconds ?? 5; // Default: 5s

  // Filter all active embeddings candidate models
  const allCandidates = catalog
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

  if (allCandidates.length === 0) {
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

  // Circuit Breaker Filtering: Partition candidates into healthy vs in-cooldown
  let candidates = allCandidates;
  let healthyCandidates = allCandidates;
  let inCooldownCandidates: typeof allCandidates = [];

  if (useCircuitBreaker) {
    healthyCandidates = allCandidates.filter((c) =>
      isProviderHealthy(c.providerName),
    );
    inCooldownCandidates = allCandidates.filter(
      (c) => !isProviderHealthy(c.providerName),
    );

    if (healthyCandidates.length > 0) {
      candidates = healthyCandidates;
    } else {
      // All providers are in cooldown! Select the one whose cooldown expires earliest
      const sortedByExpiry = [...allCandidates].sort((a, b) => {
        const aExpiry =
          circuitBreakerMap.get(a.providerName.toLowerCase())?.cooldownUntil ?? 0;
        const bExpiry =
          circuitBreakerMap.get(b.providerName.toLowerCase())?.cooldownUntil ?? 0;
        return aExpiry - bExpiry;
      });
      candidates = [sortedByExpiry[0]];
      context.log.warn(
        `[Embeddings Route] All ${allCandidates.length} provider(s) are currently in cooldown. Attempting provider '${sortedByExpiry[0].providerName}' whose cooldown expires earliest.`,
      );
    }
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
  let backupProviderName: string | undefined;

  // Configure automatic fallback to next available provider if enabled and multiple candidates exist
  if (options.enableFallback !== false) {
    const potentialBackups = (
      healthyCandidates.length > 1 ? healthyCandidates : allCandidates
    ).filter(
      (c) => c.providerName.toLowerCase() !== primary.providerName.toLowerCase(),
    );

    if (potentialBackups.length > 0) {
      const backup = potentialBackups[0];
      backupProviderName = backup.providerName;
      embeddingsRouting = {
        main: `${primary.providerName}/${primary.model.model}`,
        backup: `${backup.providerName}/${backup.model.model}`,
        fallbackTimeoutSeconds,
      };
    }
  }

  // Store selected providers in context.custom so outbound handler can track response
  if (context.custom) {
    context.custom.selectedPrimaryProvider = primary.providerName;
    context.custom.selectedBackupProvider = backupProviderName;
    context.custom.cooldownMinutes = cooldownMinutes;
  }

  // Update model routing in Zuplo context
  await AIGatewayModelRouting.set(context, {
    ...existingRouting,
    embeddings: embeddingsRouting,
  });

  const fallbackInfo =
    typeof embeddingsRouting === "object" && embeddingsRouting.backup
      ? ` -> Fallback: '${embeddingsRouting.backup}' (timeout: ${fallbackTimeoutSeconds}s)`
      : "";

  const poolStatus = useCircuitBreaker
    ? ` [Healthy: ${healthyCandidates.length}/${allCandidates.length}, In Cooldown: ${inCooldownCandidates.length}]`
    : "";

  context.log.info(
    `[Embeddings Route] Selected provider '${primary.providerName}' (Model: '${primary.model.model}')${fallbackInfo}${poolStatus} using ${options.strategy ?? "round-robin"} strategy across ${candidates.length} candidate(s).`,
  );

  return request;
}

/**
 * Outbound policy handler to inspect downstream responses and trip the circuit breaker
 * for any provider that returns HTTP 429 or 5xx server error.
 */
export async function outboundHandler(
  response: Response,
  request: ZuploRequest,
  context: ZuploContext,
  options: RoundRobinEmbeddingsOptions = {},
): Promise<Response> {
  const primaryProvider = context.custom?.selectedPrimaryProvider as
    | string
    | undefined;
  const backupProvider = context.custom?.selectedBackupProvider as
    | string
    | undefined;
  const cooldownMinutes =
    (context.custom?.cooldownMinutes as number) ??
    options.cooldownMinutes ??
    15;

  if (!primaryProvider) {
    return response;
  }

  if (response.status === 429 || response.status >= 500) {
    tripCircuitBreaker(primaryProvider, cooldownMinutes, response.status);
    context.log.warn(
      `[Embeddings Circuit Breaker] Tripped circuit breaker for primary provider '${primaryProvider}' due to HTTP ${response.status}. Placed in cooldown for ${cooldownMinutes}m.`,
    );

    if (backupProvider) {
      tripCircuitBreaker(backupProvider, cooldownMinutes, response.status);
      context.log.warn(
        `[Embeddings Circuit Breaker] Tripped circuit breaker for backup provider '${backupProvider}' due to HTTP ${response.status}. Placed in cooldown for ${cooldownMinutes}m.`,
      );
    }
  } else if (response.status === 200) {
    resetCircuitBreaker(primaryProvider);
  }

  return response;
}
