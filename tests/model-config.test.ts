/**
 * Tests for extensions/model-config.ts (the /roles TUI).
 * Run: bun test tests/model-config.test.ts
 *
 * Fully self-contained: pure-logic tests use synthetic fixtures in tmp, and
 * the e2e block mocks node:os so homedir() points at an isolated fixture.
 * The real ~/.pi/agent/subagents.json is never written; its hash is asserted
 * unchanged around the run.
 */
import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL_HOME = homedir(); // captured before the node:os mock is installed
const realSubagentsPath = join(REAL_HOME, ".pi/agent/subagents.json");
// Optional: on machines without a pi setup the real file may not exist — the
// suite must still load and run everywhere (no unconditional top-level read).
const realExistedBefore = existsSync(realSubagentsPath);
const realHashBefore = realExistedBefore
  ? createHash("sha256").update(readFileSync(realSubagentsPath)).digest("hex")
  : null;

// The extension must be imported ONLY after node:os is mocked: a static
// import would bind the real homedir() before the mock exists, making the
// e2e isolation order-dependent (R3-e2e-mock-timing).
const FAKE_HOME = join("/tmp", `mke-test-${process.pid}`);
mock.module("node:os", () => ({ homedir: () => FAKE_HOME, default: { homedir: () => FAKE_HOME } }));
const ext: any = await import("../extensions/model-config.ts");
const mod: any = await import("../extensions/role-ownership.ts");

/** Fixture cwd with project-level agent definitions (.pi/agents/*.md). */
function fixtureAgentsDir(agents: Array<[string, string]>): string {
  const cwd = mkdtempSync(join("/tmp", "mke-roles-"));
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of agents) writeFileSync(join(dir, `${name}.md`), body);
  return cwd;
}

describe("pure logic", () => {
  test("frontmatter: scalars parsed, lists ignored", () => {
    const s = ext.parseFrontmatterScalars('---\nname: sdd-apply\ndescription: "Quoted: yes"\ntools:\n  - read\n---\nbody');
    expect(s.name).toBe("sdd-apply");
    expect(s.description).toBe("Quoted: yes");
    expect(s.tools).toBeUndefined();
  });

  test("discovery: project .md agents are found and override globals", () => {
    const cwd = fixtureAgentsDir([
      ["review-risk", "---\nname: review-risk\ndescription: Deep review agent\nmodel: ollama-mke/model-a\nthinking: high\n---\nbody"],
      ["solo", "---\nname: solo\n---\nbody"],
    ]);
    const agents = ext.discoverAgentDefinitions(cwd);
    // Fixture agents win over any same-named global ones (project beats global).
    expect(agents.get("review-risk")?.model).toBe("ollama-mke/model-a");
    expect(agents.get("review-risk")?.thinking).toBe("high");
    expect(agents.get("review-risk")?.description).toBe("Deep review agent");
    expect(agents.has("solo")).toBe(true);
  });

  test("resolution: profile beats definition beats default", () => {
    const cwd = fixtureAgentsDir([
      ["defined", "---\nname: defined\nmodel: ollama-mke/from-md\nthinking: low\n---\nbody"],
        ["md-only", "---\nname: md-only\nmodel: ollama-mke/only-md\nthinking: medium\n---\nbody"],
      ["plain", "---\nname: plain\n---\nbody"],
    ]);
    const config: any = {
      default_model: "ollama-mke/fallback",
      default_effort: "minimal",
      model_profiles: {
        defined: { model: "ollama-mke/from-profile", effort: "xhigh" },
        "profile-only": { effort: "medium" },
      },
    };
    const byName = new Map(ext.resolveRoles(config, cwd).map((r) => [r.name, r]));
    expect(byName.get("defined")).toEqual({ name: "defined", model: "ollama-mke/from-profile", effort: "xhigh", source: "profile" });
    expect(byName.get("md-only")).toEqual({ name: "md-only", model: "ollama-mke/only-md", effort: "medium", source: "definition" });
    expect(byName.get("plain")).toEqual({ name: "plain", model: "ollama-mke/fallback", effort: "minimal", source: "default" });
    expect(byName.get("profile-only")?.source).toBe("profile");
    // Partial profiles inherit the missing field per field (default_model here).
    expect(byName.get("profile-only")?.model).toBe("ollama-mke/fallback");
    expect(byName.get("profile-only")?.effort).toBe("medium");
  });

  test("classification and clamping", () => {
    expect(ext.classifyRole("sdd-proposal")).toBe("deep");
    expect(ext.classifyRole("sdd-archive")).toBe("light");
    expect(ext.classifyRole("gentle-ai-worker")).toBe("standard");

    // No confirmed reasoning -> ANY non-off effort clamps all the way to
    // "off", never to a fabricated "high"/"minimal" a non-reasoning model
    // would ignore.
    const nonReasoning = { id: "y", reasoning: false, supportsXhigh: false, supportsLow: false, supportsMinimal: true, supportsNone: true };
    expect(ext.clampEffort("xhigh", nonReasoning)).toBe("off");
    expect(ext.clampEffort("low", nonReasoning)).toBe("off");

    // Reasoning-capable, xhigh explicitly denied -> steps down to the
    // nearest level the gateway does NOT explicitly deny (high, unknown).
    const xhighDenied = { id: "z", reasoning: true, supportsXhigh: false };
    expect(ext.clampEffort("xhigh", xhighDenied)).toBe("high");

    // Reasoning-capable, low explicitly denied but minimal unknown -> steps
    // down to minimal (first non-false candidate below "low").
    const lowDenied = { id: "w", reasoning: true, supportsLow: false };
    expect(ext.clampEffort("low", lowDenied)).toBe("minimal");

    // Every level down to off explicitly denied -> "off" is the floor.
    const allDenied = {
      id: "v", reasoning: true,
      supportsXhigh: false, supportsHigh: false, supportsMedium: false,
      supportsLow: false, supportsMinimal: false, supportsNone: false,
    };
    expect(ext.clampEffort("high", allDenied)).toBe("off");

    // Unknown (undefined) support for the requested level is neutral, not a
    // denial -- the request passes through unchanged.
    const allUnknown = { id: "u", reasoning: true };
    expect(ext.clampEffort("medium", allUnknown)).toBe("medium");
    expect(ext.clampEffort("xhigh", allUnknown)).toBe("xhigh");

    expect(ext.clampEffort("high", undefined)).toBe("high");
  });

  test("providerQualifiedModelId: slash-containing gateway ids are not mistaken for already-qualified ids", () => {
    const { providerKey } = ext.resolveGatewayConfig();

    // A raw gateway id containing '/' that is NOT already provider-qualified
    // must still get the provider prefix -- this was the bug: the previous
    // implementation returned such ids unchanged, silently misrouting them.
    expect(ext.providerQualifiedModelId("bedrock/claude-sonnet-4.6")).toBe(`${providerKey}/bedrock/claude-sonnet-4.6`);

    // An id already prefixed with the configured provider key is left as-is
    // (no double-prefixing).
    expect(ext.providerQualifiedModelId(`${providerKey}/plain-model`)).toBe(`${providerKey}/plain-model`);

    // A plain id with no slash gets prefixed normally.
    expect(ext.providerQualifiedModelId("plain-model")).toBe(`${providerKey}/plain-model`);
  });

  test("stripProviderPrefix: only removes the leading provider segment, not slashes inside the gateway id", () => {
    const { providerKey } = ext.resolveGatewayConfig();
    expect(ext.stripProviderPrefix(`${providerKey}/bedrock/claude-sonnet-4.6`)).toBe("bedrock/claude-sonnet-4.6");
    expect(ext.stripProviderPrefix("bedrock/claude-sonnet-4.6")).toBe("bedrock/claude-sonnet-4.6");
    expect(ext.stripProviderPrefix(undefined)).toBeUndefined();
  });

  test("supportFlag: tri-state passthrough per level", () => {
    const model = { id: "m", reasoning: true, supportsNone: true, supportsMinimal: false, supportsLow: undefined, supportsMedium: true, supportsHigh: false, supportsXhigh: undefined };
    expect(ext.supportFlag(model, "off")).toBe(true);
    expect(ext.supportFlag(model, "minimal")).toBe(false);
    expect(ext.supportFlag(model, "low")).toBeUndefined();
    expect(ext.supportFlag(model, "medium")).toBe(true);
    expect(ext.supportFlag(model, "high")).toBe(false);
    expect(ext.supportFlag(model, "xhigh")).toBeUndefined();
  });

  test("pickModelByCost: still usable as a standalone cost-percentile helper (no longer used by buildPresetPlan)", () => {
    // Ids deliberately do NOT end in a bare numeric segment ("model-a", not
    // "model-0") so they are not mistaken for versioned siblings of one
    // family by collapseToLatestPerFamily -- that behavior gets its own
    // dedicated test below.
    const letters = "abcdefghij";
    const catalog = Array.from({ length: 10 }, (_, i) => ({
      id: `model-${letters[i]}`, reasoning: i >= 5, inputCostPerToken: (i + 1) / 1e6,
      supportsXhigh: i % 2 === 0, supportsLow: true, supportsMinimal: true, supportsNone: true,
    }));
    expect(ext.pickModelByCost(catalog, 0, false)?.id).toBe("model-a");
    expect(ext.pickModelByCost(catalog, 1, false)?.id).toBe("model-j");
    expect(ext.pickModelByCost(catalog, 0.15, true)?.id).toBe("model-g");
    expect(ext.pickModelByCost(catalog.filter((m) => !m.reasoning), 0.5, true)).toBeUndefined();
  });

  /**
   * Full 8-id fixed-tier catalog mirroring MODEL_TIERS exactly, so
   * buildPresetPlan tests exercise the real tier table without depending on
   * a live gateway. Every id is reasoning-capable and confirms medium/high/
   * xhigh so clampEffort never silently degrades these fixtures.
   */
  function fixedTierCatalog(): any[] {
    const ids = [
      "claude-haiku-4-5", "codex-gpt56-luna",
      "claude-sonnet-5", "codex-gpt56-terra",
      "claude-opus-5", "codex-gpt56-sol",
      "claude-fable-5-1", "codex-gpt6-astra",
    ];
    return ids.map((id) => ({
      id, reasoning: true, inputCostPerToken: 1e-6,
      supportsMedium: true, supportsHigh: true, supportsXhigh: true,
    }));
  }

  test("buildPresetPlan: fixed tiers -- Claude side for deep roles, Codex side for standard/light", () => {
    const catalog = fixedTierCatalog();
    const roles = [{ name: "sdd-proposal" }, { name: "gentle-ai-worker" }, { name: "sdd-archive" }] as any;

    const cheap = ext.buildPresetPlan("cheap", catalog, roles) as any[];
    expect(cheap.find((p) => p.role === "sdd-proposal")?.model).toBe("claude-haiku-4-5");
    expect(cheap.find((p) => p.role === "gentle-ai-worker")?.model).toBe("codex-gpt56-luna");
    expect(cheap.find((p) => p.role === "sdd-archive")?.model).toBe("codex-gpt56-luna");

    const balanced = ext.buildPresetPlan("balanced", catalog, roles) as any[];
    expect(balanced.find((p) => p.role === "sdd-proposal")?.model).toBe("claude-opus-5");
    expect(balanced.find((p) => p.role === "gentle-ai-worker")?.model).toBe("codex-gpt56-terra");
    expect(balanced.find((p) => p.role === "sdd-archive")?.model).toBe("codex-gpt56-luna");

    const quality = ext.buildPresetPlan("quality", catalog, roles) as any[];
    expect(quality.find((p) => p.role === "sdd-proposal")?.model).toBe("claude-fable-5-1");
    expect(quality.find((p) => p.role === "gentle-ai-worker")?.model).toBe("codex-gpt56-sol");
    expect(quality.find((p) => p.role === "sdd-archive")?.model).toBe("codex-gpt56-terra");
  });

  test("buildPresetPlan: an outdated same-family sibling in the catalog never displaces its tier's exact fixed id", () => {
    // Even with a stale "claude-opus-4-6" sitting in the catalog (cheaper, so
    // it would have won a percentile scan), buildPresetPlan must still
    // resolve the exact tier id ("claude-opus-5"), not the stale sibling.
    const catalog = [
      ...fixedTierCatalog(),
      { id: "claude-opus-4-6", reasoning: true, inputCostPerToken: 1e-7 },
    ];
    const roles = [{ name: "sdd-proposal" }] as any;
    const balanced = ext.buildPresetPlan("balanced", catalog, roles) as any[];
    expect(balanced[0].model).toBe("claude-opus-5");
  });

  test("parseVersionedFamily: only purely-numeric trailing hyphen segments count as a version", () => {
    expect(ext.parseVersionedFamily("claude-opus-4-6")).toEqual({ family: "claude-opus", version: [4, 6] });
    expect(ext.parseVersionedFamily("claude-sonnet-5")).toEqual({ family: "claude-sonnet", version: [5] });
    // Tier/size names that happen to end in digits are NOT version suffixes:
    // each keeps its own full id as a one-member family.
    expect(ext.parseVersionedFamily("codex-gpt56-terra")).toEqual({ family: "codex-gpt56-terra", version: [] });
    expect(ext.parseVersionedFamily("nemotron-3-ultra")).toEqual({ family: "nemotron-3-ultra", version: [] });
    expect(ext.parseVersionedFamily("deepseek-v4-pro")).toEqual({ family: "deepseek-v4-pro", version: [] });
    // No trailing hyphen segment at all -> its own one-member family.
    expect(ext.parseVersionedFamily("gemma4")).toEqual({ family: "gemma4", version: [] });
  });

  test("compareVersions: lexicographic-by-component, shorter treated as zero-padded", () => {
    expect(ext.compareVersions([4, 6], [4, 7])).toBeLessThan(0);
    expect(ext.compareVersions([4, 8], [5])).toBeLessThan(0);
    expect(ext.compareVersions([5], [5])).toBe(0);
    expect(ext.compareVersions([5, 1], [5])).toBeGreaterThan(0);
  });

  test("collapseToLatestPerFamily: keeps only the newest sibling within a real gateway catalog's versioned families", () => {
    // Fixture mirrors the actual shape of the gateway's opus/sonnet lineup:
    // several priced opus siblings (older ones costing the same or more than
    // the newest), plus a sonnet family where the OLDER one costs MORE than
    // the newer one -- exactly the case that broke pure cost-percentile
    // picking (it would have ranked the stale sonnet-4-6 above sonnet-5).
    const catalog = [
      { id: "claude-opus-4-6", reasoning: true, inputCostPerToken: 5e-6 },
      { id: "claude-opus-4-7", reasoning: true, inputCostPerToken: 5e-6 },
      { id: "claude-opus-4-8", reasoning: true, inputCostPerToken: 5e-6 },
      { id: "claude-opus-5", reasoning: true, inputCostPerToken: 5e-6 },
      { id: "claude-sonnet-4-6", reasoning: true, inputCostPerToken: 3e-6 },
      { id: "claude-sonnet-5", reasoning: true, inputCostPerToken: 2e-6 },
      { id: "codex-gpt56-terra", reasoning: true, inputCostPerToken: 2e-6 },
    ] as any;
    const collapsed = ext.collapseToLatestPerFamily(catalog);
    const ids = collapsed.map((m: any) => m.id).sort();
    // Every claude-opus-4-* sibling is gone; only the newest (5) remains.
    expect(ids).not.toContain("claude-opus-4-6");
    expect(ids).not.toContain("claude-opus-4-7");
    expect(ids).not.toContain("claude-opus-4-8");
    expect(ids).toContain("claude-opus-5");
    // The stale, more expensive sonnet-4-6 is gone; only sonnet-5 remains,
    // even though it is cheaper (version wins over cost when collapsing).
    expect(ids).not.toContain("claude-sonnet-4-6");
    expect(ids).toContain("claude-sonnet-5");
    // A non-versioned id (tier name ending in digits) is untouched.
    expect(ids).toContain("codex-gpt56-terra");
    expect(ids.length).toBe(3);
  });

  test("pickModelByCost never selects a stale same-family sibling over its newer version", () => {
    // claude-opus-4-6 is cheaper than claude-opus-5 here, so pure
    // cost-percentile picking without family collapsing would pick the
    // stale one first. With collapsing, only opus-5 is ever a candidate.
    const catalog = [
      { id: "claude-opus-4-6", reasoning: true, inputCostPerToken: 1e-6 },
      { id: "claude-opus-5", reasoning: true, inputCostPerToken: 5e-6 },
    ] as any;
    expect(ext.pickModelByCost(catalog, 0, true)?.id).toBe("claude-opus-5");
    expect(ext.pickModelByCost(catalog, 1, true)?.id).toBe("claude-opus-5");
  });

  test("pickModelByCost treats a gateway-confirmed zero price as a real (cheapest) price, not as missing", () => {
    const catalog = [
      { id: "free-local-model", reasoning: false, inputCostPerToken: 0 },
      { id: "paid-model", reasoning: false, inputCostPerToken: 5e-6 },
    ] as any;
    expect(ext.pickModelByCost(catalog, 0, false)?.id).toBe("free-local-model");
    // A model with no price fact at all (undefined) must still be excluded.
    const withUnknown = [...catalog, { id: "unknown-price", reasoning: false, inputCostPerToken: undefined }] as any;
    expect(ext.pickModelByCost(withUnknown, 0, false)?.id).toBe("free-local-model");
  });

  test("buildPresetPlan: a tier id missing from the current gateway catalog -> error string, never a silent substitute", () => {
    // Catalog has 7 of the 8 fixed-tier ids but is missing balanced/deep's
    // "claude-opus-5" -- buildPresetPlan must refuse rather than pick a
    // nearby stand-in on its own.
    const catalog = fixedTierCatalog().filter((m) => m.id !== "claude-opus-5");
    const roles = [{ name: "sdd-proposal" }] as any;
    const result = ext.buildPresetPlan("balanced", catalog, roles);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("claude-opus-5");
  });

  test("buildPresetPlan: a tier id present but not gateway-confirmed reasoning-capable refuses a deep role rather than silently dropping reasoning", () => {
    const catalog = fixedTierCatalog().map((m) =>
      m.id === "claude-fable-5-1" ? { ...m, reasoning: false } : m
    );
    const roles = [{ name: "sdd-proposal" }] as any; // deep -> quality tier t4 -> claude-fable-5-1
    const result = ext.buildPresetPlan("quality", catalog, roles);
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/reasoning-capable/i);
  });
});

// ---------------------------------------------------------------------------
// E2E: real handler against a mock pi API and an isolated HOME
// ---------------------------------------------------------------------------
describe("e2e /roles", () => {
  beforeAll(() => {
    rmSync(FAKE_HOME, { recursive: true, force: true });
    mkdirSync(join(FAKE_HOME, ".pi/agent"), { recursive: true });
    writeFileSync(join(FAKE_HOME, ".pi/agent/subagents.json"), JSON.stringify({
      default_effort: "low", stall_timeout_ms: 999999,
      model_profiles: { "sdd-apply": { model: "ollama-mke/terra", effort: "medium" } },
    }, null, 2) + "\n");
    // Dead gateway: catalog stays empty; effort/default edits must still work.
    writeFileSync(join(FAKE_HOME, ".pi/agent/models.json"), JSON.stringify({ providers: { "ollama-mke": { baseUrl: "http://127.0.0.1:1", apiKey: "k" } } }));
  });

  test("edits write fixture config, preserve unknown keys, create backups", async () => {
    let handler: undefined | ((args: string, ctx: any) => Promise<void>);
    ext.default({
      registerCommand: (_n: string, def: any) => { handler = def.handler; },
    } as any);
    expect(typeof handler).toBe("function");

    const script: Array<{ match: RegExp; answer: string | RegExp }> = [
      { match: /Model Config/, answer: "View / edit roles" },
      { match: /Roles \(model/, answer: /^sdd-apply/ },
      { match: /Edit sdd-apply/, answer: "Change effort" },
      { match: /Effort \(current: medium\)/, answer: "high" },
      { match: /Model Config/, answer: "Defaults (default_model / default_effort)" },
      { match: /Defaults — model:/, answer: "Change default_effort" },
      { match: /Effort \(current: low\)/, answer: "xhigh" },
      { match: /Model Config/, answer: "Exit" },
    ];
    let step = 0;
    const confirms: string[] = [];
    const notices: Array<{ m: string; l: string }> = [];
    const ui = {
      async select(title: string, options: string[]) {
        const rule = script[step++];
        expect(rule).toBeDefined();
        expect(rule.match.test(title)).toBe(true);
        const a = rule.answer;
        if (a instanceof RegExp) {
          const found = options.find((o) => a.test(o));
          expect(found).toBeDefined();
          return found as string;
        }
        return a;
      },
      async confirm(title: string) { confirms.push(title); return true; },
      notify(m: string, l: string) { notices.push({ m, l }); },
    };
    await handler!("", { ui });
    expect(step).toBe(script.length);
    expect(confirms.length).toBe(2);
    expect(notices.filter((n) => n.l === "info").length).toBe(2);

    const written = JSON.parse(readFileSync(join(FAKE_HOME, ".pi/agent/subagents.json"), "utf-8"));
    expect(written.model_profiles["sdd-apply"].effort).toBe("high");
    expect(written.default_effort).toBe("xhigh");
    expect(written.stall_timeout_ms).toBe(999999); // unknown key preserved
    const backups = readdirSync(join(FAKE_HOME, ".pi/agent")).filter((f) => f.startsWith("subagents.json.bak-"));
    expect(backups.length).toBe(2);
    // The real user file must be unchanged: byte-identical if it existed,
    // still absent if it did not (the suite never creates the user's config).
    if (realHashBefore === null) expect(existsSync(realSubagentsPath)).toBe(false);
    else expect(createHash("sha256").update(readFileSync(realSubagentsPath)).digest("hex")).toBe(realHashBefore);
  });
});

// ---------------------------------------------------------------------------
// E2E: ownership sidecar integration (phase 2)
// ---------------------------------------------------------------------------
describe("e2e /roles ownership integration", () => {
  const realOwnershipPath = join(REAL_HOME, ".pi/agent/gentle-ai/role-profiles.json");
  const realOwnershipExisted = existsSync(realOwnershipPath);
  const realOwnershipHashBefore = realOwnershipExisted
    ? createHash("sha256").update(readFileSync(realOwnershipPath)).digest("hex")
    : null;

  // Minimal reasoning-capable catalog served in place of a real gateway, so
  // "Apply preset" can be exercised end-to-end without network access.
  // Includes every fixed-tier id buildPresetPlan needs to resolve any
  // preset/role-class combination used below, so "Apply preset" can run
  // end-to-end against the real tier table without a live gateway.
  const modelInfoPayload = {
    data: [
      { model_name: "claude-haiku-4-5", model_info: { supports_reasoning: true, input_cost_per_token: 1e-6, supports_medium_reasoning_effort: true } },
      { model_name: "codex-gpt56-luna", model_info: { supports_reasoning: true, input_cost_per_token: 1e-6, supports_high_reasoning_effort: true } },
      { model_name: "claude-sonnet-5", model_info: { supports_reasoning: true, input_cost_per_token: 1e-6, supports_high_reasoning_effort: true } },
      { model_name: "codex-gpt56-terra", model_info: { supports_reasoning: true, input_cost_per_token: 1e-6, supports_medium_reasoning_effort: true } },
      { model_name: "claude-opus-5", model_info: { supports_reasoning: true, input_cost_per_token: 1e-6, supports_high_reasoning_effort: true } },
      { model_name: "codex-gpt56-sol", model_info: { supports_reasoning: true, input_cost_per_token: 1e-6, supports_high_reasoning_effort: true } },
      { model_name: "claude-fable-5-1", model_info: { supports_reasoning: true, input_cost_per_token: 1e-6, supports_xhigh_reasoning_effort: true } },
      { model_name: "codex-gpt6-astra", model_info: { supports_reasoning: true, input_cost_per_token: 1e-6, supports_xhigh_reasoning_effort: true } },
      // Kept alongside the tier ids for tests that pre-seed a hand-picked
      // profile with a synthetic id outside the fixed tiers (custom-profile
      // paths never need to resolve against the catalog).
      { model_name: "deep-model", model_info: { supports_reasoning: true, input_cost_per_token: 2e-6, supports_xhigh_reasoning_effort: true } },
      { model_name: "cheap-model", model_info: { supports_reasoning: false, input_cost_per_token: 1e-7 } },
    ],
  };
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    // @ts-expect-error test-only stub, narrower than the real fetch signature
    globalThis.fetch = async (url: string) => {
      if (String(url).includes("/model/info")) {
        return new Response(JSON.stringify(modelInfoPayload), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  function resetFixture(config: any) {
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
    mkdirSync(join(FAKE_HOME, ".pi/agent"), { recursive: true });
    writeFileSync(join(FAKE_HOME, ".pi/agent/subagents.json"), `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(
      join(FAKE_HOME, ".pi/agent/models.json"),
      JSON.stringify({ providers: { "ollama-mke": { baseUrl: "http://gateway.invalid", apiKey: "k" } } })
    );
  }

  async function runHandler(script: Array<{ match: RegExp; answer: string | RegExp }>) {
    let handler: undefined | ((args: string, ctx: any) => Promise<void>);
    ext.default({ registerCommand: (_n: string, def: any) => { handler = def.handler; } } as any);
    let step = 0;
    const notices: Array<{ m: string; l: string }> = [];
    const ui = {
      async select(title: string, options: string[]) {
        const rule = script[step++];
        expect(rule).toBeDefined();
        expect(rule.match.test(title)).toBe(true);
        const a = rule.answer;
        if (a instanceof RegExp) {
          const found = options.find((o) => a.test(o));
          expect(found).toBeDefined();
          return found as string;
        }
        return a;
      },
      async confirm() { return true; },
      notify(m: string, l: string) { notices.push({ m, l }); },
    };
    await handler!("", { ui });
    expect(step).toBe(script.length);
    return notices;
  }

  test("a manual model/effort edit disowns the role, so a later preset never overwrites it silently", async () => {
    resetFixture({
      default_effort: "low",
      model_profiles: { "sdd-apply": { model: "ollama-mke/deep-model", effort: "medium" } },
    });
    // Pre-seed ownership as if a prior preset had written this exact profile.
    const ownership = mod.recordManagedProfile(
      mod.loadRoleOwnership(),
      "sdd-apply",
      { model: "ollama-mke/deep-model", effort: "medium" }
    );
    mod.saveRoleOwnership(ownership);
    expect(
      mod.computeOwnershipStatus(mod.loadRoleOwnership(), "sdd-apply", { model: "ollama-mke/deep-model", effort: "medium" })
    ).toBe("managed");

    await runHandler([
      { match: /Model Config/, answer: "View / edit roles" },
      { match: /Roles \(model/, answer: /^sdd-apply/ },
      { match: /Edit sdd-apply/, answer: "Change effort" },
      { match: /Effort \(current: medium\)/, answer: "high" },
      { match: /Model Config/, answer: "Exit" },
    ]);

    const written = JSON.parse(readFileSync(join(FAKE_HOME, ".pi/agent/subagents.json"), "utf-8"));
    expect(written.model_profiles["sdd-apply"].effort).toBe("high");

    const finalOwnership = mod.loadRoleOwnership();
    expect(
      mod.computeOwnershipStatus(finalOwnership, "sdd-apply", written.model_profiles["sdd-apply"])
    ).toBe("custom");
  });

  test("Apply preset skips a custom profile and reports it, but still applies to an inherited role", async () => {
    resetFixture({
      // sdd-apply has a hand-set profile the preset never wrote -> custom.
      model_profiles: { "sdd-apply": { model: "ollama-mke/cheap-model", effort: "off" } },
    });

    const notices = await runHandler([
      { match: /Model Config/, answer: "Apply preset (cheap / balanced / quality)" },
      { match: /Preset:/, answer: "balanced" },
      { match: /Model Config/, answer: "Exit" },
    ]);

    const written = JSON.parse(readFileSync(join(FAKE_HOME, ".pi/agent/subagents.json"), "utf-8"));
    // The custom profile must survive the preset run untouched.
    expect(written.model_profiles["sdd-apply"]).toEqual({ model: "ollama-mke/cheap-model", effort: "off" });

    const skipNotice = notices.find((n) => /skipped/i.test(n.m));
    expect(skipNotice).toBeDefined();
    expect(skipNotice!.m).toMatch(/sdd-apply \(custom\)/);
  });

  test("Apply preset records ownership for roles it writes, and a second run treats them as still managed", async () => {
    resetFixture({ model_profiles: { "sdd-apply": {} } });

    await runHandler([
      { match: /Model Config/, answer: "Apply preset (cheap / balanced / quality)" },
      { match: /Preset:/, answer: "balanced" },
      { match: /Model Config/, answer: "Exit" },
    ]);

    const written = JSON.parse(readFileSync(join(FAKE_HOME, ".pi/agent/subagents.json"), "utf-8"));
    expect(written.model_profiles["sdd-apply"]).toBeDefined();

    const ownership = mod.loadRoleOwnership();
    expect(
      mod.computeOwnershipStatus(ownership, "sdd-apply", written.model_profiles["sdd-apply"])
    ).toBe("managed");
  });

  test("the real user ownership sidecar is never touched by this suite", () => {
    if (realOwnershipHashBefore === null) expect(existsSync(realOwnershipPath)).toBe(false);
    else expect(createHash("sha256").update(readFileSync(realOwnershipPath)).digest("hex")).toBe(realOwnershipHashBefore);
  });
});
