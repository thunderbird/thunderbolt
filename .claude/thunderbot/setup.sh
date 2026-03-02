#!/bin/bash
set -euo pipefail

echo "=== Thunderbolt Bot Setup ==="
echo ""

# Check for Homebrew
if ! command -v brew &>/dev/null; then
  echo "ERROR: Homebrew is required. Install from https://brew.sh"
  exit 1
fi

# Install OrbStack (Docker runtime)
if ! command -v docker &>/dev/null; then
  echo "Installing OrbStack (Docker runtime)..."
  brew install orbstack
  echo "Please open OrbStack.app to complete setup, then re-run this script."
  exit 0
else
  echo "Docker already available: $(docker --version)"
fi

# Verify Docker Compose
if ! docker compose version &>/dev/null; then
  echo "ERROR: Docker Compose not available. Ensure OrbStack or Docker Desktop is running."
  exit 1
fi
echo "Docker Compose: $(docker compose version --short)"

# Install linear-cli
if ! command -v linear &>/dev/null; then
  echo "Installing linear-cli..."
  brew install schpet/tap/linear
else
  echo "linear-cli already installed: $(linear --version 2>/dev/null || echo 'installed')"
fi

# Check linear auth
echo ""
echo "Checking Linear authentication..."
if ! linear issue list --limit 1 &>/dev/null 2>&1; then
  echo "Linear not authenticated. Running login..."
  linear auth login
  echo ""
  echo "Configure your default team/workspace:"
  linear config
else
  echo "Linear authenticated."
fi

# Check GitHub CLI
if ! command -v gh &>/dev/null; then
  echo "Installing GitHub CLI..."
  brew install gh
else
  echo "GitHub CLI: $(gh --version | head -1)"
fi

if ! gh auth status &>/dev/null 2>&1; then
  echo "GitHub CLI not authenticated. Run: gh auth login"
  exit 1
fi
echo "GitHub CLI authenticated."

# Check Claude Code
if ! command -v claude &>/dev/null; then
  echo "WARNING: Claude Code CLI not found. Install from https://docs.anthropic.com/en/docs/claude-code"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Usage:"
echo "  /thunderbot              - Auto-select and work a Linear task"
echo "  /thunderbot THU-123      - Work a specific task"
echo "  /thunderbot-daemon start - Start background daemon"
