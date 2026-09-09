#!/usr/bin/env bash
# pi-litellm-ollama-mke dev mode switcher
#
# Switch Pi between this local checkout and the published Git package source.

set -euo pipefail

REPO_URL="https://github.com/elmaxid/pi-litellm-ollama-mke.git"
LOCAL_DIR="$HOME/projects/pi-litellm-ollama-mke"
GIT_SOURCE="git:github.com/elmaxid/pi-litellm-ollama-mke"
SETTINGS_FILE="$HOME/.pi/agent/settings.json"

usage() {
  cat <<EOF
Usage: $(basename "$0") <local|git|status>

  local   Use the local checkout at $LOCAL_DIR
  git     Use the Git package source ($GIT_SOURCE)
  status  Show the active package source
EOF
}

update_source() {
  local source="$1"
  node - "$SETTINGS_FILE" "$source" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const source = process.argv[3];
const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
config.packages = Array.isArray(config.packages) ? config.packages : [];
const knownSources = [process.env.LOCAL_DIR, process.env.GIT_SOURCE].filter(Boolean);
config.packages = config.packages.filter((entry) => !knownSources.includes(entry));
config.packages.push(source);
fs.mkdirSync(require("path").dirname(path), { recursive: true });
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
NODE
}

case "${1:-}" in
  local)
    if [[ ! -d "$LOCAL_DIR" ]]; then
      echo "Local checkout not found: $LOCAL_DIR" >&2
      echo "Clone it with: git clone $REPO_URL $LOCAL_DIR" >&2
      exit 1
    fi
    LOCAL_DIR="$LOCAL_DIR" GIT_SOURCE="$GIT_SOURCE" update_source "$LOCAL_DIR"
    echo "Pi now uses local package: $LOCAL_DIR"
    ;;
  git)
    LOCAL_DIR="$LOCAL_DIR" GIT_SOURCE="$GIT_SOURCE" update_source "$GIT_SOURCE"
    echo "Pi now uses Git package: $GIT_SOURCE"
    ;;
  status)
    if [[ ! -f "$SETTINGS_FILE" ]]; then
      echo "No Pi settings file found at $SETTINGS_FILE"
      exit 0
    fi
    node - "$SETTINGS_FILE" "$LOCAL_DIR" "$GIT_SOURCE" <<'NODE'
const fs = require("fs");
const [path, local, git] = process.argv.slice(2);
const packages = JSON.parse(fs.readFileSync(path, "utf8")).packages || [];
if (packages.includes(local)) console.log(`Local mode: ${local}`);
else if (packages.includes(git)) console.log(`Git mode: ${git}`);
else console.log("pi-litellm-ollama-mke is not configured in packages.");
NODE
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
