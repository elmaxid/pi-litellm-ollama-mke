#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_PACKAGE_SOURCE = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const usage = `Usage: pi-litellm-ollama-mke [options]

Configure Pi to use the ollama-mke LiteLLM gateway.

Options:
  --base-url <url>         Gateway base URL
  --api-key <key>          Gateway API key
  --scope <user|project>   Configuration scope (default: user)
  --yes                    Apply changes without confirmation
  --package-source <src>   Package source to add to settings.json (default: this package)
  --help                   Show this help message
`;

function parseArgs(argv) {
  const options = { scope: "user", yes: false, packageSource: DEFAULT_PACKAGE_SOURCE };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--yes") options.yes = true;
    else if (["--base-url", "--api-key", "--scope", "--package-source"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--base-url") options.baseUrl = value;
      if (arg === "--api-key") options.apiKey = value;
      if (arg === "--scope") options.scope = value;
      if (arg === "--package-source") options.packageSource = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["user", "project"].includes(options.scope)) {
    throw new Error('--scope must be either "user" or "project".');
  }
  return options;
}

function normalizeBaseUrl(value) {
  let normalized = value.trim().replace(/\/+$/, "");
  if (/\/v1$/i.test(normalized)) normalized = normalized.slice(0, -3).replace(/\/+$/, "");
  if (!normalized) throw new Error("Gateway base URL must not be empty.");
  return normalized;
}

function stripJsonCommentsAndTrailingCommas(raw) {
  return raw
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(stripJsonCommentsAndTrailingCommas(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`Could not parse existing ${path}: ${error.message}`);
  }
}

function maskKey(key) {
  return key.length < 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-2)}`;
}

function backupAndWrite(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  let backup;
  if (existsSync(path)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `${path}.bak-${timestamp}`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  return backup;
}

async function promptForMissing(options) {
  if (options.baseUrl && options.apiKey) return;
  if (!process.stdin.isTTY) {
    throw new Error("Both --base-url and --api-key are required in non-interactive mode.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!options.baseUrl) {
      options.baseUrl = await rl.question(
        "Ollama-mke gateway base URL (e.g. http://10.50.1.67:4000): "
      );
    }
    if (!options.apiKey) {
      options.apiKey = await rl.question("Ollama-mke gateway API key (input is not masked): ");
    }
  } finally {
    rl.close();
  }
}

async function validateGateway(baseUrl, apiKey) {
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Error(`Could not reach ${baseUrl}/v1/models: ${error.message}`);
  }

  if (!response.ok) {
    let snippet = "";
    try {
      snippet = (await response.text()).slice(0, 500);
    } catch {
      // The status is still enough context if the body cannot be read.
    }
    throw new Error(
      `Gateway validation failed: HTTP ${response.status}${snippet ? ` — ${snippet}` : ""}`
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Gateway returned invalid JSON from /v1/models: ${error.message}`);
  }
  if (!Array.isArray(payload.data)) {
    throw new Error("Gateway /v1/models response did not contain a data array.");
  }
  return payload.data;
}

async function confirm(options) {
  if (options.yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error("Use --yes to apply changes in non-interactive mode.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question("Apply these changes? [y/N] ")).trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  await promptForMissing(options);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = options.apiKey;
  if (!apiKey) throw new Error("Gateway API key must not be empty.");

  const models = await validateGateway(baseUrl, apiKey);
  if (models.length === 0) {
    console.warn("Warning: gateway returned no models; continuing because it may be temporarily empty.");
  }
  console.log(`Discovered ${models.length} model(s):`);
  for (const model of models.slice(0, 10)) console.log(`  - ${model.id}`);
  if (models.length > 10) console.log(`...and ${models.length - 10} more`);

  const configDir =
    options.scope === "user"
      ? join(homedir(), ".pi", "agent")
      : join(process.cwd(), ".pi");
  const modelsPath = join(configDir, "models.json");
  const settingsPath = join(configDir, "settings.json");
  const modelsConfig = readJson(modelsPath);
  const settingsConfig = readJson(settingsPath);

  if (!modelsConfig.providers || typeof modelsConfig.providers !== "object" || Array.isArray(modelsConfig.providers)) {
    modelsConfig.providers = {};
  }
  modelsConfig.providers["ollama-mke"] = {
    baseUrl,
    apiKey,
    api: "openai-completions",
  };

  // Keep the model picker (/model) and cycling (Ctrl+P) open to every
  // gateway model, including ones added after this setup ran. Without this,
  // Pi's own enabledModels filter in settings.json defaults to "everything"
  // when absent, but a prior manual /scoped-models selection or an older
  // setup run could have left it as a closed list that silently hides new
  // gateway models. Only set it when it does not already grant every
  // ollama-mke model, so we never clobber an existing wildcard or a list a
  // human already widened themselves; runtime reconciliation in
  // extensions/litellm-sync.ts also carries this forward on already-installed
  // configs (see README "Seeing only some ollama-mke models in /model").
  const currentEnabledModels = Array.isArray(settingsConfig.enabledModels)
    ? settingsConfig.enabledModels
    : undefined;
  const alreadyGrantsAllOllamaMkeModels =
    currentEnabledModels === undefined ||
    currentEnabledModels.length === 0 ||
    currentEnabledModels.includes("ollama-mke/*");
  const enabledModelsAdded = !alreadyGrantsAllOllamaMkeModels;
  if (enabledModelsAdded) settingsConfig.enabledModels = ["ollama-mke/*"];

  if (!Array.isArray(settingsConfig.packages)) settingsConfig.packages = [];
  const packageAdded = !settingsConfig.packages.includes(options.packageSource);
  if (packageAdded) settingsConfig.packages.push(options.packageSource);

  console.log("\nPlanned changes:");
  console.log(`  ${modelsPath}`);
  console.log('  providers["ollama-mke"] = {');
  console.log(`    baseUrl: ${baseUrl}`);
  console.log(`    apiKey: ${maskKey(apiKey)}`);
  console.log('    api: "openai-completions"');
  console.log("  }");
  console.log(`  ${settingsPath}`);
  console.log(
    packageAdded
      ? `  packages: add ${options.packageSource}`
      : `  packages: ${options.packageSource} already present (no addition)`
  );
  console.log(
    enabledModelsAdded
      ? '  enabledModels: set to ["ollama-mke/*"] so /model and Ctrl+P always show every gateway model'
      : "  enabledModels: already allows every ollama-mke model (no change)"
  );

  if (!(await confirm(options))) {
    console.log("No changes applied.");
    return;
  }

  const modelsBackup = backupAndWrite(modelsPath, modelsConfig);
  const settingsBackup = backupAndWrite(settingsPath, settingsConfig);
  console.log("\nConfiguration applied successfully:");
  console.log(`  wrote ${modelsPath}`);
  if (modelsBackup) console.log(`  backup ${modelsBackup}`);
  console.log(`  wrote ${settingsPath}`);
  if (settingsBackup) console.log(`  backup ${settingsBackup}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
