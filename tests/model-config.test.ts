/**
 * Tests for extensions/model-config.ts (the /roles TUI).
 * Run: bun test tests/model-config.test.ts
 *
 * Fully self-contained: pure-logic tests use synthetic fixtures in tmp, and
 * the e2e block mocks node:os so homedir() points at an isolated fixture.
 * The real ~/.pi/agent/subagents.json is never written; its hash is asserted
 * unchanged around the run.
 */
import { describe, test, expect, mock, beforeAll } from "bun:test";
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
    const weak = { id: "y", reasoning: false, supportsXhigh: false, supportsLow: false, supportsMinimal: true, supportsNone: true };
    expect(ext.clampEffort("xhigh", weak)).toBe("high");
    expect(ext.clampEffort("low", weak)).toBe("minimal");
    expect(ext.clampEffort("high", undefined)).toBe("high");
  });

  test("percentile picking and full preset plans", () => {
    const catalog = Array.from({ length: 10 }, (_, i) => ({
      id: `model-${i}`, reasoning: i >= 5, inputCostPerToken: (i + 1) / 1e6,
      supportsXhigh: i % 2 === 0, supportsLow: true, supportsMinimal: true, supportsNone: true,
    }));
    expect(ext.pickModelByCost(catalog, 0, false)?.id).toBe("model-0");
    expect(ext.pickModelByCost(catalog, 1, false)?.id).toBe("model-9");
    expect(ext.pickModelByCost(catalog, 0.15, true)?.id).toBe("model-6");
    expect(ext.pickModelByCost(catalog.filter((m) => !m.reasoning), 0.5, true)).toBeUndefined();
    const roles = [{ name: "sdd-proposal" }, { name: "sdd-archive" }] as any;
    for (const preset of ["cheap", "balanced", "quality"] as const) {
      const plan = ext.buildPresetPlan(preset, catalog, roles) as any[];
      expect(plan.length).toBe(2);
      expect(catalog.find((m) => m.id === plan[0].model)?.reasoning).toBe(true);
    }
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
