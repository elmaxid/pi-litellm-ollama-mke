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
import {
  computeOwnershipStatus,
  forgetRole,
  loadRoleOwnership,
  recordManagedProfile,
  saveRoleOwnership,
  type OwnershipStatus,
} from "./role-ownership.ts";

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

/**
 * Per-effort support is tri-state, mirroring what /model/info actually says:
 *   true  = gateway explicitly confirms the level works
 *   false = gateway explicitly denies the level
 *   undefined = gateway did not publish a decision (unknown, NOT assumed true)
 */
interface CatalogEntry {
  id: string;
  reasoning: boolean;
  inputCostPerToken?: number;
  supportsXhigh?: boolean;
  supportsHigh?: boolean;
  supportsMedium?: boolean;
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
    // Tri-state: undefined stays undefined (unknown), never coerced to true.
    // Only an explicit `true`/`false` from the gateway counts as a fact.
    const flag = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
    out.push({
      id: entry.model_name,
      reasoning: info.supports_reasoning === true,
      // A gateway-confirmed 0 (e.g. a free/local model) is a real price,
      // not "unknown" -- only an absent/non-numeric value means we have
      // no price fact for this model at all. Presets treat 0 as the
      // cheapest possible price rather than excluding the model.
      inputCostPerToken: typeof cost === "number" ? cost : undefined,
      supportsXhigh: flag(info.supports_xhigh_reasoning_effort) ?? flag(info.supports_max_reasoning_effort),
      supportsHigh: flag(info.supports_high_reasoning_effort),
      supportsMedium: flag(info.supports_medium_reasoning_effort),
      supportsLow: flag(info.supports_low_reasoning_effort),
      supportsMinimal: flag(info.supports_minimal_reasoning_effort),
      supportsNone: flag(info.supports_none_reasoning_effort),
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
    } catch (err) {
      // Unreadable directory — warn so roles vanishing from the view is diagnosable.
      console.warn(`[ollama-mke-roles] cannot list ${dir}: ${err instanceof Error ? err.message : err}`);
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
      } catch (err) {
        // Unreadable definition — skip it, but say so: the role may still
        // appear via model_profiles, yet silently losing it hides drift.
        console.warn(`[ollama-mke-roles] skipping unreadable agent definition ${join(dir, file)}: ${err instanceof Error ? err.message : err}`);
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

/**
 * Fixed model tiers, explicitly curated instead of derived from a
 * cost-percentile scan of the whole gateway catalog. A pure percentile scan
 * over the real gateway catalog kept landing on outdated same-family
 * siblings or on gateway-confirmed free/non-reasoning models for lighter
 * roles -- neither is what "cheap/balanced/quality" is meant to promise.
 * Each tier pairs one Claude-family id with one Codex-family id at a
 * comparable capability/price point; buildPresetPlan() below picks the
 * Claude side for "deep" roles and the Codex side for "standard"/"light"
 * roles. IDs are RAW gateway ids (matched against CatalogEntry.id, same as
 * pickModelByCost) -- never Pi-provider-qualified here.
 */
const MODEL_TIERS = {
  t1: { claude: "claude-haiku-4-5", codex: "codex-gpt56-luna" },
  t2: { claude: "claude-sonnet-5", codex: "codex-gpt56-terra" },
  t3: { claude: "claude-opus-5", codex: "codex-gpt56-sol" },
  t4: { claude: "claude-fable-5-1", codex: "codex-gpt6-astra" },
} as const;
type ModelTier = keyof typeof MODEL_TIERS;

/**
 * Tier assigned to each (preset, role class) combination. cheap always uses
 * the lightest tier for every role class. balanced and quality step light
 * roles down one tier from standard, and standard one tier down from deep,
 * so a heavier preset never assigns a lighter role the SAME tier as a
 * deeper one, while still never handing a light role something as heavy as
 * a deep role's tier.
 */
const PRESET_TIER: Record<string, Record<RoleClass, ModelTier>> = {
  cheap: { deep: "t1", standard: "t1", light: "t1" },
  balanced: { deep: "t3", standard: "t2", light: "t1" },
  quality: { deep: "t4", standard: "t3", light: "t2" },
};

/**
 * Split a model id into a "family" prefix and a trailing numeric version,
 * e.g. "claude-opus-4-6" -> ("claude-opus", [4, 6]) and "claude-sonnet-5" ->
 * ("claude-sonnet", [5]). Only PURELY numeric trailing hyphen-segments count
 * as version components -- this deliberately stops at the first
 * non-numeric segment scanning from the right, so tier/size names that
 * happen to end in digits ("codex-gpt56-terra", "deepseek-v4-pro",
 * "nemotron-3-ultra") are NOT mistaken for version suffixes and keep their
 * full id as their own family (no collapsing across genuinely different
 * models). An id with no trailing numeric segment at all is its own
 * one-member family with an empty version (never grouped with anything).
 */
function parseVersionedFamily(id: string): { family: string; version: number[] } {
  const segments = id.split("-");
  const version: number[] = [];
  let i = segments.length - 1;
  while (i > 0 && /^\d+(\.\d+)?$/.test(segments[i])) {
    version.unshift(Number(segments[i]));
    i--;
  }
  if (version.length === 0) return { family: id, version: [] };
  return { family: segments.slice(0, i + 1).join("-"), version };
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Collapse a catalog down to the latest version within each detected
 * versioned family (see parseVersionedFamily), so a preset never assigns an
 * outdated sibling (e.g. "claude-opus-4-6") when a newer one in the same
 * family ("claude-opus-5") is available at any price. Entries whose id has
 * no purely-numeric trailing version segment are each their own family and
 * always survive unchanged.
 */
function collapseToLatestPerFamily(catalog: CatalogEntry[]): CatalogEntry[] {
  const latest = new Map<string, { entry: CatalogEntry; version: number[] }>();
  for (const entry of catalog) {
    const { family, version } = parseVersionedFamily(entry.id);
    const current = latest.get(family);
    if (!current || compareVersions(version, current.version) > 0) {
      latest.set(family, { entry, version });
    }
  }
  return [...latest.values()].map((v) => v.entry);
}

function pickModelByCost(catalog: CatalogEntry[], percentile: number, requireReasoning: boolean): CatalogEntry | undefined {
  const priced = catalog.filter((m) => m.inputCostPerToken !== undefined && (!requireReasoning || m.reasoning));
  // Never let an outdated same-family model absorb a percentile slot ahead
  // of (or instead of) its own newer sibling.
  const pool = collapseToLatestPerFamily(priced);
  if (pool.length === 0) return undefined;
  const sorted = [...pool].sort((a, b) => (a.inputCostPerToken ?? 0) - (b.inputCostPerToken ?? 0));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * percentile)));
  return sorted[index];
}

/**
 * Per-level support lookup used by clampEffort. `undefined` means "gateway
 * did not say" -- treated as neutral (not proof of support), matching
 * gatewayCapabilities() in litellm-sync.ts.
 */
const EFFORT_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function supportFlag(model: CatalogEntry, level: ThinkingLevel): boolean | undefined {
  switch (level) {
    case "off":
      return model.supportsNone;
    case "minimal":
      return model.supportsMinimal;
    case "low":
      return model.supportsLow;
    case "medium":
      return model.supportsMedium;
    case "high":
      return model.supportsHigh;
    case "xhigh":
      return model.supportsXhigh;
  }
}

/**
 * Clamp a requested effort to a level the model can actually run.
 *
 * - Never assigns a non-"off" effort to a model without confirmed reasoning:
 *   returns "off" regardless of what was requested (deep roles must not get
 *   silently degraded to a reasoning effort a non-reasoning model ignores or
 *   rejects).
 * - When the gateway explicitly denies a level (`false`), steps down through
 *   EFFORT_ORDER to the nearest level that is NOT explicitly denied. If every
 *   level down to "off" is denied, returns "off".
 * - When support is unknown (`undefined`) for the requested level, keeps it:
 *   unknown is not proof of failure, and pi's own thinkingLevelMap (once
 *   litellm-sync registers confirmed capabilities) will reject it if it truly
 *   is unsupported. Silence never promotes to "supported" but also never
 *   forces a downgrade on its own.
 */
function clampEffort(effort: ThinkingLevel, model: CatalogEntry | undefined): ThinkingLevel {
  if (!model) return effort;
  if (!model.reasoning) return "off";

  if (supportFlag(model, effort) !== false) return effort;

  const startIndex = EFFORT_ORDER.indexOf(effort);
  for (let i = startIndex - 1; i >= 0; i--) {
    const candidate = EFFORT_ORDER[i];
    if (supportFlag(model, candidate) !== false) return candidate;
  }
  return "off";
}

/**
 * Resolve one fixed tier's Claude/Codex id against the live catalog. A tier
 * id absent from the current gateway catalog (e.g. temporarily delisted)
 * returns undefined rather than inventing a substitute -- the caller decides
 * whether that is fatal for this role class.
 */
function resolveTierModel(catalog: CatalogEntry[], tier: ModelTier, side: "claude" | "codex"): CatalogEntry | undefined {
  const id = MODEL_TIERS[tier][side];
  return catalog.find((m) => m.id === id);
}

function buildPresetPlan(preset: string, catalog: CatalogEntry[], roles: ResolvedRole[]): PresetPlanEntry[] | string {
  const tierByClass = PRESET_TIER[preset];
  if (!tierByClass) return `Unknown preset "${preset}".`;

  const plans: PresetPlanEntry[] = [];
  for (const role of roles) {
    const roleClass = classifyRole(role.name);
    const tier = tierByClass[roleClass];
    // Claude for deep roles (judgment/review-heavy), Codex for standard/light
    // (execution-heavy) -- fixed by design, not derived from pricing.
    const side = roleClass === "deep" ? "claude" : "codex";
    const model = resolveTierModel(catalog, tier, side);
    if (!model) {
      return (
        `Preset "${preset}" needs "${MODEL_TIERS[tier][side]}" (tier ${tier}, ${side} side) for ` +
        `${roleClass} roles, but the gateway catalog does not currently list it. ` +
        `Check the gateway's /model/info, or add a modelOverride for it.`
      );
    }
    // Deep roles REQUIRE a reasoning-capable model -- the fixed tiers are all
    // reasoning-capable by curation, but a stale/misconfigured gateway entry
    // could still report reasoning:false; never silently drop reasoning for
    // a deep role in that case.
    if (roleClass === "deep" && !model.reasoning) {
      return (
        `Preset "${preset}"'s deep-role model "${model.id}" is not gateway-confirmed reasoning-capable ` +
        `right now -- refusing to assign a deep role (proposal/design/verify/review/judge/research) ` +
        `a model without confirmed reasoning.`
      );
    }
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

/**
 * Qualify a gateway model id with the configured Pi provider prefix.
 *
 * A gateway model id CAN legitimately contain '/' -- e.g. LiteLLM entries
 * like "bedrock/claude-sonnet-4.6" -- without that meaning it is already
 * prefixed with our Pi provider key. Blindly returning any id containing '/'
 * unchanged (the previous behavior) silently misrouted those models: pi
 * would resolve them against a provider named "bedrock", not "ollama-mke".
 *
 * Every id coming out of the gateway catalog (fetchCatalog()/CatalogEntry.id)
 * is always the RAW gateway id, never already Pi-provider-qualified -- so the
 * only case that must not be double-prefixed is when the id already starts
 * with exactly "<providerKey>/".
 */
function providerQualifiedModelId(id: string): string {
  const { providerKey } = resolveGatewayConfig();
  if (id === providerKey || id.startsWith(`${providerKey}/`)) return id;
  return `${providerKey}/${id}`;
}

/**
 * Strip the Pi provider prefix from a stored model id so it can be matched
 * back against catalog entries (which are always raw gateway ids). Unlike
 * the previous `role.model?.split("/").pop()` call sites, this only removes
 * the LEADING "<providerKey>/" segment and leaves any slash that is part of
 * the gateway id itself (e.g. "bedrock/claude-sonnet-4.6") intact.
 */
function stripProviderPrefix(id: string | undefined): string | undefined {
  if (!id) return id;
  const { providerKey } = resolveGatewayConfig();
  const prefix = `${providerKey}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
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

/** Ownership tag shown next to each role in "View / edit roles". Only
 *  meaningful for roles with an explicit model_profiles entry -- "inherited"
 *  roles (no explicit profile) never show a tag since there is nothing to
 *  own yet. */
const OWNERSHIP_TAG: Record<OwnershipStatus, string> = {
  inherited: "",
  managed: "[managed by preset]",
  custom: "[custom]",
  "stale-managed": "[stale-managed -- edited since last preset]",
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
          const ownership = loadRoleOwnership();
          const options = roles.map((r) => {
            const status = computeOwnershipStatus(ownership, r.name, config.model_profiles?.[r.name]);
            const tag = [SOURCE_TAG[r.source], OWNERSHIP_TAG[status]].filter(Boolean).join(" ");
            return `${r.name} → ${r.model ?? "?"} · ${r.effort ?? "?"} ${tag}`;
          });
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
            const modelId = await chooseModel(ui, catalog, stripProviderPrefix(role.model));
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
            // A manual edit is always the human's decision, never the
            // preset's: disown the role so a future "Apply preset" never
            // treats a hand-picked model as something it wrote and is free
            // to overwrite.
            saveRoleOwnership(forgetRole(loadRoleOwnership(), role.name));
            await ui.notify(`Saved. ${summary}${backup ? `\nBackup: ${basename(backup)}` : ""}`, "info");
          } else if (edit === "Change effort") {
            const effort = await chooseEffort(ui, role.effort);
            if (effort === undefined) continue;
            // Validate against the currently-selected model's confirmed
            // capabilities when the catalog has data for it. This never
            // silently clamps: an incompatible manual choice is rejected
            // with an explanation instead of being rewritten to something
            // else the user did not ask for.
            if (effort !== "") {
              const targetModelId = stripProviderPrefix(role.model);
              const catalogEntry = catalog.find((m) => m.id === targetModelId);
              if (catalogEntry) {
                if (effort !== "off" && !catalogEntry.reasoning) {
                  await ui.notify(
                    `${role.name}: ${effort} requires a reasoning-capable model, but ${catalogEntry.id} is not confirmed reasoning-capable. Choose a reasoning model first, or set effort to off.`,
                    "error"
                  );
                  continue;
                }
                if (supportFlag(catalogEntry, effort) === false) {
                  await ui.notify(
                    `${role.name}: ${catalogEntry.id} explicitly does not support ${effort} reasoning effort (per /model/info). Choose a different effort.`,
                    "error"
                  );
                  continue;
                }
              }
            }
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
            // Same rule as "Change model": a manual edit disowns the role.
            saveRoleOwnership(forgetRole(loadRoleOwnership(), role.name));
            await ui.notify(`Saved. ${summary}${backup ? `\nBackup: ${basename(backup)}` : ""}`, "info");
          } else if (edit === "Clear profile (inherit again)") {
            if (!(await confirmWrite(ui, `${role.name}: profile removed — will inherit default/definition.`))) continue;
            if (config.model_profiles) {
              delete config.model_profiles[role.name];
              if (Object.keys(config.model_profiles).length === 0) delete config.model_profiles;
            }
            const backup = saveSubagentsConfig(config);
            // Nothing left to own once the profile is cleared.
            saveRoleOwnership(forgetRole(loadRoleOwnership(), role.name));
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
            const modelId = await chooseModel(ui, catalog, stripProviderPrefix(config.default_model));
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
          // Ownership gate: only touch roles that are "inherited" (no
          // explicit profile yet) or "managed" (still matches what a prior
          // preset wrote). "custom" and "stale-managed" roles are a human's
          // decision and are always skipped, never silently overwritten --
          // this replaces the old `config.model_profiles = {}` wipe, which
          // used to destroy every hand-configured role on every preset run.
          const ownershipBefore = loadRoleOwnership();
          const applicable: PresetPlanEntry[] = [];
          const skipped: Array<{ entry: PresetPlanEntry; status: OwnershipStatus }> = [];
          for (const p of plan) {
            const status = computeOwnershipStatus(ownershipBefore, p.role, config.model_profiles?.[p.role]);
            if (status === "custom" || status === "stale-managed") skipped.push({ entry: p, status });
            else applicable.push(p);
          }

          const lines = applicable.map(
            (p) =>
              `${p.role} [${p.roleClass}] → ${p.model} · ${p.effort}${p.clampedFrom ? ` (clamped from ${p.clampedFrom})` : ""}`
          );
          // Surface the silent-quality case of percentile picking. Deep
          // roles are now guaranteed a reasoning-capable model by
          // buildPresetPlan() (it returns an error string instead of a plan
          // when none exists), so only the "collapsed to one model" case
          // remains worth flagging here.
          const notes: string[] = [];
          if (applicable.length > 1 && new Set(applicable.map((p) => p.model)).size === 1) {
            notes.push("note: every class resolved to the same model (small catalog or uniform pricing).");
          }
          if (skipped.length > 0) {
            notes.push(
              `skipped ${skipped.length} role(s) with a profile this preset did not write:\n` +
                skipped.map((s) => `  - ${s.entry.role} (${s.status})`).join("\n")
            );
          }
          if (applicable.length === 0) {
            await ui.notify(
              `Preset "${preset}": every role already has a custom or stale-managed profile -- nothing to apply.\n${notes.join("\n\n")}`,
              "info"
            );
            continue;
          }
          const approved = await ui.confirm(
            `Apply preset "${preset}"?`,
            `${notes.length ? notes.join("\n\n") + "\n\n" : ""}${lines.join("\n")}\n\nThis writes model_profiles for ${applicable.length} of ${plan.length} role(s).`
          );
          if (!approved) continue;
          if (!(await confirmWrite(ui, `Preset "${preset}": ${applicable.length} roles updated.`))) continue;
          config.model_profiles ??= {};
          let ownershipAfter = ownershipBefore;
          for (const p of applicable) {
            const profile = { model: providerQualifiedModelId(p.model), effort: p.effort };
            config.model_profiles[p.role] = profile;
            ownershipAfter = recordManagedProfile(ownershipAfter, p.role, profile);
          }
          const backup = saveSubagentsConfig(config);
          saveRoleOwnership(ownershipAfter);
          await ui.notify(
            `Preset "${preset}" applied to ${applicable.length} role(s)${skipped.length ? ` (${skipped.length} skipped)` : ""}.${backup ? `\nBackup: ${basename(backup)}` : ""}\nNote: agents launched after this point pick up the new profiles.`,
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
  MODEL_TIERS,
  PRESET_TIER,
  classifyRole,
  clampEffort,
  buildPresetPlan,
  collapseToLatestPerFamily,
  compareVersions,
  discoverAgentDefinitions,
  fetchCatalog,
  loadSubagentsConfig,
  parseFrontmatterScalars,
  parseVersionedFamily,
  pickModelByCost,
  providerQualifiedModelId,
  resolveGatewayConfig,
  resolveRoles,
  resolveTierModel,
  saveSubagentsConfig,
  stripProviderPrefix,
  subagentsJsonPath,
  supportFlag,
};
export type { CatalogEntry, PresetPlanEntry, ResolvedRole, RoleProfile, SubagentsConfig, ThinkingLevel };
