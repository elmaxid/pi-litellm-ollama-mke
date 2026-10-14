/**
 * ollama-mke Model Sync Extension for Pi
 *
 * Keeps the Pi model selector in sync with our internal ollama-mke LiteLLM
 * gateway's live model list. On startup (and on /reload), fetches
 * GET /v1/models from the gateway and calls pi.registerProvider("ollama-mke", ...)
 * with the exact model IDs the gateway exposes.
 *
 * Fork of https://github.com/xec-abailey/pi-litellm (extensions/litellm-sync.ts),
 * renamed and adapted for our "ollama-mke" gateway provider.
 *
 * Configuration:
 *   Set OLLAMA_MKE_BASE_URL env var or configure providers["ollama-mke"] in models.json
 *   Set OLLAMA_MKE_API_KEY env var or configure providers["ollama-mke"] in models.json
 *   Legacy LITELLM_BASE_URL / LITELLM_API_KEY env vars and providers.litellm in
 *   models.json are read as a fallback for compatibility with the upstream project.
 *
 * Priority: env vars (OLLAMA_MKE_* then legacy LITELLM_*) > models.json
 * (providers["ollama-mke"] then legacy providers.litellm) > defaults
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  alreadyGrantsAllOllamaMkeModels,
  computeEnabledModelsStatus,
  loadEnabledModelsOwnership,
  readCurrentEnabledModels,
  recordManagedEnabledModels,
  saveEnabledModelsOwnership,
  writeManagedEnabledModels,
} from "./enabled-models-ownership.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiteLLMModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  /** Context window advertised by the gateway. Absent for some upstream providers. */
  max_input_tokens?: number | null;
  /** Max output tokens advertised by the gateway. Absent for some upstream providers. */
  max_output_tokens?: number | null;
}

interface LiteLLMModelsResponse {
  data: LiteLLMModel[];
  object: string;
}

/** model_info sub-object of GET /model/info entries. */
interface LiteLLMModelInfo {
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  supports_reasoning?: boolean | null;
  supports_none_reasoning_effort?: boolean | null;
  supports_minimal_reasoning_effort?: boolean | null;
  supports_low_reasoning_effort?: boolean | null;
  supports_medium_reasoning_effort?: boolean | null;
  supports_high_reasoning_effort?: boolean | null;
  supports_xhigh_reasoning_effort?: boolean | null;
  supports_max_reasoning_effort?: boolean | null;
}

/** Shape of GET /model/info (LiteLLM admin endpoint, also used by litellm-cost.ts). */
interface LiteLLMModelInfoEntry {
  model_name: string;
  model_info?: LiteLLMModelInfo | null;
}

interface LiteLLMModelInfoResponse {
  data: LiteLLMModelInfoEntry[];
}

/** Per-model manual overrides, highest priority. */
interface ModelOverride {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** Map pi thinking levels to provider values; null marks a level unsupported. */
  thinkingLevelMap?: Record<string, string | null>;
}

/** Pi thinking levels this extension knows about (order: lowest -> highest). */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Capability facts confirmed by the gateway (/model/info). Effort flags use
 * three states: true/false mean LiteLLM explicitly confirms/denies the level;
 * null/undefined (absent) mean the gateway does not publish a decision — the
 * model gets the provider's default mapping for standard levels, and no
 * unsupported-level claim either way.
 */
interface GatewayCapabilities {
  /** True only when the gateway or an override explicitly confirms reasoning. */
  reasoning: boolean;
  /** Present only when the gateway/override gave at least one concrete fact. */
  thinkingLevelMap?: Record<ThinkingLevel, string | null>;
  /**
   * `true` only when the gateway explicitly confirms at least one effort flag.
   * `undefined` means "not confirmed" and is emitted as an omitted
   * `compat.supportsReasoningEffort`, so pi's own auto-detected default
   * applies. This extension never sets `false`: a silent gateway is not a
   * denial, and switching the transport off turns every level pi offers into a
   * no-op. Levels the gateway explicitly denies are expressed per level in
   * `thinkingLevelMap` (null), which is what hides them from /thinking.
   */
  supportsReasoningEffort: boolean | undefined;
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: string;
  modelOverrides: Record<string, ModelOverride>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive display name from model id, e.g. "bedrock/claude-sonnet-4.6" → "Claude Sonnet 4.6 (Bedrock)" */
function displayName(id: string): string {
  const [prefix, ...rest] = id.split("/");
  const modelPart = rest.join("/");
  if (!modelPart) return id;

  const prefixLabel: Record<string, string> = {
    bedrock: "Bedrock",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    azure: "Azure",
    vertex_ai: "Vertex AI",
    anthropic: "Anthropic",
    ollama: "Ollama",
  };

  const label = prefixLabel[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
  const human = modelPart
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return `${human} (${label})`;
}

/**
 * Guess capabilities from model id. This is a HINT ONLY: it can make a model
 * eligible for gatewayCapabilities() to consider reasoning on, but it never
 * fabricates effort/thinking-level support by itself (R1/R3: no false
 * capability promises to the backend).
 */
function modelMeta(id: string): {
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
} {
  const lower = id.toLowerCase();

  const isOpus = lower.includes("opus");
  const isSonnet = lower.includes("sonnet");
  const isHaiku = lower.includes("haiku");
  const isClaude = lower.includes("claude");
  // Any Claude at version >= 3.5. Version-agnostic so future releases keep
  // reasoning support without another code change.
  const claudeVersion = lower.match(/claude[\-.]?(?:opus|sonnet|haiku|fable)?[\-.]?(\d+)(?:[\-.](\d+))?/);
  const major = claudeVersion ? Number(claudeVersion[1]) : 0;
  const minor = claudeVersion?.[2] ? Number(claudeVersion[2]) : 0;
  const isModernClaude = isClaude && (major > 3 || (major === 3 && minor >= 5));

  // Reasoning-capable families beyond Claude. Without this, thinking models from
  // other vendors were silently registered as non-reasoning.
  const isOtherReasoning =
    /thinking|reasoner|deepseek-(r|v[4-9])|glm-[5-9]|qwen[3-9]|nemotron|minimax|cogito|kimi-k[3-9]/.test(
      lower
    );

  const reasoning = isModernClaude || isOtherReasoning;

  // Heuristic fallback ONLY. Real values come from gateway metadata when present.
  const contextWindow = isModernClaude ? 200000 : isClaude ? 200000 : 128000;

  const maxTokens = isOpus
    ? 32768
    : isSonnet
    ? 16384
    : isHaiku
    ? 8192
    : 16384;

  return { reasoning, contextWindow, maxTokens };
}

// ---------------------------------------------------------------------------
// Capability interpretation (gateway-confirmed facts only)
// ---------------------------------------------------------------------------

/** Gateway flag name for each standard pi thinking level. */
const EFFORT_FLAG_BY_LEVEL: Record<Exclude<ThinkingLevel, "xhigh">, keyof LiteLLMModelInfo> = {
  off: "supports_none_reasoning_effort",
  minimal: "supports_minimal_reasoning_effort",
  low: "supports_low_reasoning_effort",
  medium: "supports_medium_reasoning_effort",
  high: "supports_high_reasoning_effort",
};

/**
 * Interpret gateway capability metadata conservatively.
 *
 * - `reasoning` is true only when the gateway or a manual override explicitly
 *   confirms it (`supports_reasoning === true`, or `override.reasoning`). The
 *   id-based heuristic is used only when the gateway is silent (undefined),
 *   never to override an explicit gateway `false`.
 * - `thinkingLevelMap` is derived ONLY from explicit gateway flags: standard
 *   levels (off..high) keep the provider default (no null entry) unless the
 *   gateway explicitly denies them. `xhigh` is mapped to "xhigh"/"max" only
 *   when the gateway confirms `supports_xhigh_reasoning_effort` or
 *   `supports_max_reasoning_effort`; an explicit false on both marks it
 *   unsupported (null). If the gateway never confirms `supports_reasoning`
 *   and no effort flag is set (reasoning only came from the heuristic or an
 *   override), no map is produced — pi falls back to its own default mapping
 *   instead of us promising an untested xhigh/max level.
 * - `supportsReasoningEffort` is true only when at least one effort flag is
 *   explicitly true. It is never inferred from a model name, and it is never
 *   set to false: an unconfirmed transport is omitted so pi's own default
 *   applies, instead of silently discarding the level the user selected.
 */
function gatewayCapabilities(
  heuristicReasoning: boolean,
  info: LiteLLMModelInfo | undefined,
  override: ModelOverride
): GatewayCapabilities {
  const overrideReasoning = typeof override.reasoning === "boolean" ? override.reasoning : undefined;
  const gatewayReasoning = info?.supports_reasoning === true ? true : info?.supports_reasoning === false ? false : undefined;
  // Priority: explicit override > explicit gateway fact > heuristic hint.
  const reasoning = overrideReasoning ?? gatewayReasoning ?? heuristicReasoning;

  if (!reasoning) return { reasoning: false, supportsReasoningEffort: undefined };

  let anyEffortFlag = false;
  const map: Record<ThinkingLevel, string | null> = {
    off: "none",
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
  };
  for (const level of Object.keys(EFFORT_FLAG_BY_LEVEL) as Array<keyof typeof EFFORT_FLAG_BY_LEVEL>) {
    const flag = info?.[EFFORT_FLAG_BY_LEVEL[level]];
    if (flag === false) map[level] = null;
    if (flag === true) anyEffortFlag = true;
  }
  const xhighFlag = info?.supports_xhigh_reasoning_effort;
  const maxFlag = info?.supports_max_reasoning_effort;
  // An explicit denial always wins over silence on the sibling flag: only one
  // of the two names is the same top level, so a denied `xhigh` (or a denied
  // `max`) that is not offset by a confirmed `true` anywhere must not stay
  // offered — that is the level the gateway just refused.
  const xhighConfirmed = xhighFlag === true || maxFlag === true;
  const xhighDenied = (xhighFlag === false || maxFlag === false) && !xhighConfirmed;
  if (xhighConfirmed) {
    map.xhigh = maxFlag === true ? "max" : "xhigh";
    anyEffortFlag = true;
  } else if (xhighDenied) {
    map.xhigh = null;
  } else {
    // Neither confirmed nor denied by the gateway: do not claim xhigh support
    // when reasoning itself is unconfirmed by the gateway (heuristic-only).
    if (gatewayReasoning !== true && overrideReasoning === undefined) map.xhigh = null;
  }

  // Only produce a map when we have at least one gateway-confirmed fact
  // (explicit supports_reasoning, an effort flag, or an explicit override).
  // A heuristic-only "reasoning: true" with a silent gateway has no factual
  // basis for a map — pi's built-in default mapping is safer than a guess.
  const hasFactualBasis = gatewayReasoning === true || anyEffortFlag || overrideReasoning !== undefined;

  return {
    reasoning: true,
    thinkingLevelMap: hasFactualBasis ? map : undefined,
    supportsReasoningEffort: anyEffortFlag ? true : undefined,
  };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function resolveConfig(): ProviderConfig {
  const defaults: ProviderConfig = {
    baseUrl: "http://localhost:4000",
    apiKey: "sk-cedar-local",
    api: "openai-completions",
    modelOverrides: {},
  };

  // Try reading from models.json for non-env-var config
  let fromModelsJson: Partial<ProviderConfig> = {};
  const modelsJsonPath = join(homedir(), ".pi", "agent", "models.json");
  if (existsSync(modelsJsonPath)) {
    try {
      const raw = readFileSync(modelsJsonPath, "utf-8");
      // Strip // comments before parsing
      const stripped = raw
        .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
        .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
      const parsed = JSON.parse(stripped) as { providers?: Record<string, any> };
      // Prefer the ollama-mke key; fall back to legacy "litellm" key for migration.
      const p = parsed?.providers?.["ollama-mke"] ?? parsed?.providers?.litellm ?? {};
      fromModelsJson = {
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        api: p.api,
        modelOverrides: p.modelOverrides,
      };
    } catch {
      // Ignore parse errors — fall through to defaults
    }
  }

  // Priority: env vars (OLLAMA_MKE_* then legacy LITELLM_*) > models.json > defaults
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
    api: fromModelsJson.api ?? defaults.api,
    modelOverrides: fromModelsJson.modelOverrides ?? defaults.modelOverrides,
  };
}

// ---------------------------------------------------------------------------
// Secondary metadata source
// ---------------------------------------------------------------------------

/**
 * Fetch GET /model/info. Best-effort: this endpoint may be restricted or slow,
 * so failures degrade silently — token limits fall back to /v1/models then the
 * heuristic, and capability flags simply stay unconfirmed (never fabricated).
 */
async function fetchModelInfo(config: ProviderConfig): Promise<Map<string, LiteLLMModelInfo>> {
  const out = new Map<string, LiteLLMModelInfo>();
  try {
    const res = await fetch(`${config.baseUrl}/model/info`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return out;

    const payload = (await res.json()) as LiteLLMModelInfoResponse;
    for (const entry of payload.data ?? []) {
      const info = entry.model_info;
      if (!entry.model_name || !info) continue;
      out.set(entry.model_name, info);
    }
  } catch {
    // Ignore — /v1/models plus the heuristic still produce a usable registration.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core sync function
// ---------------------------------------------------------------------------

async function syncModels(pi: ExtensionAPI): Promise<void> {
  const config = resolveConfig();

  let models: LiteLLMModel[];
  try {
    const res = await fetch(`${config.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as LiteLLMModelsResponse;
    models = payload.data ?? [];
  } catch (err) {
    // Node's fetch (undici) reports a generic message like "fetch failed" at
    // err.message and puts the real underlying cause (ECONNREFUSED,
    // ENOTFOUND, TLS error, socket timeout, etc.) at err.cause. Surface both
    // so a real, persistent outage is diagnosable from this one log line.
    const cause =
      err instanceof Error && err.cause instanceof Error
        ? ` — cause: ${err.cause.message}`
        : "";
    console.error(
      `[ollama-mke-sync] Failed to fetch models from ${config.baseUrl}: ${err instanceof Error ? err.message : err}${cause}`
    );
    return;
  }

  if (models.length === 0) {
    console.warn("[ollama-mke-sync] No models returned from gateway — skipping registration.");
    return;
  }

  // Query /model/info whenever /v1/models left token-limit gaps, OR always,
  // since it is also the only source of confirmed reasoning/effort capability
  // facts. Skipping it would silently fall back to name-only heuristics for
  // capabilities even when /v1/models already had context/output limits.
  const modelInfo = await fetchModelInfo(config);

  let fromProvider = 0;
  let fromHeuristic = 0;
  let reasoningFromGateway = 0;
  const unresolved: string[] = [];
  const unresolvedMaxTokens: string[] = [];

  const registered = models.map((m) => {
    const meta = modelMeta(m.id);
    const info = modelInfo.get(m.id);
    const override = config.modelOverrides[m.id] ?? {};

    // Priority: explicit override > /v1/models > /model/info > heuristic.
    const contextWindow =
      override.contextWindow ?? m.max_input_tokens ?? info?.max_input_tokens ?? meta.contextWindow;
    const maxTokens =
      override.maxTokens ?? m.max_output_tokens ?? info?.max_output_tokens ?? meta.maxTokens;

    const contextFromProvider =
      override.contextWindow != null || m.max_input_tokens != null || info?.max_input_tokens != null;
    if (contextFromProvider) fromProvider++;
    else {
      fromHeuristic++;
      unresolved.push(m.id);
    }

    // An output cap taken from the name heuristic is just as invented as a
    // context window, and silently truncates long answers, so it is reported
    // the same way instead of being absorbed by the fallback.
    const maxTokensFromProvider =
      override.maxTokens != null || m.max_output_tokens != null || info?.max_output_tokens != null;
    if (!maxTokensFromProvider) unresolvedMaxTokens.push(m.id);

    // Capabilities: gateway-confirmed facts > explicit override > name heuristic.
    const caps = gatewayCapabilities(meta.reasoning, info, override);
    if (info?.supports_reasoning === true) reasoningFromGateway++;

    return {
      id: m.id,
      name: displayName(m.id),
      reasoning: caps.reasoning,
      // Per-level merge (not full replace): an override that sets only
      // e.g. { off: "medium" } keeps the gateway-derived values for every
      // other level instead of wiping them out.
      thinkingLevelMap:
        override.thinkingLevelMap || caps.thinkingLevelMap
          ? { ...caps.thinkingLevelMap, ...override.thinkingLevelMap }
          : undefined,
      input: ["text", "image"] as ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      // This gateway is a standard OpenAI-compatible LiteLLM proxy. We only
      // set the flag it genuinely governs (reasoning_effort transport), and
      // only from a confirmed gateway fact; we never invent a backend-specific
      // thinkingFormat we have not verified. Omitting it on silence is
      // deliberate: pi then applies its own default for this endpoint, so the
      // level selected in /thinking actually reaches the gateway.
      ...(caps.supportsReasoningEffort === undefined
        ? {}
        : { compat: { supportsReasoningEffort: caps.supportsReasoningEffort } }),
    };
  });

  pi.registerProvider("ollama-mke", {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    api: config.api as any,
    models: registered,
  });

  console.log(
    `[ollama-mke-sync] Registered ${models.length} model(s); ` +
      `${fromProvider} context window(s) from gateway metadata, ${fromHeuristic} from heuristic fallback; ` +
      `${reasoningFromGateway} model(s) with gateway-confirmed reasoning.`
  );
  if (unresolved.length > 0) {
    console.warn(
      `[ollama-mke-sync] No token limits advertised for: ${unresolved.join(", ")}. ` +
        `Using heuristic defaults — set providers["ollama-mke"].modelOverrides in models.json to correct them.`
    );
  }
  if (unresolvedMaxTokens.length > 0) {
    console.warn(
      `[ollama-mke-sync] No max output tokens advertised for: ${unresolvedMaxTokens.join(", ")}. ` +
        `Using the heuristic default — set providers["ollama-mke"].modelOverrides in models.json ` +
        `(maxTokens) to correct them.`
    );
  }

  reconcileEnabledModels();
}

// ---------------------------------------------------------------------------
// enabledModels reconciliation
// ---------------------------------------------------------------------------

/**
 * Keep settings.json's `enabledModels` from silently hiding newly-synced
 * gateway models from /model and Ctrl+P cycling. A closed, stale list there
 * is invisible to the user — the provider registration above is correct,
 * but Pi still filters the picker against the old list. Ownership-aware
 * (see enabled-models-ownership.ts): this only ever auto-rewrites a value
 * this plugin itself wrote before; a hand-curated or pre-existing list is
 * left untouched and only warned about once per process.
 */
function reconcileEnabledModels(): void {
  try {
    const current = readCurrentEnabledModels();
    if (alreadyGrantsAllOllamaMkeModels(current)) return;

    const sidecar = loadEnabledModelsOwnership();
    const status = computeEnabledModelsStatus(sidecar, current);

    if (status === "custom") {
      console.warn(
        `[ollama-mke-sync] settings.json enabledModels is a closed list that does not include "ollama-mke/*" ` +
          `and was not written by this plugin — leaving it as-is. New gateway models will stay hidden from ` +
          `/model and Ctrl+P until you add them. To always see every ollama-mke model, add "ollama-mke/*" to ` +
          `enabledModels in ~/.pi/agent/settings.json.`
      );
      return;
    }

    // status is "unset" (nothing to reconcile — already means "see everything";
    // guaranteed unreachable here because alreadyGrantsAllOllamaMkeModels()
    // already returned true for it above) or "managed" (safe to rewrite).
    const { backupPath, written } = writeManagedEnabledModels();
    saveEnabledModelsOwnership(recordManagedEnabledModels(sidecar, written));
    console.log(
      `[ollama-mke-sync] Reconciled settings.json enabledModels to ["ollama-mke/*"] so new gateway models ` +
        `stay visible in /model and Ctrl+P.${backupPath ? ` Backup: ${backupPath}` : ""}`
    );
  } catch (err) {
    // Never block model sync or session_start over enabledModels housekeeping.
    console.warn(
      `[ollama-mke-sync] Could not reconcile settings.json enabledModels: ${err instanceof Error ? err.message : err}`
    );
  }
}

// ---------------------------------------------------------------------------
// Extension entry point (async factory — pi awaits before session_start)
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  await syncModels(pi);

  // Re-sync on /reload so the selector stays fresh without restarting pi
  pi.on("session_start", async (event) => {
    if (event.reason === "reload") {
      await syncModels(pi);
    }
  });
}
