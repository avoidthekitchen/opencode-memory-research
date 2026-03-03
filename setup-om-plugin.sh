#!/bin/bash

set -euo pipefail

echo "Observational Memory Plugin Setup"
echo "================================="
echo ""

if [ -z "${1:-}" ]; then
  read -r -p "Enter the path to your repository: " TARGET_DIR
else
  TARGET_DIR="$1"
fi

if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Directory '$TARGET_DIR' does not exist"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$SCRIPT_DIR"
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
UPDATE_MODE="${OM_PLUGIN_UPDATE_MODE:-prompt}"

SOURCE_PLUGIN="$SOURCE_ROOT/.opencode/plugins/observational-memory.ts"
SOURCE_CONFIG="$SOURCE_ROOT/.opencode/observational-memory.json"
SOURCE_PACKAGE_JSON="$SOURCE_ROOT/.opencode/package.json"
SOURCE_STATUS_SCRIPT="$SOURCE_ROOT/scripts/om-status.mjs"
SOURCE_SMOKE_SCRIPT="$SOURCE_ROOT/scripts/smoke-om-plugin.mjs"

TARGET_PLUGIN="$TARGET_DIR/.opencode/plugins/observational-memory.ts"
TARGET_CONFIG="$TARGET_DIR/.opencode/observational-memory.json"
TARGET_PACKAGE_JSON="$TARGET_DIR/.opencode/package.json"
TARGET_STATUS_SCRIPT="$TARGET_DIR/scripts/om-status.mjs"
TARGET_SMOKE_SCRIPT="$TARGET_DIR/scripts/smoke-om-plugin.mjs"

if [ "$UPDATE_MODE" = "prompt" ] && [ -f "$TARGET_PLUGIN" ]; then
  echo "An observational-memory plugin already exists in $TARGET_DIR"
  echo ""
  echo "What would you like to do?"
  echo "1) Update plugin files"
  echo "2) Skip existing plugin files"
  echo "3) Cancel"
  read -r -p "Choose option (1/2/3): " INSTALL_OPTION
  case "$INSTALL_OPTION" in
    1)
      UPDATE_MODE="overwrite"
      ;;
    2)
      UPDATE_MODE="skip"
      ;;
    *)
      echo "Setup cancelled"
      exit 0
      ;;
  esac
fi

if [ "$UPDATE_MODE" = "prompt" ]; then
  UPDATE_MODE="skip"
fi

mkdir -p "$TARGET_DIR/.opencode/plugins"
mkdir -p "$TARGET_DIR/scripts"

copy_file() {
  local source_file="$1"
  local target_file="$2"
  local label="$3"

  if [ -f "$target_file" ]; then
    if [ "$UPDATE_MODE" = "overwrite" ]; then
      cp "$source_file" "$target_file"
      echo "Updated $label"
    else
      echo "Kept existing $label"
    fi
  else
    cp "$source_file" "$target_file"
    echo "Installed $label"
  fi
}

copy_file "$SOURCE_PLUGIN" "$TARGET_PLUGIN" ".opencode/plugins/observational-memory.ts"
copy_file "$SOURCE_STATUS_SCRIPT" "$TARGET_STATUS_SCRIPT" "scripts/om-status.mjs"
copy_file "$SOURCE_SMOKE_SCRIPT" "$TARGET_SMOKE_SCRIPT" "scripts/smoke-om-plugin.mjs"

if [ -f "$TARGET_CONFIG" ]; then
  echo ""
  read -r -p ".opencode/observational-memory.json already exists. Replace it with this repo's defaults? (y/N): " REPLACE_CONFIG
  if [ "$REPLACE_CONFIG" = "y" ] || [ "$REPLACE_CONFIG" = "Y" ]; then
    cp "$SOURCE_CONFIG" "$TARGET_CONFIG"
    echo "Updated .opencode/observational-memory.json"
  else
    echo "Kept existing .opencode/observational-memory.json"
  fi
else
  cp "$SOURCE_CONFIG" "$TARGET_CONFIG"
  echo "Installed .opencode/observational-memory.json"
fi

mkdir -p "$TARGET_DIR/.opencode"

SOURCE_PACKAGE_JSON="$SOURCE_PACKAGE_JSON" TARGET_PACKAGE_JSON="$TARGET_PACKAGE_JSON" UPDATE_MODE="$UPDATE_MODE" TARGET_DIR="$TARGET_DIR" node <<'EOF'
const fs = require("node:fs")
const path = require("node:path")

const sourcePath = process.env.SOURCE_PACKAGE_JSON
const targetPath = process.env.TARGET_PACKAGE_JSON
const updateMode = process.env.UPDATE_MODE
const targetDir = process.env.TARGET_DIR

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"))
let target
if (fs.existsSync(targetPath)) {
  target = JSON.parse(fs.readFileSync(targetPath, "utf8"))
} else {
  target = {
    name: `${path.basename(targetDir)}-local-plugins`,
    private: true,
    type: "module",
    dependencies: {},
  }
}

if (!target.type) target.type = "module"
if (target.private === undefined) target.private = true
if (!target.dependencies) target.dependencies = {}

for (const [name, version] of Object.entries(source.dependencies || {})) {
  if (updateMode === "overwrite" || !(name in target.dependencies)) {
    target.dependencies[name] = version
  }
}

fs.writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`, "utf8")
EOF

echo "Merged plugin dependencies into .opencode/package.json"

if command -v npm >/dev/null 2>&1; then
  echo "Installing .opencode dependencies with npm..."
  (
    cd "$TARGET_DIR/.opencode"
    npm install
  )
else
  echo "npm not found; skipped dependency installation"
  echo "Run 'cd \"$TARGET_DIR/.opencode\" && npm install' before using the plugin"
fi

echo ""
echo "Setup complete"
echo ""
echo "Next steps:"
echo "1. Run OpenCode from: $TARGET_DIR"
echo "2. Check plugin status with:"
echo "   node --experimental-strip-types scripts/om-status.mjs <session-id>"
echo "3. Smoke test the installed plugin with:"
echo "   node --experimental-strip-types scripts/smoke-om-plugin.mjs"
