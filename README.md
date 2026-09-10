# pi-litellm-ollama-mke

A fork of [xec-abailey/pi-litellm](https://github.com/xec-abailey/pi-litellm), adapted for the internal **ollama-mke** LiteLLM gateway.

## What changed from upstream

- The Pi provider ID is renamed from `litellm` to `ollama-mke`.
- Primary environment variables are `OLLAMA_MKE_BASE_URL` and `OLLAMA_MKE_API_KEY`. Legacy `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `providers.litellm` remain supported as migration fallbacks.
- A dependency-free guided setup CLI, `bin/setup.mjs`, accepts or prompts for the gateway URL and API key, validates `/v1/models`, lists discovered models, writes `providers["ollama-mke"]` to `models.json`, and adds this package to `settings.json`'s `packages` array.

This lets a fresh development workstation go from “Pi installed” to “ollama-mke configured and models synced” in one guided step.

## Features

- **Model Sync** — Fetches the live `/v1/models` list at startup and on `/reload`, then registers exact gateway model IDs under the `ollama-mke` provider. It uses advertised token limits where available and supports manual overrides.
- **Cost Tracking** — Uses the gateway's `x-litellm-response-cost` header or `/model/info` pricing to replace Pi's static cost calculation for `ollama-mke` requests.
- **Session Grouping** — Adds `litellm_session_id` to outbound requests so calls from one Pi session are grouped in LiteLLM gateway logs.

## Installation

### Quick guided setup

```sh
npx pi-litellm-ollama-mke --base-url http://<gateway-host>:4000 --api-key <key>
```

When either credential flag is omitted, the CLI prompts interactively. Restart Pi or run `/reload` after setup.

### Manual installation

```sh
pi install git:github.com/elmaxid/pi-litellm-ollama-mke
```

Configure `providers["ollama-mke"]` manually in `~/.pi/agent/models.json` as shown below, or run the installer from the installed package. `pi install` for a `git:` source clones it under `~/.pi/agent/git/<host>/<path>` (user scope) or `.pi/git/<host>/<path>` (project scope) — not `node_modules/`, which is npm-only:

```sh
node ~/.pi/agent/git/github.com/elmaxid/pi-litellm-ollama-mke/bin/setup.mjs
```

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
          "reasoning": true
        }
      }
    }
  }
}
```

## Seeing only ollama-mke in `/model` or `--list-models`

Pi ships several **built-in** providers (OpenAI, Anthropic, OpenRouter, Google, etc. — not packages, they come with the Pi binary) that activate automatically whenever Pi detects the matching credential environment variable, regardless of this package. If you only want to see `ollama-mke`, make sure none of these are set in your shell (check with `env | grep -E "_API_KEY|_TOKEN"`):

- `OPENAI_API_KEY` / `OPENAI_BASE_URL` → activates the built-in `openai` provider
- `OPENROUTER_API_KEY` → activates the built-in `openrouter` provider
- `ANTHROPIC_API_KEY` → activates the built-in `anthropic` provider
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` → activates the built-in `google` provider

Comment out or remove those exports from `~/.bashrc` (or wherever your shell sets them) if they are not otherwise needed, then open a **new** shell — an already-running shell keeps the environment variables it loaded at startup, so editing the dotfile alone will not affect a session already open. This is unrelated to `providers["ollama-mke"]` in `models.json`, which only ever adds the `ollama-mke` provider and never removes another one.

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
