/**
 * ollama-mke Role Auto-Sync Extension for Pi
 *
 * Closes the gap between the two things this package keeps in sync:
 *   - litellm-sync.ts registers the live gateway MODEL catalog automatically
 *     on every startup/reload (pi.registerProvider), no user action needed.
 *   - extensions/model-config.ts (the `/roles` TUI) is the only thing that
 *     assigns a model+effort to each AGENT role, and it is 100% manual: a
 *     human has to open `/roles` and pick "Apply preset" by hand.
 *
 * This extension runs that same, already-tested preset logic automatically
 * on session_start/reload, so newly discovered agent roles (installed by
 * gentle-ai sync, a project's .pi/agents, etc.) get an ollama-mke model+effort
 * profile without requiring a manual `/roles` visit every time.
 *
 * Safety, reusing model-config.ts's existing guarantees unchanged:
 *   - Ownership-aware: only ever touches roles that are "inherited" (no
 *     profile yet) or "managed" (still exactly what a prior preset/auto-sync
 *     wrote). A "custom" or "stale-managed" role -- i.e. anything a human
 *     touched by hand, including via /roles itself -- is NEVER auto-written.
 *   - Effort is included, not just the model: buildPresetPlan() clamps the
 *     requested effort to what the gateway's /model/info confirms the chosen
 *     model actually supports, exactly like a manual "Apply preset" run.
 *   - Deep roles (proposal/design/verify/review/judge/research) still require
 *     a gateway-confirmed reasoning-capable model; if the gateway does not
 *     expose one, this extension skips silently (logs and does nothing) --
 *     it never assigns a non-reasoning model to a deep role.
 *   - Same backup-before-write and unknown-key preservation as /roles.
 *   - Best-effort: gateway unreachable, /model/info empty, or a partial
 *     catalog degrades to "log and skip", never a throw that could block
 *     startup.
 *
 * Configuration:
 *   OLLAMA_MKE_ROLE_SYNC_PRESET=cheap|balanced|quality (default: "balanced")
 *   OLLAMA_MKE_ROLE_SYNC=on enables this extension. It is OFF BY DEFAULT: a
 *   harness like gentle-ai/gentle-pi may already be the source of truth for
 *   role -> model routing (its own config, e.g. gentle-ai's models.json,
 *   reapplied on every session_start). This extension writing subagents.json
 *   at the same time would silently fight that authority for every operator
 *   who has not explicitly asked for this auto-sync -- across a shared team
 *   install, most have not. Opt in only where this extension is meant to be
 *   the routing authority instead.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildPresetPlan,
  fetchCatalog,
  loadSubagentsConfig,
  resolveRoles,
  saveSubagentsConfig,
  providerQualifiedModelId,
  type PresetPlanEntry,
} from "./model-config.ts";
import {
  computeOwnershipStatus,
  loadRoleOwnership,
  recordManagedProfile,
  saveRoleOwnership,
  type OwnershipStatus,
} from "./role-ownership.ts";

const VALID_PRESETS = ["cheap", "balanced", "quality"] as const;
type Preset = (typeof VALID_PRESETS)[number];

function resolvePreset(): Preset {
  const raw = (process.env.OLLAMA_MKE_ROLE_SYNC_PRESET ?? "balanced").toLowerCase();
  return (VALID_PRESETS as readonly string[]).includes(raw) ? (raw as Preset) : "balanced";
}

/**
 * Runs one auto-sync pass: fetch the gateway catalog, build a preset plan for
 * every discovered role, apply it only to roles that are safe to touch
 * (inherited/managed), and persist + record ownership exactly like a manual
 * "Apply preset" run would. Never throws -- every failure mode logs and
 * returns without touching subagents.json.
 */
async function syncRoles(cwd: string): Promise<void> {
  // The entire pass is wrapped: every step below (including the pure-logic
  // calls resolveRoles/buildPresetPlan/loadRoleOwnership/
  // computeOwnershipStatus/recordManagedProfile, none of which have their own
  // try/catch) can throw on unexpected input -- e.g. a malformed agent
  // frontmatter file or a corrupt ownership sidecar racing a concurrent
  // writer. This function is documented as "never throws" and runs
  // automatically on every session_start/reload, so any unexpected exception
  // here must degrade to a logged skip, never an unhandled rejection that
  // could surface as a startup failure.
  try {
    await syncRolesInner(cwd);
  } catch (err) {
    console.warn(`[ollama-mke-role-sync] unexpected error, skipping this pass: ${err instanceof Error ? err.message : err}`);
  }
}

async function syncRolesInner(cwd: string): Promise<void> {
  // Opt-in, not opt-out: a shared team install may have a harness (e.g.
  // gentle-ai/gentle-pi) that already owns role -> model routing via its own
  // reapplied config. This extension must not write subagents.json unless an
  // operator explicitly asks for it here.
  if ((process.env.OLLAMA_MKE_ROLE_SYNC ?? "").toLowerCase() !== "on") return;

  const preset = resolvePreset();

  let catalog;
  try {
    catalog = await fetchCatalog();
  } catch (err) {
    console.warn(`[ollama-mke-role-sync] gateway catalog unavailable, skipping: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (catalog.length === 0) {
    console.warn("[ollama-mke-role-sync] gateway returned no priced models, skipping.");
    return;
  }

  let config;
  try {
    config = loadSubagentsConfig();
  } catch (err) {
    console.warn(`[ollama-mke-role-sync] cannot load subagents.json, skipping: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const roles = resolveRoles(config, cwd);
  const plan = buildPresetPlan(preset, catalog, roles);
  if (typeof plan === "string") {
    // No usable model at this tier (e.g. no reasoning-capable model for deep
    // roles). Same rule as a manual preset run: refuse rather than silently
    // downgrade a deep role to a non-reasoning model.
    console.warn(`[ollama-mke-role-sync] preset "${preset}" not applicable: ${plan}`);
    return;
  }

  const ownershipBefore = loadRoleOwnership();
  const applicable: PresetPlanEntry[] = [];
  const skipped: Array<{ entry: PresetPlanEntry; status: OwnershipStatus }> = [];
  for (const p of plan) {
    const status = computeOwnershipStatus(ownershipBefore, p.role, config.model_profiles?.[p.role]);
    if (status === "custom" || status === "stale-managed") skipped.push({ entry: p, status });
    else applicable.push(p);
  }

  if (applicable.length === 0) {
    console.log(`[ollama-mke-role-sync] preset "${preset}": nothing to apply (${skipped.length} role(s) are custom/stale-managed).`);
    return;
  }

  config.model_profiles ??= {};
  let ownershipAfter = ownershipBefore;
  for (const p of applicable) {
    const profile = { model: providerQualifiedModelId(p.model), effort: p.effort };
    config.model_profiles[p.role] = profile;
    ownershipAfter = recordManagedProfile(ownershipAfter, p.role, profile);
  }

  try {
    saveSubagentsConfig(config);
    saveRoleOwnership(ownershipAfter);
  } catch (err) {
    console.warn(`[ollama-mke-role-sync] failed to persist role profiles: ${err instanceof Error ? err.message : err}`);
    return;
  }

  console.log(
    `[ollama-mke-role-sync] preset "${preset}" applied to ${applicable.length} role(s)` +
      (skipped.length ? ` (${skipped.length} skipped: custom/stale-managed)` : "") +
      ". Run /roles to review or override."
  );
}

export default function roleSyncExtension(pi: ExtensionAPI): void {
  // SessionStartEvent carries no cwd field; the process cwd is the same
  // signal model-config.ts's /roles command uses (process.cwd()).
  pi.on("session_start", async () => {
    await syncRoles(process.cwd());
  });
}

// Exported for tests only -- pi consumes the default export.
export { syncRoles, resolvePreset };
