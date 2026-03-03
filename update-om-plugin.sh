#!/bin/bash

set -euo pipefail

echo "Observational Memory Plugin Update"
echo "=================================="
echo ""

if [ -z "${1:-}" ]; then
  if [ -d ".opencode" ]; then
    TARGET_DIR="."
    echo "Updating plugin in current directory"
  else
    read -r -p "Enter the path to your repository: " TARGET_DIR
  fi
else
  TARGET_DIR="$1"
fi

if [ ! -d "$TARGET_DIR" ]; then
  echo "Error: Directory '$TARGET_DIR' does not exist"
  exit 1
fi

if [ ! -d "$TARGET_DIR/.opencode" ]; then
  echo "Error: No .opencode directory found in '$TARGET_DIR'"
  echo "Run setup-om-plugin.sh first"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Running update process..."
echo ""

OM_PLUGIN_UPDATE_MODE=overwrite "$SCRIPT_DIR/setup-om-plugin.sh" "$TARGET_DIR"
