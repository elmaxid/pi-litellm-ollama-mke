# pi-litellm-ollama-mke

A fork of [xec-abailey/pi-litellm](https://github.com/xec-abailey/pi-litellm), adapted for the internal **ollama-mke** LiteLLM gateway.

## What changed from upstream

- The Pi provider ID is renamed from `litellm` to `ollama-mke`.
- Primary environment variables are `OLLAMA_MKE_BASE_URL` and `OLLAMA_MKE_API_KEY`. Legacy `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `providers.litellm` remain supported as migration fallbacks.
- A dependency-free guided setup CLI, `bin/setup.mjs`, accepts or prompts for the gateway URL and API key, validates `/v1/models`, lists discovered models, writes `providers["ollama-mke"]` to `models.json`, and adds this package to `settings.json`'s `packages` array.

This lets a fresh development workstation go from “Pi installed” to “ollama-mke configured and models synced” in one guided step.

## Features

- **Model Sync** — Fetches the live `/v1/models` list at startup and on `/reload`, then registers exact gateway model IDs under the `ollama-mke` provider. It uses advertised token limits where available and supports manual overrides. It also keeps `enabledModels` in `settings.json` from silently hiding new gateway models from `/model` and cycling — see [Seeing only some ollama-mke models in `/model`](#seeing-only-some-ollama-mke-models-in-model) below.
- **Cost Tracking** — Uses the gateway's `x-litellm-response-cost` header or `/model/info` pricing to replace Pi's static cost calculation for `ollama-mke` requests.
- **Session Grouping** — Adds `litellm_session_id` to outbound requests so calls from one Pi session are grouped in LiteLLM gateway logs.
- **Role Config TUI (`/roles`)** — A visual, menu-driven editor for which model and thinking effort each agent role uses, with one-command presets backed by fixed model tiers.
- **Automatic Role Sync** — Optional (off by default, `OLLAMA_MKE_ROLE_SYNC=on` to enable) — runs the same preset logic as /roles' "Apply preset" automatically on every Pi startup and /reload, so newly discovered agent roles get a model/effort profile without a manual /roles visit. Ownership-aware; a harness like gentle-ai/gentle-pi is often the routing authority instead, which is why this defaults off. See [Automatic Role Sync](#automatic-role-sync).

## Installation

### Guided setup (recommended)

This repository is installed from Git, not npm. Install it first:

```sh
pi install git:github.com/elmaxid/pi-litellm-ollama-mke
```

Then run its guided setup CLI. A `git:` package is cloned by Pi under `~/.pi/agent/git/<host>/<path>` for a user installation (or `.pi/git/<host>/<path>` for a project installation) — it does **not** live under `node_modules/`.

```sh
node ~/.pi/agent/git/github.com/elmaxid/pi-litellm-ollama-mke/bin/setup.mjs \
  --base-url http://<gateway-host>:4000 \
  --api-key <gateway-api-key>
```

You can omit either credential flag to be prompted interactively:

```sh
node ~/.pi/agent/git/github.com/elmaxid/pi-litellm-ollama-mke/bin/setup.mjs
```

The CLI validates `GET /v1/models`, previews the discovered models and configuration (with the API key masked), asks for confirmation, then writes `providers["ollama-mke"]` to `~/.pi/agent/models.json`. It backs up every configuration file before writing.

Restart Pi or run `/reload` after setup. Use `/model` to select one of the discovered `ollama-mke` models for the session.

## Setup CLI flags

| Flag | Description |
| --- | --- |
| `--base-url <url>` | Gateway base URL. |
| `--api-key <key>` | Gateway API key. |
| `--scope <user|project>` | Target user configuration or `.pi` configuration in the current project; defaults to `user`. |
| `--yes` | Apply changes without a confirmation prompt. |
| `--package-source <source>` | Package source string added to `settings.json`; defaults to this package's absolute path. |
| `--help` | Print usage. |

## Configuration

The extensions resolve settings in this priority: primary environment variables, legacy environment variables, `providers["ollama-mke"]`, legacy `providers.litellm`, then defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `OLLAMA_MKE_BASE_URL` | `http://localhost:4000` | Base URL of the ollama-mke LiteLLM gateway. |
| `OLLAMA_MKE_API_KEY` | `sk-cedar-local` | API key sent as a Bearer token to the gateway. |
| `LITELLM_BASE_URL` | — | Legacy fallback for `OLLAMA_MKE_BASE_URL`. |
| `LITELLM_API_KEY` | — | Legacy fallback for `OLLAMA_MKE_API_KEY`. |

Example `~/.pi/agent/models.json` configuration:

### `/roles` — role model & effort TUI

Running `/roles` inside Pi opens a menu-driven editor for `~/.pi/agent/subagents.json`, the file gentle-pi and Pi subagents use for per-role model routing (`model_profiles`, `default_model`, `default_effort`).

What it can do:

- **View / edit roles** — lists every discovered role (agent `.md` definitions plus existing `model_profiles` entries) with its *effective* model and effort, where the value comes from (`model_profiles` beat agent frontmatter, which beats the defaults), and its **ownership status**: `[managed by preset]` (a prior preset wrote it and nothing has changed since), `[custom]` (you set it, or it predates ownership tracking), or `[stale-managed — edited since last preset]` (a preset wrote it once, but it was hand-edited afterward). No tag means the role has no explicit profile yet (fully inherited).
- **Change a role's model or effort** — pick from the live gateway catalog (marked with `[R]` for reasoning support and per-million input cost); efforts span `off, minimal, low, medium, high, xhigh`. A role's profile can also be cleared so it inherits again. Any manual edit here always marks the role `custom` (even if a preset had written it before) — hand-editing a role is always your decision, and a later preset run will never overwrite it silently.
- **Defaults** — edit `default_model` and `default_effort`.
- **Apply preset** — `cheap`, `balanced`, or `quality` reassigns eligible roles at once, using the fixed model tiers below (not a cost-percentile scan of the whole catalog). Deep roles (proposal, design, verify, review, judge, research) always get the Claude side of their tier; standard/light roles get the Codex side. Deep roles **require** a gateway-confirmed reasoning-capable model; if the tier's model is not currently confirmed reasoning-capable, or is missing from the live catalog, the preset refuses to run for that role class rather than silently assigning a non-reasoning model or inventing a substitute. **Ownership-aware**: a preset only ever touches roles that are unset or still match what a prior preset wrote; any role marked `custom` or `stale-managed` is skipped and listed by name in the summary — presets never overwrite a hand-configured role.

Capability facts come only from the gateway (`/model/info` `supports_reasoning` / `supports_*_reasoning_effort`) or an explicit `modelOverrides` entry — never from guessing off a model's name. A flag the gateway does not publish is treated as *unknown*, not as *supported*: `/roles` will not promise an effort level the backend never confirmed, and manually setting a role's effort is rejected (with an explanation) when the selected model's catalog entry explicitly denies that level or lacks confirmed reasoning.

Every write shows a summary first, creates a timestamped `subagents.json.bak-*` backup, and preserves any unknown keys already in the file. Changes apply to agents launched afterwards.

#### Fixed model tiers

Instead of scanning the whole gateway catalog by cost percentile (which kept landing on outdated same-family model versions, or on gateway-confirmed free/non-reasoning models for lighter roles), presets pick from four explicitly curated tiers. Each tier pairs one Claude-family model with one Codex-family model at a comparable capability point:

| Tier | Claude side | Codex side |
| --- | --- | --- |
| T1 (lightest) | `claude-haiku-4-5` | `codex-gpt56-luna` |
| T2 (standard) | `claude-sonnet-5` | `codex-gpt56-terra` |
| T3 (high) | `claude-opus-5` | `codex-gpt56-sol` |
| T4 (top) | `claude-fable-5-1` | `codex-gpt6-astra` |

Preset → tier mapping per role class:

| Preset | deep | standard | light |
| --- | --- | --- | --- |
| `cheap` | T1 | T1 | T1 |
| `balanced` | T3 | T2 | T1 |
| `quality` | T4 | T3 | T2 |

Deep roles always resolve to the tier's Claude-side id; standard and light roles resolve to the Codex-side id. These ids are curated for this gateway's catalog — if your gateway's catalog uses different model names, edit `MODEL_TIERS` in `extensions/model-config.ts` (also used by `extensions/role-sync.ts`).

```json
{
  "providers": {
    "ollama-mke": {
      "baseUrl": "http://gateway.example:4000",
      "apiKey": "your-key",
      "api": "openai-completions"
    }
  }
}
```

### `modelOverrides`

The model-sync extension accepts per-model overrides at `providers["ollama-mke"].modelOverrides`. These have the highest precedence and are useful when gateway metadata does not advertise accurate token limits or reasoning support.

```json
{
  "providers": {
    "ollama-mke": {
      "modelOverrides": {
        "bedrock/claude-sonnet-4.6": {
          "contextWindow": 200000,
          "maxTokens": 16384,
          "reasoning": true,
          "thinkingLevelMap": { "medium": "medium", "high": "high", "xhigh": null }
        }
      }
    }
  }
}
```

A gateway model id like `bedrock/claude-sonnet-4.6` already contains a `/` from LiteLLM's own routing — that is NOT the same as being prefixed with Pi's `ollama-mke` provider key. `/roles` and the sync extension both qualify it correctly as `ollama-mke/bedrock/claude-sonnet-4.6` when writing profiles, so `modelOverrides` keys should use the raw gateway id (as shown above), not the Pi-qualified one.

### Role profile ownership

`extensions/role-ownership.ts` adds a sidecar at `~/.pi/agent/gentle-ai/role-profiles.json` that records which `model_profiles` entries `/roles`' "Apply preset" last wrote (`managed`), versus profiles that already existed or were hand-edited since (`custom` / `stale-managed`). It never becomes the source of truth — `subagents.json` stays authoritative — and it never overwrites a profile it did not itself record writing.

Both `/roles` views use it: "View / edit roles" shows each role's ownership status, and "Apply preset" only writes roles that are unset or still `managed`, skipping `custom`/`stale-managed` roles and listing them in the summary. Any manual model/effort edit through `/roles` immediately marks that role `custom`, so a later preset never re-adopts it without an explicit human action first. Global scope only for now; project-scoped `<cwd>/.pi/subagents.json` profiles are explicitly out of scope until a later phase.

## Automatic Role Sync

`extensions/role-sync.ts` can run the exact same preset logic as `/roles`' "Apply preset" automatically on every Pi startup and `/reload` (the `session_start` event), so agent roles installed later (by `gentle-ai sync`, a project's `.pi/agents`, etc.) get a model/effort profile without a manual `/roles` visit.

**Off by default.** On a shared team install, a harness such as [gentle-pi](https://github.com/Gentleman-Programming/gentle-pi) is frequently already the authority for role → model routing: it persists its own routing (e.g. `~/.pi/gentle-ai/models.json`) and reapplies it on every `session_start`, writing the same `subagents.json` this extension would touch. Two auto-appliers racing to own the same file on every startup is exactly the kind of silent config drift a shared install cannot afford — most operators on a team install have not asked for this extension's routing opinion, so it stays inert unless explicitly turned on.

- **Enable**: `OLLAMA_MKE_ROLE_SYNC=on`.
- **Default preset**: `balanced`. Override with `OLLAMA_MKE_ROLE_SYNC_PRESET=cheap|balanced|quality`.
- **Same safety guarantees as a manual "Apply preset" run**: ownership-aware (never touches a `custom`/`stale-managed` role), deep roles require a gateway-confirmed reasoning-capable model (skips rather than degrading silently), timestamped `subagents.json.bak-*` backup before every write, and unknown keys preserved.
- **Never blocks startup**: every failure mode (gateway unreachable, no usable tier model, corrupt config) logs a warning and skips this pass; it never throws out of `session_start`.

If your team's routing authority is gentle-ai/gentle-pi (`/gentle:models`, `/gentle:profiles`), leave this off and let this package do only what it does unconditionally: keep the `ollama-mke` model catalog (`extensions/litellm-sync.ts`) in sync with the gateway, so gentle-ai always has the current model list to route to. Only opt in here on an install where this package itself is meant to own role routing; running `/roles` afterward still works the same way to review or hand-edit any role.

## Seeing only ollama-mke in `/model` or `--list-models`

Pi ships several **built-in** providers (OpenAI, Anthropic, OpenRouter, Google, etc. — not packages, they come with the Pi binary) that activate automatically whenever Pi detects the matching credential environment variable, regardless of this package. If you only want to see `ollama-mke`, make sure none of these are set in your shell (check with `env | grep -E "_API_KEY|_TOKEN"`):

- `OPENAI_API_KEY` / `OPENAI_BASE_URL` → activates the built-in `openai` provider
- `OPENROUTER_API_KEY` → activates the built-in `openrouter` provider
- `ANTHROPIC_API_KEY` → activates the built-in `anthropic` provider
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` → activates the built-in `google` provider

Comment out or remove those exports from `~/.bashrc` (or wherever your shell sets them) if they are not otherwise needed, then open a **new** shell — an already-running shell keeps the environment variables it loaded at startup, so editing the dotfile alone will not affect a session already open. This is unrelated to `providers["ollama-mke"]` in `models.json`, which only ever adds the `ollama-mke` provider and never removes another one.

## Seeing only some ollama-mke models in `/model`

Pi's own `settings.json` has a separate, unrelated filter: `enabledModels` (documented under [Settings](https://pi.dev, see `docs/settings.md#model-cycling`) and driven by the `/scoped-models` command). It controls both the `/model` startup picker and `Ctrl+P` cycling, on top of whatever the provider itself registers. A `models.json` written by an older `bin/setup.mjs`, or a manually curated `/scoped-models` selection, can leave `enabledModels` as a closed list of specific `ollama-mke/<id>` entries. Because that list is static, it silently goes stale every time the gateway adds a new model: the model sync extension (`extensions/litellm-sync.ts`) registers the new id correctly, but `/model` and cycling still filter it out because `enabledModels` never mentions it. The plugin looks broken even though the provider registration is fine.

Every model sync run (startup and `/reload`) now reconciles this automatically, ownership-aware (mirroring `/roles`' preset ownership tracking):

- If `enabledModels` is absent, empty, or already contains the `"ollama-mke/*"` wildcard, nothing is touched — every gateway model is already visible.
- If `enabledModels` is a closed list that this plugin itself wrote before (tracked in `~/.pi/agent/gentle-ai/enabled-models-ownership.json`), it is automatically rewritten to `["ollama-mke/*"]` so every current and future gateway model stays visible without needing another `/scoped-models` visit. A timestamped `settings.json.bak-*` backup is written first.
- If `enabledModels` is a closed list this plugin never recorded writing — a hand-curated `/scoped-models` selection, or the output of a `setup.mjs` version older than this feature — it is left untouched. A one-time console warning explains how to add `"ollama-mke/*"` to `enabledModels` in `~/.pi/agent/settings.json` manually if you want every gateway model to stay visible automatically.

This reconciliation ships in the plugin itself, so it reaches every install on the next `pi update` / `/reload` without re-running `bin/setup.mjs` on each workstation. `bin/setup.mjs` also writes the wildcard directly for brand-new installs, so a fresh setup never needs this runtime fallback at all.

## Local Extension Development

Clone this repository to the expected local path:

```sh
git clone https://github.com/elmaxid/pi-litellm-ollama-mke.git ~/projects/pi-litellm-ollama-mke
```

Then use the dev-mode switcher to point Pi at the local checkout, return to the Git package, or inspect the active source:

```sh
scripts/dev.sh local
scripts/dev.sh git
scripts/dev.sh status
```

Restart Pi or run `/reload` after switching sources.

## License

MIT.

## Credits

Based on xec-abailey/pi-litellm.
