/**
 * Role profile ownership sidecar (phase 2, infrastructure only).
 *
 * Tracks which `model_profiles` entries in `~/.pi/agent/subagents.json` were
 * last written by this plugin's own automation (presets, future auto-apply),
 * versus profiles a human configured by hand — WITHOUT ever becoming the
 * source of truth for routing. `subagents.json` remains authoritative for Pi
 * and gentle-pi; this sidecar is purely a memory of "what did *we* last
 * write here", so a future automated apply can tell:
 *
 *   - "inherited"     — no explicit profile at all, safe to create one
 *   - "managed"       — we wrote it last, and it still matches, safe to update
 *   - "custom"        — a profile exists that we never recorded writing,
 *                        never touch it automatically
 *   - "stale-managed" — we wrote it once, but it no longer matches what's on
 *                        disk (a human edited it since), never silently
 *                        overwrite it
 *
 * Scope: global only for now — `~/.pi/agent/gentle-ai/role-profiles.json`,
 * mirroring `~/.pi/agent/subagents.json`. Project-scoped
 * `<cwd>/.pi/subagents.json` profiles are explicitly out of scope until a
 * later phase; do not extend this module to guess a project path.
 *
 * This module is infrastructure only: nothing in `/roles` (extensions/model-
 * config.ts) calls it yet. It exists so ownership tracking can be layered
 * onto presets/auto-apply in a follow-up change without redesigning the
 * storage format under time pressure, and so it can be reviewed and tested
 * in isolation first.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA = "gentle-pi.role-profiles/v1" as const;
const SCHEMA_VERSION = 1 as const;

/** Minimal profile shape this module fingerprints and tracks ownership for. */
export interface OwnedProfile {
  model?: string;
  effort?: string;
}

export type OwnershipMode = "managed";

export interface RoleOwnershipEntry {
  /** Always "managed" today: an entry existing at all means this plugin's
   *  automation wrote it at some point. Whether that write is still
   *  considered current is computeOwnershipStatus()'s job, not a stored
   *  field — storing a stale "custom" mode here would let a caller trust a
   *  disk value instead of recomputing it fresh. */
  mode: OwnershipMode;
  /** sha256 of the exact {model, effort} this plugin wrote last time. */
  appliedFingerprint: string;
  lastAppliedAt: string;
  /** Gateway capability catalog fingerprint used to decide the assignment,
   *  kept for future auditing (e.g. "this used pricing from before a model
   *  got repriced"). Optional: not every caller has one yet. */
  catalogFingerprint?: string;
}

export interface RoleProfilesSidecar {
  schema: typeof SCHEMA;
  schemaVersion: typeof SCHEMA_VERSION;
  generator: { name: string; version: string };
  roles: Record<string, RoleOwnershipEntry>;
}

/** Ownership status for one role, resolved against the CURRENT subagents.json
 *  profile. A future automated apply must branch on this before writing
 *  anything — never on the raw sidecar entry alone. */
export type OwnershipStatus = "inherited" | "managed" | "custom" | "stale-managed";

function sidecarPath(): string {
  return join(homedir(), ".pi", "agent", "gentle-ai", "role-profiles.json");
}

function emptySidecar(): RoleProfilesSidecar {
  return {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    generator: { name: "pi-litellm-ollama-mke", version: "0.1.0" },
    roles: {},
  };
}

/**
 * Load the ownership sidecar. Never throws: a missing, corrupt, or
 * schema-mismatched file degrades to an empty sidecar. With an empty
 * sidecar every role with an existing profile reads as "custom" from
 * computeOwnershipStatus() — the safe default. We would rather ask again
 * (or refuse to auto-touch a role) than silently adopt an unrecognized
 * profile as something "we" wrote.
 */
export function loadRoleOwnership(): RoleProfilesSidecar {
  const path = sidecarPath();
  if (!existsSync(path)) return emptySidecar();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schema === SCHEMA &&
      parsed.schemaVersion === SCHEMA_VERSION &&
      parsed.roles &&
      typeof parsed.roles === "object"
    ) {
      return parsed as RoleProfilesSidecar;
    }
  } catch {
    // Fall through to the empty sidecar below — never let a corrupt sidecar
    // throw and block /roles or any future automated apply.
  }
  return emptySidecar();
}

/**
 * Deterministic fingerprint of the fields ownership actually tracks. Field
 * order is fixed so the same {model, effort} always hashes the same way
 * regardless of how the caller constructed the object, and a missing field
 * is distinguished from an empty string (both normalize to `null`).
 */
export function fingerprintProfile(profile: OwnedProfile): string {
  const canonical = JSON.stringify({ model: profile.model ?? null, effort: profile.effort ?? null });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Resolve ownership status for one role given its CURRENT explicit profile
 * (as written in subagents.json's `model_profiles` — not the value resolved
 * after inheriting from an agent's .md frontmatter or global defaults;
 * ownership only ever tracks explicit `model_profiles` entries, because
 * those are the only thing an automated apply would write to).
 */
export function computeOwnershipStatus(
  sidecar: RoleProfilesSidecar,
  roleName: string,
  currentProfile: OwnedProfile | undefined
): OwnershipStatus {
  const hasProfile = Boolean(currentProfile?.model || currentProfile?.effort);
  const entry = sidecar.roles[roleName];

  if (!hasProfile) return "inherited";
  if (!entry) return "custom";

  const currentFingerprint = fingerprintProfile(currentProfile ?? {});
  return currentFingerprint === entry.appliedFingerprint ? "managed" : "stale-managed";
}

/**
 * Record that this plugin's automation just wrote `profile` for `roleName`.
 * Call this ONLY immediately after a successful write to subagents.json,
 * with the exact profile object that was written — never speculatively,
 * and never before the write is confirmed to have happened.
 */
export function recordManagedProfile(
  sidecar: RoleProfilesSidecar,
  roleName: string,
  profile: OwnedProfile,
  catalogFingerprint?: string
): RoleProfilesSidecar {
  return {
    ...sidecar,
    roles: {
      ...sidecar.roles,
      [roleName]: {
        mode: "managed",
        appliedFingerprint: fingerprintProfile(profile),
        lastAppliedAt: new Date().toISOString(),
        ...(catalogFingerprint ? { catalogFingerprint } : {}),
      },
    },
  };
}

/**
 * Stop tracking a role entirely — e.g. its profile was cleared/inherited
 * again, or a human explicitly asked to disown it so future automation
 * treats it as "custom" (untouched) again rather than "stale-managed".
 */
export function forgetRole(sidecar: RoleProfilesSidecar, roleName: string): RoleProfilesSidecar {
  if (!(roleName in sidecar.roles)) return sidecar;
  const rest: Record<string, RoleOwnershipEntry> = {};
  for (const [name, entry] of Object.entries(sidecar.roles)) {
    if (name !== roleName) rest[name] = entry;
  }
  return { ...sidecar, roles: rest };
}

/**
 * Persist the sidecar. Creates its parent directory and a timestamped backup
 * of any existing file first, mirroring subagents.json's backup discipline
 * in extensions/model-config.ts (never overwrite without a recovery copy).
 * Returns the backup path, or "" when there was nothing to back up.
 */
export function saveRoleOwnership(sidecar: RoleProfilesSidecar): string {
  const path = sidecarPath();
  mkdirSync(dirname(path), { recursive: true });
  let backupPath = "";
  if (existsSync(path)) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .replace(".", "-")
      .replace(/Z$/, "");
    backupPath = `${path}.bak-${stamp}`;
    for (let n = 1; existsSync(backupPath); n++) backupPath = `${path}.bak-${stamp}-${n}`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, `${JSON.stringify(sidecar, null, 2)}\n`);
  return backupPath;
}
