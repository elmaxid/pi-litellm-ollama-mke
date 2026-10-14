/**
 * Tests for extensions/litellm-sync.ts (the gateway → Pi model registration).
 * Run: bun test tests/litellm-sync.test.ts
 *
 * Self-contained: `node:os` is mocked so homedir() points at an isolated
 * fixture (the real ~/.pi/agent/{settings,models}.json is never read or
 * written), and the gateway is a stubbed `fetch` — no network.
 *
 * The two behaviours pinned here are the ones that silently degraded model
 * metadata on real gateways:
 *   - a gateway that stays silent about effort levels must NOT disable Pi's
 *     reasoning_effort transport (that made /thinking offer levels that were
 *     never sent);
 *   - an invented maxTokens fallback must be reported, like the context-window
 *     fallback already was.
 */
import { describe, test, expect, mock } from "bun:test";
import { join } from "node:path";

// The extension must be imported only after node:os is mocked, so a static
// import cannot bind the real homedir() first (same rule as model-config.test.ts).
const FAKE_HOME = join("/tmp", `mke-sync-test-${process.pid}`);
mock.module("node:os", () => ({ homedir: () => FAKE_HOME, default: { homedir: () => FAKE_HOME } }));

interface Fixture {
  /** GET /v1/models entries: { id, max_input_tokens?, max_output_tokens? } */
  models: Array<Record<string, unknown>>;
  /** GET /model/info entries: { model_name, model_info } */
  info?: Array<{ model_name: string; model_info: Record<string, unknown> }>;
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

function stubGateway(fixture: Fixture): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/model/info")) return jsonResponse({ data: fixture.info ?? [] });
    return jsonResponse({ data: fixture.models, object: "list" });
  }) as typeof fetch;
}

/** Run one sync against a stubbed gateway and return what the plugin registered. */
async function registeredModels(fixture: Fixture): Promise<any[]> {
  stubGateway(fixture);
  process.env.OLLAMA_MKE_BASE_URL = "http://gateway.test:4000";
  process.env.OLLAMA_MKE_API_KEY = "sk-test";
  const ext = (await import("../extensions/litellm-sync.ts")).default;
  let registered: any[] = [];
  const pi: any = {
    registerProvider: (_id: string, config: any) => {
      registered = config.models;
    },
    on: () => {},
  };
  await ext(pi);
  return registered;
}

const byId = (models: any[], id: string) => models.find((m) => m.id === id);

/** Collect console.warn lines while running `fn`. */
async function warningsOf(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

describe("litellm-sync: reasoning_effort transport", () => {
  test("a silent gateway leaves the transport to Pi instead of disabling it", async () => {
    const models = await registeredModels({
      models: [{ id: "qwen3.8-flash-nan", max_input_tokens: 1048576 }],
      info: [
        {
          model_name: "qwen3.8-flash-nan",
          // The gateway confirms reasoning but says nothing about any level.
          model_info: {
            max_input_tokens: 1048576,
            supports_reasoning: true,
            supports_low_reasoning_effort: null,
            supports_medium_reasoning_effort: null,
            supports_high_reasoning_effort: null,
          },
        },
      ],
    });

    const model = byId(models, "qwen3.8-flash-nan");
    expect(model.reasoning).toBe(true);
    // Omitted, not false: Pi's own auto-detected default (true for this
    // OpenAI-compatible endpoint) is what makes the chosen level reach the
    // gateway. `false` here means "/thinking shows levels that are never sent".
    expect(model.compat?.supportsReasoningEffort).toBeUndefined();
  });

  test("a gateway-confirmed effort level still enables the transport", async () => {
    const models = await registeredModels({
      models: [{ id: "codex-gpt5" }],
      info: [
        {
          model_name: "codex-gpt5",
          model_info: {
            supports_reasoning: true,
            supports_low_reasoning_effort: true,
            supports_minimal_reasoning_effort: false,
          },
        },
      ],
    });

    const model = byId(models, "codex-gpt5");
    expect(model.compat?.supportsReasoningEffort).toBe(true);
    // An explicitly denied level stays hidden from /thinking.
    expect(model.thinkingLevelMap.minimal).toBeNull();
    expect(model.thinkingLevelMap.low).toBe("low");
  });
  test("an explicitly denied xhigh is not re-promised just because max is silent", async () => {
    const models = await registeredModels({
      models: [{ id: "denied-xhigh" }],
      info: [
        {
          model_name: "denied-xhigh",
          // xhigh explicitly denied, max never mentioned: silence must not
          // resurrect the level the gateway just denied.
          model_info: { supports_reasoning: true, supports_xhigh_reasoning_effort: false },
        },
      ],
    });

    expect(byId(models, "denied-xhigh").thinkingLevelMap.xhigh).toBeNull();
  });
  test("a denied max alias is not re-promised when xhigh is silent", async () => {
    const models = await registeredModels({
      models: [{ id: "denied-max" }],
      info: [
        {
          model_name: "denied-max",
          model_info: { supports_reasoning: true, supports_max_reasoning_effort: false },
        },
      ],
    });

    expect(byId(models, "denied-max").thinkingLevelMap.xhigh).toBeNull();
  });

  test("heuristic-only reasoning still leaves the transport to Pi", async () => {
    // No /model/info entry at all: reasoning comes from the model id alone, so
    // there is no factual basis for a level map and none is produced. The
    // transport itself must still not be switched off.
    const models = await registeredModels({
      models: [{ id: "qwen3.5", max_input_tokens: 262144 }],
      info: [],
    });

    const model = byId(models, "qwen3.5");
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap).toBeUndefined();
    expect(model.compat).toBeUndefined();
  });
});

describe("litellm-sync: token-limit fallbacks are reported", () => {
  test("an invented maxTokens is warned about by model id", async () => {
    let models: any[] = [];
    const warnings = await warningsOf(async () => {
      models = await registeredModels({
        models: [{ id: "gemma4-nan", max_input_tokens: 262144 }],
        info: [{ model_name: "gemma4-nan", model_info: { max_input_tokens: 262144 } }],
      });
    });

    expect(byId(models, "gemma4-nan").maxTokens).toBe(16384);
    const maxTokensWarning = warnings.find((line) => line.includes("max output tokens"));
    expect(maxTokensWarning).toBeDefined();
    expect(maxTokensWarning).toContain("gemma4-nan");
  });

  test("a gateway-advertised maxOutputTokens is used without a warning", async () => {
    let models: any[] = [];
    const warnings = await warningsOf(async () => {
      models = await registeredModels({
        models: [{ id: "claude-haiku-4-5", max_input_tokens: 200000, max_output_tokens: 64000 }],
        info: [],
      });
    });

    expect(byId(models, "claude-haiku-4-5").maxTokens).toBe(64000);
    expect(warnings.filter((line) => line.includes("max output tokens"))).toHaveLength(0);
  });

  test("a missing context window is still warned about", async () => {
    const warnings = await warningsOf(async () => {
      await registeredModels({
        models: [{ id: "qwen3-embedding-nan" }],
        info: [],
      });
    });

    const contextWarning = warnings.find((line) => line.includes("No token limits advertised for"));
    expect(contextWarning).toContain("qwen3-embedding-nan");
  });
});
