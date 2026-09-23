/**
 * enabledModels ownership sidecar for the ollama-mke provider.
 *
 * Pi's `settings.json` `enabledModels` list filters both the `/model`
 * startup selection and `Ctrl+P` cycling. When a human — or an old
 * `bin/setup.mjs` run before it managed this field — writes an explicit,
 * closed list of `ollama-mke/<id>` entries there, that list silently goes
 * stale every time the gateway's live catalog changes: a newly added
 * gateway model (see litellm-sync.ts's dynamic /v1/models registration)
 * never appears in `/model` or the cycle, because `enabledModels` still
 * only names the old ids. Nothing about the failure is visible; the plugin
 * looks broken even though the provider registration is correct.
 *
 * This module tracks — WITHOUT ever becoming the source of truth — whether
 * *this plugin's own automation* wrote the current `enabledModels` value:
 *
 *   - "unset"   — no enabledModels array at all (already means "every model
 *                 is enabled"; nothing to fix).
 *   - "managed" — the plugin wrote this exact value last time; safe to
 *                 re-normalize automatically on every sync.
 *   - "custom"  — some other value is present that this plugin never
 *                 recorded writing (hand-curated by a human, or written by
 *                 a `setup.mjs` version that predates this tracking); never
 *                 touch it automatically, only warn.
 *
 * Scope: global only — mirrors `~/.pi/agent/settings.json`. Project-scoped
 * `<cwd>/.pi/settings.json` overrides are out of scope; this module never
 * guesses a project path.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA = "pi-litellm-ollama-mke.enabled-models-ownership/v1" as const;
const SCHEMA_VERSION = 1 as const;

export interface EnabledModelsOwnershipSidecar {
  schema: typeof SCHEMA;
  schemaVersion: typeof SCHEMA_VERSION;
  generator: { name: string; version: string };
  /** sha256-free: enabledModels is small, so we store the exact array we
   *  last wrote and compare it verbatim rather than fingerprinting it. */
  lastWritten?: string[];
  lastWrittenAt?: string;
}

export type EnabledModelsOwnershipStatus = "unset" | "managed" | "custom";

function sidecarPath(): string {
  return join(homedir(), ".pi", "agent", "gentle-ai", "enabled-models-ownership.json");
}

function settingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

function emptySidecar(): EnabledModelsOwnershipSidecar {
  return {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    generator: { name: "pi-litellm-ollama-mke", version: "0.1.0" },
  };
}

function stripJsonCommentsAndTrailingCommas(raw: string): string {
  return raw
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/**
 * Load the ownership sidecar. Never throws: a missing, corrupt, or
 * schema-mismatched file degrades to an empty sidecar, which makes any
 * existing enabledModels value read as "custom" — the safe default. We
 * would rather warn (or refuse to auto-touch it) than silently adopt an
 * unrecognized value as something "we" wrote.
 */
export function loadEnabledModelsOwnership(): EnabledModelsOwnershipSidecar {
  const path = sidecarPath();
  if (!existsSync(path)) return emptySidecar();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.schema === SCHEMA &&
      parsed.schemaVersion === SCHEMA_VERSION
    ) {
      return parsed as EnabledModelsOwnershipSidecar;
    }
  } catch {
    // Fall through to the empty sidecar below.
  }
  return emptySidecar();
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Resolve ownership status for the CURRENT `enabledModels` value read fresh
 * from settings.json (never trust a cached copy — a human could have edited
 * the file since this plugin last ran).
 */
export function computeEnabledModelsStatus(
  sidecar: EnabledModelsOwnershipSidecar,
  currentEnabledModels: string[] | undefined
): EnabledModelsOwnershipStatus {
  if (currentEnabledModels === undefined || currentEnabledModels.length === 0) return "unset";
  return arraysEqual(currentEnabledModels, sidecar.lastWritten) ? "managed" : "custom";
}

/**
 * Read settings.json's enabledModels array as-is. Returns undefined when the
 * file is missing, unparseable, or the field is absent/not an array — all
 * of which behave like "unset" (every model enabled) to Pi itself, so we
 * must not treat a parse failure as "custom" and refuse to help.
 */
export function readCurrentEnabledModels(): string[] | undefined {
  const path = settingsPath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(raw));
    const value = parsed?.enabledModels;
    return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the current enabledModels value already grants every ollama-mke
 * model — either because it is unset (Pi's own "no filter" default) or
 * because it already contains the exact wildcard this plugin writes.
 */
export function alreadyGrantsAllOllamaMkeModels(currentEnabledModels: string[] | undefined): boolean {
  if (currentEnabledModels === undefined || currentEnabledModels.length === 0) return true;
  return currentEnabledModels.includes("ollama-mke/*");
}

/**
 * Rewrite settings.json's `enabledModels` to `["ollama-mke/*"]`, preserving
 * every other key. Creates a timestamped backup first, mirroring this
 * plugin's other config writers (model-config.ts, role-ownership.ts,
 * bin/setup.mjs). Returns the backup path, or "" when there was nothing to
 * back up. Throws if settings.json exists but cannot be parsed — callers
 * must not silently drop unknown keys by writing a fresh object.
 */
export function writeManagedEnabledModels(): { backupPath: string; written: string[] } {
  const path = settingsPath();
  const written = ["ollama-mke/*"];

  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8");
    config = JSON.parse(stripJsonCommentsAndTrailingCommas(raw));
  }
  config.enabledModels = written;

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
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return { backupPath, written };
}

/**
 * Persist that this plugin's automation just wrote `written` for
 * enabledModels. Call this ONLY immediately after a successful
 * writeManagedEnabledModels() call, with the exact array that was written.
 */
export function recordManagedEnabledModels(
  sidecar: EnabledModelsOwnershipSidecar,
  written: string[]
): EnabledModelsOwnershipSidecar {
  return {
    ...sidecar,
    lastWritten: written,
    lastWrittenAt: new Date().toISOString(),
  };
}

/**
 * Persist the sidecar. Creates its parent directory and a timestamped
 * backup of any existing file first, mirroring role-ownership.ts's backup
 * discipline (never overwrite without a recovery copy).
 */
export function saveEnabledModelsOwnership(sidecar: EnabledModelsOwnershipSidecar): string {
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
  writeFileSync(path, `${JSON.stringify(sidecar, null, 2)}\n`, "utf-8");
  return backupPath;
}
