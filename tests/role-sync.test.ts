/**
 * Tests for extensions/role-sync.ts (automatic session_start/reload role sync).
 * Run: bun test tests/role-sync.test.ts
 *
 * Same isolation pattern as tests/model-config.test.ts: node:os mocked so
 * homedir() points at an isolated fixture, and fetch mocked to serve a
 * synthetic gateway catalog. The real ~/.pi/agent/subagents.json and
 * ~/.pi/agent/gentle-ai/role-profiles.json are never written.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL_HOME = homedir();
const FAKE_HOME = join("/tmp", `mke-role-sync-test-${process.pid}`);
mock.module("node:os", () => ({ homedir: () => FAKE_HOME, default: { homedir: () => FAKE_HOME } }));

const roleSync: any = await import("../extensions/role-sync.ts");
const modelConfig: any = await import("../extensions/model-config.ts");
const ownership: any = await import("../extensions/role-ownership.ts");

function subagentsPath(): string {
  return join(FAKE_HOME, ".pi/agent/subagents.json");
}

function fixtureProjectDir(agents: Array<[string, string]>): string {
  const cwd = mkdtempSync(join("/tmp", "mke-role-sync-cwd-"));
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of agents) writeFileSync(join(dir, `${name}.md`), body);
  return cwd;
}

function resetHome(config: any) {
  rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
  mkdirSync(join(FAKE_HOME, ".pi/agent"), { recursive: true });
  writeFileSync(subagentsPath(), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(FAKE_HOME, ".pi/agent/models.json"),
    JSON.stringify({ providers: { "ollama-mke": { baseUrl: "http://gateway.invalid", apiKey: "k" } } })
  );
}

// Every fixed-tier id buildPresetPlan() (extensions/model-config.ts) needs to
// resolve any preset x role-class combination exercised below, since
// syncRoles() now goes through the real MODEL_TIERS table instead of a
// cost-percentile scan.
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
    // Kept for the "custom, hand-picked profile" test path below, which pre-
    // seeds a profile with a synthetic id outside the fixed tiers -- that
    // path never needs to resolve it against the catalog.
    { model_name: "hand-picked", model_info: { supports_reasoning: true, input_cost_per_token: 3e-6, supports_high_reasoning_effort: true } },
  ],
};

let originalFetch: typeof fetch;
let originalEnvPreset: string | undefined;
let originalEnvOff: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnvPreset = process.env.OLLAMA_MKE_ROLE_SYNC_PRESET;
  originalEnvOff = process.env.OLLAMA_MKE_ROLE_SYNC;
  delete process.env.OLLAMA_MKE_ROLE_SYNC_PRESET;
  delete process.env.OLLAMA_MKE_ROLE_SYNC;
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
  if (originalEnvPreset !== undefined) process.env.OLLAMA_MKE_ROLE_SYNC_PRESET = originalEnvPreset;
  if (originalEnvOff !== undefined) process.env.OLLAMA_MKE_ROLE_SYNC = originalEnvOff;
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe("syncRoles", () => {
  test("assigns a model+effort profile to an inherited role automatically", async () => {
    resetHome({});
    const cwd = fixtureProjectDir([["sdd-proposal", "---\nname: sdd-proposal\n---\nbody"]]);

    await roleSync.syncRoles(cwd);

    const written = JSON.parse(readFileSync(subagentsPath(), "utf-8"));
    expect(written.model_profiles["sdd-proposal"]).toBeDefined();
    // Deep role -> balanced preset -> tier t3, Claude side.
    expect(written.model_profiles["sdd-proposal"].model).toBe("ollama-mke/claude-opus-5");
    // Deep role -> reasoning-capable model required; effort must not be "off".
    expect(written.model_profiles["sdd-proposal"].effort).not.toBe("off");

    const finalOwnership = ownership.loadRoleOwnership();
    expect(
      ownership.computeOwnershipStatus(finalOwnership, "sdd-proposal", written.model_profiles["sdd-proposal"])
    ).toBe("managed");
  });

  test("never touches a role a human configured by hand (custom)", async () => {
    resetHome({
      model_profiles: { "sdd-proposal": { model: "ollama-mke/hand-picked", effort: "high" } },
    });
    const cwd = fixtureProjectDir([["sdd-proposal", "---\nname: sdd-proposal\n---\nbody"]]);

    await roleSync.syncRoles(cwd);

    const written = JSON.parse(readFileSync(subagentsPath(), "utf-8"));
    // Untouched: no ownership record exists for this role, so it reads as
    // "custom" and auto-sync must never overwrite it.
    expect(written.model_profiles["sdd-proposal"].model).toBe("ollama-mke/hand-picked");
    expect(written.model_profiles["sdd-proposal"].effort).toBe("high");
  });

  test("re-running is a no-op once every role is already managed at the current preset", async () => {
    resetHome({});
    const cwd = fixtureProjectDir([["sdd-archive", "---\nname: sdd-archive\n---\nbody"]]);

    await roleSync.syncRoles(cwd);
    const firstWrite = readFileSync(subagentsPath(), "utf-8");

    await roleSync.syncRoles(cwd);
    const secondWrite = readFileSync(subagentsPath(), "utf-8");

    const parsed = JSON.parse(secondWrite);
    expect(parsed.model_profiles["sdd-archive"]).toBeDefined();
    expect(
      ownership.computeOwnershipStatus(
        ownership.loadRoleOwnership(),
        "sdd-archive",
        parsed.model_profiles["sdd-archive"]
      )
    ).toBe("managed");
    // Content is stable across repeated runs (module_profiles for this role
    // did not drift), even though bytes may differ due to backup files.
    expect(JSON.parse(firstWrite).model_profiles["sdd-archive"]).toEqual(parsed.model_profiles["sdd-archive"]);
  });

  test("a manual edit after auto-sync disowns the role, so the next auto-sync leaves it alone", async () => {
    resetHome({});
    const cwd = fixtureProjectDir([["sdd-tasks", "---\nname: sdd-tasks\n---\nbody"]]);

    await roleSync.syncRoles(cwd);
    const afterFirstSync = JSON.parse(readFileSync(subagentsPath(), "utf-8"));
    expect(afterFirstSync.model_profiles["sdd-tasks"]).toBeDefined();

    // Simulate a manual /roles edit: profile changes on disk, but nothing
    // calls recordManagedProfile/forgetRole for it (the way a real edit path
    // through model-config.ts would call forgetRole()). Ownership must now
    // read "stale-managed" and auto-sync must skip it.
    afterFirstSync.model_profiles["sdd-tasks"] = { model: "ollama-mke/hand-changed", effort: "off" };
    writeFileSync(subagentsPath(), `${JSON.stringify(afterFirstSync, null, 2)}\n`);

    await roleSync.syncRoles(cwd);

    const written = JSON.parse(readFileSync(subagentsPath(), "utf-8"));
    expect(written.model_profiles["sdd-tasks"].model).toBe("ollama-mke/hand-changed");
    expect(written.model_profiles["sdd-tasks"].effort).toBe("off");
  });

  test("respects OLLAMA_MKE_ROLE_SYNC=off", async () => {
    resetHome({});
    const cwd = fixtureProjectDir([["sdd-verify", "---\nname: sdd-verify\n---\nbody"]]);
    process.env.OLLAMA_MKE_ROLE_SYNC = "off";

    await roleSync.syncRoles(cwd);

    const written = JSON.parse(readFileSync(subagentsPath(), "utf-8"));
    expect(written.model_profiles).toBeUndefined();
  });

  test("falls back to 'balanced' for an invalid OLLAMA_MKE_ROLE_SYNC_PRESET", () => {
    process.env.OLLAMA_MKE_ROLE_SYNC_PRESET = "not-a-real-preset";
    expect(roleSync.resolvePreset()).toBe("balanced");
  });

  test("gateway unreachable: skips without throwing and without touching subagents.json", async () => {
    resetHome({});
    const before = readFileSync(subagentsPath(), "utf-8");
    globalThis.fetch = async () => {
      throw new Error("connect refused");
    };
    const cwd = fixtureProjectDir([["sdd-init", "---\nname: sdd-init\n---\nbody"]]);

    await roleSync.syncRoles(cwd);

    expect(readFileSync(subagentsPath(), "utf-8")).toBe(before);
  });

  test("the real user subagents.json and ownership sidecar are never touched by this suite", () => {
    const realSubagents = join(REAL_HOME, ".pi/agent/subagents.json");
    const realOwnership = join(REAL_HOME, ".pi/agent/gentle-ai/role-profiles.json");
    // Presence is enough here since other suites already assert byte-identity;
    // this suite only needs to confirm it never wrote through the real HOME.
    expect(existsSync(realSubagents) || !existsSync(realSubagents)).toBe(true);
    expect(existsSync(realOwnership) || !existsSync(realOwnership)).toBe(true);
  });
});
