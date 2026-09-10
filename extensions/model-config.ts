/**
 * ollama-mke Model Config Extension for Pi — the `/roles` command.
 *
 * A TUI for managing which model and thinking effort each agent role uses,
 * so per-role routing no longer has to be hand-edited in
 * `~/.pi/agent/subagents.json`. It covers:
 *
 *   - Viewing every discovered role with its *effective* model/effort and
 *     where that value comes from (profile > agent definition > default).
 *   - Editing `model_profiles`, `default_model` and `default_effort`.
 *   - Clearing a role's profile so it inherits again.
 *   - Applying presets (cheap / balanced / quality) that auto-pick a model
 *     from the gateway's real pricing data (`/model/info`) and clamp the
 *     effort to what each model actually supports
 *     (`supports_*_reasoning_effort`).
 *
 * Every write creates a timestamped backup of `subagents.json` first and
 * preserves any unknown keys already present in the file.
 *
 * Part of https://github.com/elmaxid/pi-litellm-ollama-mke.
 *
 * Configuration resolution (same priority as litellm-sync.ts / litellm-cost.ts):
 *   1. OLLAMA_MKE_BASE_URL / OLLAMA_MKE_API_KEY env vars
 *   2. Legacy LITELLM_BASE_URL / LITELLM_API_KEY env vars
 *   3. providers["ollama-mke"] in ~/.pi/agent/models.json
 *   4. Legacy providers.litellm in ~/.pi/agent/models.json
 *   5. Defaults (http://localhost:4000, sk-cedar-local)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

interface RoleProfile {
  model?: string;
  effort?: ThinkingLevel;
}

/** Parsed shape of ~/.pi/agent/subagents.json (unknown keys preserved). */
interface SubagentsConfig {
  default_model?: string;
  default_effort?: ThinkingLevel;
  model_profiles?: Record<string, RoleProfile>;
  [key: string]: unknown;
}

interface AgentDefinitionInfo {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
}

interface CatalogEntry {
  id: string;
  reasoning: boolean;
  inputCostPerToken?: number;
  supportsXhigh?: boolean;
  supportsLow?: boolean;
  supportsMinimal?: boolean;
  supportsNone?: boolean;
}

type ProfileSource = "profile" | "definition" | "default" | "unresolved";

interface ResolvedRole {
  name: string;
  model?: string;
  effort?: ThinkingLevel;
  source: ProfileSource;
}

type RoleClass = "deep" | "standard" | "light";

interface PresetPlanEntry {
  role: string;
  roleClass: RoleClass;
  model: string;
  effort: ThinkingLevel;
  clampedFrom?: ThinkingLevel;
}

// ---------------------------------------------------------------------------
// Gateway config resolution (same priority as the sibling extensions — kept
// local because pi loads each extension file independently)
// ---------------------------------------------------------------------------

function readModelsJson(): { providers?: Record<string, any> } | undefined {
  const path = join(homedir(), ".pi", "agent", "models.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    // Strip // comments and trailing commas, same approach as litellm-sync.ts.
    const stripped = raw
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
      .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

function resolveGatewayConfig(): { baseUrl: string; apiKey: string; providerKey: string } {
  const defaults = { baseUrl: "http://localhost:4000", apiKey: "sk-cedar-local" };
  const parsed = readModelsJson();
  const providerKey = parsed?.providers?.["ollama-mke"] ? "ollama-mke" : "litellm";
  const p = parsed?.providers?.["ollama-mke"] ?? parsed?.providers?.litellm ?? {};
  return {
    baseUrl:
      process.env.OLLAMA_MKE_BASE_URL ??
      process.env.LITELLM_BASE_URL ??
      p.baseUrl ??
      defaults.baseUrl,
    apiKey:
      process.env.OLLAMA_MKE_API_KEY ??
      process.env.LITELLM_API_KEY ??
      p.apiKey ??
      defaults.apiKey,
    providerKey,
  };
}

// ---------------------------------------------------------------------------
// Gateway catalog: /v1/models + /model/info (pricing, reasoning support,
// per-model effort ceilings). All best-effort.
// ---------------------------------------------------------------------------

async function fetchCatalog(): Promise<CatalogEntry[]> {
  const cfg = resolveGatewayConfig();
  const headers = { Authorization: `Bearer ${cfg.apiKey}` };

  const res = await fetch(`${cfg.baseUrl}/model/info`, { headers, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`/model/info returned ${res.status} ${res.statusText}`);
  const payload = (await res.json()) as {
    data?: Array<{ model_name?: string; model_info?: Record<string, any> }>;
  };

  const out: CatalogEntry[] = [];
  for (const entry of payload.data ?? []) {
    if (!entry.model_name) continue;
    const info = entry.model_info ?? {};
    const cost = info.input_cost_per_token;
    out.push({
      id: entry.model_name,
      reasoning: Boolean(info.supports_reasoning),
      inputCostPerToken: typeof cost === "number" && cost > 0 ? cost : undefined,
      supportsXhigh: Boolean(info.supports_xhigh_reasoning_effort) || Boolean(info.supports_max_reasoning_effort),
      supportsLow: info.supports_low_reasoning_effort !== false,
      supportsMinimal: info.supports_minimal_reasoning_effort !== false,
      supportsNone: info.supports_none_reasoning_effort !== false,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function formatCost(perToken?: number): string {
  if (perToken === undefined) return "?";
  const perMillion = perToken * 1_000_000;
  if (perMillion >= 1) return `$${perMillion.toFixed(1)}/M`;
  if (perMillion >= 0.01) return `$${perMillion.toFixed(2)}/M`;
  return `$${perMillion.toFixed(3)}/M`;
}

// ---------------------------------------------------------------------------
// Role discovery: union of agents defined in .md frontmatter files and any
// existing model_profiles entries. Same directory precedence as gentle-pi's
// agents-config.ts: later entries win, project beats global.
// ---------------------------------------------------------------------------

function parseFrontmatterScalars(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    // Only top-level `key: scalar` lines; list items and nested keys are ignored.
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m || m[2].trim() === "") continue;
    let value = m[2].trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function discoverAgentDefinitions(cwd: string): Map<string, AgentDefinitionInfo> {
  const dirs = [
    join(homedir(), ".pi", "agent", "agents"),
    join(homedir(), ".pi", "agent", "subagents"),
    join(cwd, ".pi", "agents"),
    join(cwd, ".pi", "subagents"),
  ];
  const agents = new Map<string, AgentDefinitionInfo>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const scalars = parseFrontmatterScalars(readFileSync(join(dir, file), "utf-8"));
        const name = scalars.name?.trim() || basename(file).replace(/\.md$/i, "");
        const rawThinking = (scalars.thinking ?? scalars.effort ?? scalars.thinking_level ?? "")
          .toLowerCase();
        agents.set(name, {
          name,
          description: scalars.description ?? "",
          model: scalars.model || undefined,
          thinking: (THINKING_LEVELS as readonly string[]).includes(rawThinking)
            ? (rawThinking as ThinkingLevel)
            : undefined,
        });
      } catch {
        // Unreadable definition — skip it; the role may still appear via model_profiles.
      }
    }
  }
  return agents;
}

function subagentsJsonPath(): string {
  return join(homedir(), ".pi", "agent", "subagents.json");
}

function loadSubagentsConfig(): SubagentsConfig {
  const path = subagentsJsonPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SubagentsConfig;
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : err}) — fix it before using /roles.`
    );
  }
}

function resolveRoles(config: SubagentsConfig, cwd: string): ResolvedRole[] {
  const agents = discoverAgentDefinitions(cwd);
  const names = new Set<string>([...agents.keys(), ...Object.keys(config.model_profiles ?? {})]);
  const resolved: ResolvedRole[] = [];
  for (const name of [...names].sort()) {
    const profile = config.model_profiles?.[name];
    const def = agents.get(name);
    let model = profile?.model;
    let effort = profile?.effort;
    // Per-field inheritance, mirroring gentle-pi's mergeProfiles: each missing
    // field falls back to the agent definition, then to the global defaults —
    // a partial profile (e.g. effort only) still inherits the other field.
    if (!model) model = def?.model ?? config.default_model;
    if (!effort) effort = def?.thinking ?? config.default_effort;
    let source: ProfileSource = "profile";
    if (!profile?.model && !profile?.effort) {
      source = def?.model || def?.thinking ? "definition" : model || effort ? "default" : "unresolved";
    }
    resolved.push({ name, model, effort, source });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Persistence: backup + unknown-key-preserving write
// ---------------------------------------------------------------------------

function backupSubagentsConfig(): string {
  const path = subagentsJsonPath();
  if (!existsSync(path)) return "";
  // Millisecond precision plus an incremental suffix: two writes in the same
  // millisecond (possible with synthetic, non-blocking UIs) must not collide.
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace(/Z$/, "");
  let backupPath = `${path}.bak-${stamp}`;
  for (let n = 1; existsSync(backupPath); n++) backupPath = `${path}.bak-${stamp}-${n}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function saveSubagentsConfig(config: SubagentsConfig): string {
  const backup = backupSubagentsConfig();
  writeFileSync(subagentsJsonPath(), `${JSON.stringify(config, null, 2)}\n`);
  return backup;
}

// ---------------------------------------------------------------------------
// Presets: pick models from real gateway pricing, classify roles, clamp
// efforts to what each model supports.
// ---------------------------------------------------------------------------

function classifyRole(name: string): RoleClass {
  if (/proposal|design|verify|review|judge|research/i.test(name)) return "deep";
  if (/sync|archive|status|init\b|onboard/i.test(name)) return "light";
  return "standard";
}

const PRESET_EFFORT: Record<string, Record<RoleClass, ThinkingLevel>> = {
  cheap: { deep: "medium", standard: "low", light: "off" },
  balanced: { deep: "high", standard: "medium", light: "low" },
  quality: { deep: "xhigh", standard: "high", light: "medium" },
};

function pickModelByCost(catalog: CatalogEntry[], percentile: number, requireReasoning: boolean): CatalogEntry | undefined {
  const pool = catalog.filter((m) => m.inputCostPerToken !== undefined && (!requireReasoning || m.reasoning));
  if (pool.length === 0) return undefined;
  const sorted = [...pool].sort((a, b) => (a.inputCostPerToken ?? 0) - (b.inputCostPerToken ?? 0));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * percentile)));
  return sorted[index];
}

function clampEffort(effort: ThinkingLevel, model: CatalogEntry | undefined): ThinkingLevel {
  if (!model) return effort;
  if (effort === "xhigh" && !model.supportsXhigh) return "high";
  if (effort === "low" && !model.supportsLow && model.supportsMinimal) return "minimal";
  if (effort === "off" && !model.supportsNone) return "minimal";
  return effort;
}

function buildPresetPlan(preset: string, catalog: CatalogEntry[], roles: ResolvedRole[]): PresetPlanEntry[] | string {
  const percentile = preset === "cheap" ? 0.15 : preset === "balanced" ? 0.5 : 0.9;
  // Deep roles need a reasoning-capable model; standard roles prefer one but
  // fall back to the whole pool; light roles never require it.
  const deepModel = pickModelByCost(catalog, percentile, true) ?? pickModelByCost(catalog, percentile, false);
  const standardModel = pickModelByCost(catalog, percentile, false);
  const lightModel = pickModelByCost(catalog, Math.min(percentile, 0.15), false);
  if (!deepModel || !standardModel || !lightModel) {
    return "The gateway did not expose usable pricing data (/model/info) — presets need real costs to pick models. Check that the gateway is reachable and exposes input_cost_per_token.";
  }
  const plans: PresetPlanEntry[] = [];
  for (const role of roles) {
    const roleClass = classifyRole(role.name);
    const model = roleClass === "deep" ? deepModel : roleClass === "standard" ? standardModel : lightModel;
    const wanted = PRESET_EFFORT[preset][roleClass];
    const effort = clampEffort(wanted, model);
    plans.push({
      role: role.name,
      roleClass,
      model: model.id,
      effort,
      clampedFrom: effort === wanted ? undefined : wanted,
    });
  }
  return plans;
}

function providerQualifiedModelId(id: string): string {
  if (id.includes("/")) return id;
  return `${resolveGatewayConfig().providerKey}/${id}`;
}

// ---------------------------------------------------------------------------
// TUI: menu-driven wizard built on ctx.ui (select/confirm/input/notify)
// ---------------------------------------------------------------------------

function modelLabel(entry: CatalogEntry | undefined, id: string): string {
  if (!entry) return id;
  return `${id}${entry.reasoning ? " [R]" : ""} (${formatCost(entry.inputCostPerToken)})`;
}

const SOURCE_TAG: Record<ProfileSource, string> = {
  profile: "",
  definition: "(from agent .md)",
  default: "[inherited default]",
  unresolved: "! unresolved",
};

/** Minimal shape of the pi TUI context used here (keeps this file independent
 *  from pi's internal UI types, which are not part of the public surface). */
interface Ui {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

async function chooseModel(ui: Ui, catalog: CatalogEntry[], current?: string): Promise<string | undefined> {
  const options = ["(clear — inherit)", ...catalog.map((m) => modelLabel(m, m.id))];
  const currentLabel = current ? catalog.find((m) => m.id === current) : undefined;
  const choice = await ui.select(
    current ? `Model (current: ${modelLabel(currentLabel, current)}):` : "Model:",
    options
  );
  if (choice === undefined) return undefined;
  if (choice === "(clear — inherit)") return "";
  const chosen = catalog.find((m) => modelLabel(m, m.id) === choice);
  return chosen?.id;
}

async function chooseEffort(ui: Ui, current?: ThinkingLevel): Promise<ThinkingLevel | undefined | ""> {
  const options = ["(clear — inherit)", ...THINKING_LEVELS];
  const choice = await ui.select(
    current ? `Effort (current: ${current}):` : "Effort:",
    options
  );
  if (choice === undefined) return undefined;
  if (choice === "(clear — inherit)") return "";
  return choice as ThinkingLevel;
}

async function confirmWrite(ui: Ui, summary: string): Promise<boolean> {
  return ui.confirm("Write changes?", `${summary}\n\nA timestamped backup of subagents.json is created first.`);
}

export default function modelConfigExtension(pi: ExtensionAPI): void {
  pi.registerCommand("roles", {
    description: "Configure per-role model and effort (model_profiles, presets)",
    handler: async (_args, ctx) => {
      const ui: Ui = ctx.ui;
      const cwd = process.cwd();
      let catalog: CatalogEntry[] = [];
      let catalogError: string | undefined;
      try {
        catalog = await fetchCatalog();
      } catch (err) {
        catalogError = err instanceof Error ? err.message : String(err);
      }

      let running = true;
      while (running) {
        let config: SubagentsConfig;
        try {
          config = loadSubagentsConfig();
        } catch (err) {
          await ui.notify(err instanceof Error ? err.message : String(err), "error");
          return;
        }
        const roles = resolveRoles(config, cwd);

        const action = await ui.select(
          `Model Config — ${roles.length} roles · ${catalog.length} gateway models${catalogError ? " (gateway unreachable)" : ""}`,
          [
            "View / edit roles",
            "Defaults (default_model / default_effort)",
            "Apply preset (cheap / balanced / quality)",
            "Exit",
          ]
        );
        if (action === undefined || action === "Exit") return;

        if (action === "View / edit roles") {
          const options = roles.map(
            (r) => `${r.name} → ${r.model ?? "?"} · ${r.effort ?? "?"} ${SOURCE_TAG[r.source]}`
          );
          const picked = await ui.select("Roles (model · effort · source):", options);
          if (picked === undefined) continue;
          const role = roles[options.indexOf(picked)];
          if (!role) continue;
          const edit = await ui.select(`Edit ${role.name}:`, [
            "Change model",
            "Change effort",
            "Clear profile (inherit again)",
            "Back",
          ]);
          if (edit === undefined || edit === "Back") continue;

          if (edit === "Change model") {
            const modelId = await chooseModel(ui, catalog, role.model?.split("/").pop());
            if (modelId === undefined) continue;
            const summary =
              modelId === ""
                ? `${role.name}: model cleared (inherits ${config.default_model ?? "pi default"})`
                : `${role.name}: model → ${providerQualifiedModelId(modelId)}`;
            if (!(await confirmWrite(ui, summary))) continue;
            config.model_profiles ??= {};
            config.model_profiles[role.name] ??= {};
            if (modelId === "") delete config.model_profiles[role.name].model;
            else config.model_profiles[role.name].model = providerQualifiedModelId(modelId);
            if (Object.keys(config.model_profiles[role.name]).length === 0) {
              delete config.model_profiles[role.name];
              if (Object.keys(config.model_profiles).length === 0) delete config.model_profiles;
            }
            const backup = saveSubagentsConfig(config);
            await ui.notify(`Saved. ${summary}${backup ? `\nBackup: ${basename(backup)}` : ""}`, "info");
          } else if (edit === "Change effort") {
            const effort = await chooseEffort(ui, role.effort);
            if (effort === undefined) continue;
            const summary =
              effort === ""
                ? `${role.name}: effort cleared (inherits ${config.default_effort ?? "none"})`
                : `${role.name}: effort → ${effort}`;
            if (!(await confirmWrite(ui, summary))) continue;
            config.model_profiles ??= {};
            config.model_profiles[role.name] ??= {};
            if (effort === "") delete config.model_profiles[role.name].effort;
            else config.model_profiles[role.name].effort = effort;
            if (Object.keys(config.model_profiles[role.name]).length === 0) {
              delete config.model_profiles[role.name];
              if (Object.keys(config.model_profiles).length === 0) delete config.model_profiles;
            }
            const backup = saveSubagentsConfig(config);
            await ui.notify(`Saved. ${summary}${backup ? `\nBackup: ${basename(backup)}` : ""}`, "info");
          } else if (edit === "Clear profile (inherit again)") {
            if (!(await confirmWrite(ui, `${role.name}: profile removed — will inherit default/definition.`))) continue;
            if (config.model_profiles) {
              delete config.model_profiles[role.name];
              if (Object.keys(config.model_profiles).length === 0) delete config.model_profiles;
            }
            const backup = saveSubagentsConfig(config);
            await ui.notify(`Saved. ${role.name} inherits again.${backup ? `\nBackup: ${basename(backup)}` : ""}`, "info");
          }
          continue;
        }

        if (action === "Defaults (default_model / default_effort)") {
          const which = await ui.select(
            `Defaults — model: ${config.default_model ?? "(none)"} · effort: ${config.default_effort ?? "(none)"}`,
            ["Change default_model", "Change default_effort", "Back"]
          );
          if (which === undefined || which === "Back") continue;

          if (which === "Change default_model") {
            const modelId = await chooseModel(ui, catalog, config.default_model?.split("/").pop());
            if (modelId === undefined) continue;
            const summary =
              modelId === ""
                ? "default_model cleared"
                : `default_model → ${providerQualifiedModelId(modelId)}`;
            if (!(await confirmWrite(ui, summary))) continue;
            if (modelId === "") delete config.default_model;
            else config.default_model = providerQualifiedModelId(modelId);
            const backup = saveSubagentsConfig(config);
            await ui.notify(`Saved. ${summary}${backup ? `\nBackup: ${basename(backup)}` : ""}`, "info");
          } else {
            const effort = await chooseEffort(ui, config.default_effort);
            if (effort === undefined) continue;
            const summary = effort === "" ? "default_effort cleared" : `default_effort → ${effort}`;
            if (!(await confirmWrite(ui, summary))) continue;
            if (effort === "") delete config.default_effort;
            else config.default_effort = effort;
            const backup = saveSubagentsConfig(config);
            await ui.notify(`Saved. ${summary}${backup ? `\nBackup: ${basename(backup)}` : ""}`, "info");
          }
          continue;
        }

        if (action === "Apply preset (cheap / balanced / quality)") {
          if (catalog.length === 0) {
            await ui.notify(
              `Gateway catalog unavailable: ${catalogError ?? "no models"} — presets need /model/info pricing.`,
              "error"
            );
            continue;
          }
          const preset = await ui.select("Preset:", ["cheap", "balanced", "quality"]);
          if (preset === undefined) continue;
          const plan = buildPresetPlan(preset, catalog, roles);
          if (typeof plan === "string") {
            await ui.notify(plan, "error");
            continue;
          }
          const lines = plan.map(
            (p) =>
              `${p.role} [${p.roleClass}] → ${p.model} · ${p.effort}${p.clampedFrom ? ` (clamped from ${p.clampedFrom})` : ""}`
          );
          const approved = await ui.confirm(
            `Apply preset "${preset}"?`,
            `${lines.join("\n")}\n\nThis rewrites model_profiles for all ${plan.length} roles.`
          );
          if (!approved) continue;
          if (!(await confirmWrite(ui, `Preset "${preset}": ${plan.length} roles updated.`))) continue;
          config.model_profiles = {};
          for (const p of plan) {
            config.model_profiles[p.role] = {
              model: providerQualifiedModelId(p.model),
              effort: p.effort,
            };
          }
          const backup = saveSubagentsConfig(config);
          await ui.notify(
            `Preset "${preset}" applied to ${plan.length} roles.${backup ? `\nBackup: ${basename(backup)}` : ""}\nNote: agents launched after this point pick up the new profiles.`,
            "info"
          );
        }
      }
    },
  });
}

// Named exports for the pure logic — pi only consumes the default export,
// these exist so tests can exercise the real implementation.
export {
  THINKING_LEVELS,
  classifyRole,
  clampEffort,
  buildPresetPlan,
  discoverAgentDefinitions,
  loadSubagentsConfig,
  parseFrontmatterScalars,
  pickModelByCost,
  resolveGatewayConfig,
  resolveRoles,
};
