/**
 * ollama-mke Cost Tracking Extension for Pi
 *
 * Reads cost data from the gateway's `x-litellm-response-cost` response header
 * and overrides Pi's static cost calculation. This works for any model routed
 * through our ollama-mke LiteLLM gateway, since it maintains its own
 * comprehensive pricing database.
 *
 * Fallback: At startup, fetches model pricing from the gateway's /model/info
 * endpoint and uses those rates when the response header isn't available
 * (e.g., streaming).
 *
 * Fork of https://github.com/xec-abailey/pi-litellm (extensions/litellm-cost.ts).
 *
 * Configuration resolution (same priority and source as litellm-sync.ts, so
 * the two extensions never disagree about which gateway they are talking to):
 *   1. OLLAMA_MKE_BASE_URL / OLLAMA_MKE_API_KEY env vars
 *   2. Legacy LITELLM_BASE_URL / LITELLM_API_KEY env vars
 *   3. providers["ollama-mke"] in ~/.pi/agent/models.json
 *   4. Legacy providers.litellm in ~/.pi/agent/models.json
 *   5. Defaults (http://localhost:4000, sk-cedar-local)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface ModelCostInfo {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
}

/**
 * Resolve the gateway base URL and API key using the exact same priority and
 * models.json shape as litellm-sync.ts. Kept local (rather than imported)
 * because pi loads each extension file independently with no shared module
 * resolution between them.
 */
function resolveGatewayConfig(): { baseUrl: string; apiKey: string } {
  const defaults = { baseUrl: "http://localhost:4000", apiKey: "sk-cedar-local" };

  let fromModelsJson: { baseUrl?: string; apiKey?: string } = {};
  const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
  if (existsSync(modelsJsonPath)) {
    try {
      const raw = readFileSync(modelsJsonPath, "utf-8");
      const stripped = raw
        .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
        .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
      const parsed = JSON.parse(stripped) as { providers?: Record<string, any> };
      const p = parsed?.providers?.["ollama-mke"] ?? parsed?.providers?.litellm ?? {};
      fromModelsJson = { baseUrl: p.baseUrl, apiKey: p.apiKey };
    } catch {
      // Ignore parse errors — fall through to defaults, same as litellm-sync.ts.
    }
  }

  return {
    baseUrl:
      process.env.OLLAMA_MKE_BASE_URL ??
      process.env.LITELLM_BASE_URL ??
      fromModelsJson.baseUrl ??
      defaults.baseUrl,
    apiKey:
      process.env.OLLAMA_MKE_API_KEY ??
      process.env.LITELLM_API_KEY ??
      fromModelsJson.apiKey ??
      defaults.apiKey,
  };
}

export default function (pi: ExtensionAPI) {
  const { baseUrl: BASE_URL, apiKey: API_KEY } = resolveGatewayConfig();

  // Store per-model cost info from /model/info
  const modelCosts = new Map<string, ModelCostInfo>();

  // Store the latest response cost header (keyed by a transient request marker)
  let lastResponseCost: number | null = null;

  // Fetch model pricing from the gateway at startup. A single transient
  // network hiccup during Pi's own startup window (DNS/socket not warm yet,
  // gateway briefly busy) shouldn't surface a scary warning, so retry once
  // after a short delay before giving up. Each attempt has its own timeout
  // so a hung connection doesn't block Pi's startup indefinitely.
  async function fetchModelInfoOnce(): Promise<Response> {
    return fetch(`${BASE_URL}/model/info`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      let response: Response;
      try {
        response = await fetchModelInfoOnce();
      } catch {
        // First attempt failed (timeout, DNS not ready yet, connection reset
        // during startup, etc.) — wait briefly and retry once before
        // reporting a warning to the user.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        response = await fetchModelInfoOnce();
      }

      if (!response.ok) {
        ctx.ui.notify(
          `ollama-mke cost extension: /model/info returned ${response.status}`,
          "warning"
        );
        return;
      }

      const payload = (await response.json()) as {
        data: Array<{
          model_name: string;
          litellm_params?: { model?: string };
          model_info?: {
            input_cost_per_token?: number;
            output_cost_per_token?: number;
            cache_read_input_token_cost?: number;
            cache_creation_input_token_cost?: number;
          };
        }>;
      };

      for (const entry of payload.data) {
        const info = entry.model_info;
        if (!info) continue;

        const costInfo: ModelCostInfo = {
          inputCostPerToken: info.input_cost_per_token ?? 0,
          outputCostPerToken: info.output_cost_per_token ?? 0,
          cacheReadCostPerToken: info.cache_read_input_token_cost ?? 0,
          cacheWriteCostPerToken: info.cache_creation_input_token_cost ?? 0,
        };

        // Store by model_name (what clients use to route)
        modelCosts.set(entry.model_name, costInfo);

        // Also store by the underlying litellm model param
        if (entry.litellm_params?.model) {
          modelCosts.set(entry.litellm_params.model, costInfo);
        }
      }

      if (modelCosts.size > 0) {
        ctx.ui.notify(
          `ollama-mke cost: loaded pricing for ${modelCosts.size} model(s)`,
          "info"
        );
      }
    } catch (err: any) {
      // Non-fatal even after the retry: per-request cost still works via
      // the x-litellm-response-cost header, this only affects the
      // startup pricing pre-load used for streaming fallback.
      //
      // Node's fetch (undici) reports a generic message like "fetch failed"
      // at err.message and puts the real underlying cause (ECONNREFUSED,
      // ENOTFOUND, TLS error, socket timeout, etc.) at err.cause. Surface
      // both, plus the exact URL, so a real outage is diagnosable from this
      // one notify line instead of a bare "fetch failed".
      const cause =
        err?.cause instanceof Error
          ? err.cause.message
          : err?.cause != null
          ? String(err.cause)
          : undefined;
      ctx.ui.notify(
        `ollama-mke cost extension: could not fetch ${BASE_URL}/model/info after retry (${err.message}` +
          `${cause ? ` — cause: ${cause}` : ""})`,
        "warning"
      );
    }
  });

  // Capture the x-litellm-response-cost header after each provider response
  pi.on("after_provider_response", (event, _ctx) => {
    const costHeader =
      event.headers?.["x-litellm-response-cost"] ??
      event.headers?.["X-Litellm-Response-Cost"];

    if (costHeader) {
      const cost = parseFloat(String(costHeader));
      if (!isNaN(cost)) {
        lastResponseCost = cost;
        return;
      }
    }
    // Reset if header not present (streaming may not include it)
    lastResponseCost = null;
  });

  // Override the message cost at message_end
  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    const usage = event.message.usage;
    if (!usage) return;

    let totalCost: number | null = null;

    // Priority 1: Use x-litellm-response-cost header if we captured it
    if (lastResponseCost !== null) {
      totalCost = lastResponseCost;
      lastResponseCost = null; // consume it
    }

    // Priority 2: Calculate from gateway model pricing + token counts
    if (totalCost === null) {
      const modelId = event.message.model;
      const costInfo = modelId ? modelCosts.get(modelId) : undefined;

      if (costInfo) {
        const inputCost = costInfo.inputCostPerToken * usage.input;
        const outputCost = costInfo.outputCostPerToken * usage.output;
        const cacheReadCost = costInfo.cacheReadCostPerToken * (usage.cacheRead ?? 0);
        const cacheWriteCost = costInfo.cacheWriteCostPerToken * (usage.cacheWrite ?? 0);
        totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

        return {
          message: {
            ...event.message,
            usage: {
              ...usage,
              cost: {
                input: inputCost,
                output: outputCost,
                cacheRead: cacheReadCost,
                cacheWrite: cacheWriteCost,
                total: totalCost,
              },
            },
          },
        };
      }
    }

    // If we have a header-derived total but no breakdown, distribute proportionally
    if (totalCost !== null) {
      const totalTokens =
        usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);

      if (totalTokens > 0) {
        const inputFraction = usage.input / totalTokens;
        const outputFraction = usage.output / totalTokens;
        const cacheReadFraction = (usage.cacheRead ?? 0) / totalTokens;
        const cacheWriteFraction = (usage.cacheWrite ?? 0) / totalTokens;

        return {
          message: {
            ...event.message,
            usage: {
              ...usage,
              cost: {
                input: totalCost * inputFraction,
                output: totalCost * outputFraction,
                cacheRead: totalCost * cacheReadFraction,
                cacheWrite: totalCost * cacheWriteFraction,
                total: totalCost,
              },
            },
          },
        };
      }

      // Edge case: no tokens but have cost
      return {
        message: {
          ...event.message,
          usage: {
            ...usage,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: totalCost,
            },
          },
        },
      };
    }

    // No cost info available - don't modify
    return;
  });
}
