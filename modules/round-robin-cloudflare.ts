import {
  AIGatewayModelRouting,
  AIGatewayModels,
  ZuploContext,
  ZuploRequest,
} from "@zuplo/runtime";

export interface RoundRobinCloudflareOptions {
  /**
   * Explicit list of Cloudflare provider names configured in Zuplo Settings
   * (e.g. ["cloudflare", "cloudflare-2", "cloudflare-3"]).
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
   * Timeout in seconds before triggering fallback to the backup provider.
   * Shortened to 5s by default to prevent exhausting client request timeouts during failover.
   */
  fallbackTimeoutSeconds?: number;

  /**
   * Whether to enable the circuit breaker / cooldown mechanism. Default is true.
   */
  enableCircuitBreaker?: boolean;

  /**
   * Cooldown period in minutes when an account returns 429 quota exhaustion or 5xx error. Default is 15 minutes.
   */
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
  const cooldownMinutes = options.cooldownMinutes ?? 15;
  const useCircuitBreaker = options.enableCircuitBreaker !== false;
  const fallbackTimeoutSeconds = options.fallbackTimeoutSeconds ?? 5; // Default: 5s

  // 1. Identify all eligible Cloudflare providers
  const allowed = options.providers?.map((p) => p.toLowerCase());
  const allCandidates = catalog
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

  if (allCandidates.length === 0) {
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

  // 2. Circuit Breaker Filtering: Partition candidates into healthy vs in-cooldown
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
        `[Cloudflare AI Pool] All ${allCandidates.length} provider(s) are currently in cooldown. Attempting provider '${sortedByExpiry[0].providerName}' whose cooldown expires earliest.`,
      );
    }
  }

  // 3. Select primary provider using Round-Robin or Random strategy across healthy candidates
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
  let backupProviderName: string | undefined;

  // 4. Configure automatic fallback to next healthy account
  if (options.enableFallback !== false) {
    // Look for a distinct backup in healthy candidates first, or in allCandidates
    const potentialBackups = (
      healthyCandidates.length > 1 ? healthyCandidates : allCandidates
    ).filter(
      (c) => c.providerName.toLowerCase() !== primary.providerName.toLowerCase(),
    );

    if (potentialBackups.length > 0) {
      const backup = potentialBackups[0];
      backupProviderName = backup.providerName;
      routeConfig = {
        main: `${primary.providerName}/${primary.model.model}`,
        backup: `${backup.providerName}/${backup.model.model}`,
        fallbackTimeoutSeconds,
      };
    }
  }

  // 5. Store selected providers in context.custom so outbound handler can track response
  if (context.custom) {
    context.custom.selectedPrimaryProvider = primary.providerName;
    context.custom.selectedBackupProvider = backupProviderName;
    context.custom.cooldownMinutes = cooldownMinutes;
  }

  // 6. Update AI Gateway model routing in Zuplo context
  const updatedRouting: Record<string, any> = {
    ...existingRouting,
    [capability]: routeConfig,
  };

  await AIGatewayModelRouting.set(context, updatedRouting);

  const fallbackInfo =
    typeof routeConfig === "object" && routeConfig.backup
      ? ` -> Fallback: '${routeConfig.backup}' (timeout: ${fallbackTimeoutSeconds}s)`
      : "";

  const poolStatus = useCircuitBreaker
    ? ` [Healthy: ${healthyCandidates.length}/${allCandidates.length}, In Cooldown: ${inCooldownCandidates.length}]`
    : "";

  context.log.info(
    `[Cloudflare AI Pool] Selected provider '${primary.providerName}' (Model: '${primary.model.model}')${fallbackInfo}${poolStatus} using ${options.strategy ?? "round-robin"} strategy across ${candidates.length} candidate(s).`,
  );

  return request;
}

/**
 * Outbound policy handler to inspect downstream responses and trip the circuit breaker
 * for any provider that returns HTTP 429 (rate limit/quota exhaustion) or 5xx server error.
 */
export async function outboundHandler(
  response: Response,
  request: ZuploRequest,
  context: ZuploContext,
  options: RoundRobinCloudflareOptions = {},
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

  // If response failed with 429 (quota exceeded / rate limit) or 5xx, trip circuit breaker
  if (response.status === 429 || response.status >= 500) {
    tripCircuitBreaker(primaryProvider, cooldownMinutes, response.status);
    context.log.warn(
      `[Cloudflare AI Pool Circuit Breaker] Tripped circuit breaker for primary provider '${primaryProvider}' due to HTTP ${response.status}. Placed in cooldown for ${cooldownMinutes}m.`,
    );

    if (backupProvider) {
      tripCircuitBreaker(backupProvider, cooldownMinutes, response.status);
      context.log.warn(
        `[Cloudflare AI Pool Circuit Breaker] Tripped circuit breaker for backup provider '${backupProvider}' due to HTTP ${response.status}. Placed in cooldown for ${cooldownMinutes}m.`,
      );
    }
  } else if (response.status === 200) {
    resetCircuitBreaker(primaryProvider);
  }

  return response;
}
