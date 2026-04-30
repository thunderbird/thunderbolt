#!/usr/bin/env bash

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

set -euo pipefail

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

REPO_URL="${THUNDERBOT_REPO:-git@github.com:thunderbird/thunderbot.git}"
PREFIX=".thunderbot"

echo ""
echo -e "${BLUE}thunderbot setup${NC}"
echo "════════════════"
echo ""

# Must be in a git repo
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo -e "${RED}Error: not inside a git repository${NC}"
  exit 1
fi

# Must be at repo root
if [ "$(git rev-parse --show-toplevel)" != "$(pwd)" ]; then
  echo -e "${RED}Error: run this from the repository root${NC}"
  exit 1
fi

# Check if already installed
if [ -d "$PREFIX" ]; then
  echo -e "${YELLOW}$PREFIX/ already exists — looks like thunderbot is already installed.${NC}"
  echo -e "To pull latest: ${GREEN}git subtree pull --prefix=$PREFIX thunderbot main --squash${NC}"
  exit 0
fi

# Add remote if needed
if git remote get-url thunderbot >/dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} thunderbot remote exists"
else
  echo -e "  ${BLUE}→${NC} Adding thunderbot remote..."
  git remote add thunderbot "$REPO_URL"
  echo -e "  ${GREEN}✓${NC} Remote added: $REPO_URL"
fi

# Add subtree
echo -e "  ${BLUE}→${NC} Adding subtree at $PREFIX/..."
git subtree add --prefix="$PREFIX" thunderbot main --squash
echo -e "  ${GREEN}✓${NC} Subtree added"

# Create symlinks
echo -e "  ${BLUE}→${NC} Creating symlinks..."
mkdir -p .claude/commands .claude/agents

for f in "$PREFIX"/thunder*.md; do
  ln -sf "../../$f" ".claude/commands/$(basename "$f")"
done

if [ -d "$PREFIX/thunderbot" ]; then
  ln -sfn "../../$PREFIX/thunderbot" .claude/commands/thunderbot
fi

ln -sf "../../$PREFIX/thunderbot.md" .claude/agents/thunderbot.md
echo -e "  ${GREEN}✓${NC} Symlinks created"

# Validate references directory
if [ -d "$PREFIX/references" ]; then
  REF_COUNT=$(ls "$PREFIX/references/"*.md 2>/dev/null | wc -l | tr -d ' ')
  echo -e "  ${GREEN}✓${NC} References directory found ($REF_COUNT reference files)"
else
  echo -e "  ${YELLOW}Warning: $PREFIX/references/ not found. Reference files are used by thunderbot commands for enhanced capabilities.${NC}"
fi

# Check gitignore
if [ -f .gitignore ] && grep -q '\.claude/\*\*' .gitignore; then
  if ! grep -q '!\.claude/commands/' .gitignore; then
    echo ""
    echo -e "${YELLOW}Warning: your .gitignore has '.claude/**' but no exception for .claude/commands/${NC}"
    echo "Add these lines to .gitignore so the symlinks are tracked:"
    echo ""
    echo "  !.claude/commands/"
    echo "  !.claude/commands/**"
    echo "  !.claude/agents/"
    echo "  !.claude/agents/**"
  fi
fi

# Add Makefile targets if Makefile exists
if [ -f Makefile ] && ! grep -q 'setup-symlinks' Makefile; then
  echo ""
  echo -e "${YELLOW}Tip: add these targets to your Makefile:${NC}"
  cat <<'MAKEFILE'

  setup-symlinks:
  	@mkdir -p .claude/commands .claude/agents
  	@for f in .thunderbot/thunder*.md; do ln -sf "../../$$f" ".claude/commands/$$(basename $$f)"; done
  	@ln -sfn ../../.thunderbot/thunderbot .claude/commands/thunderbot
  	@ln -sf ../../.thunderbot/thunderbot.md .claude/agents/thunderbot.md

  thunderbot-pull:
  	git subtree pull --prefix=.thunderbot thunderbot main --squash
  	@$(MAKE) setup-symlinks

  thunderbot-push:
  	git subtree push --prefix=.thunderbot thunderbot main

MAKEFILE
fi

echo ""
echo -e "${GREEN}Done!${NC} thunderbot is installed at $PREFIX/"
echo ""
echo "Next steps:"
echo "  1. Commit the symlinks: git add .claude/commands/ .claude/agents/ && git commit -m 'chore: add thunderbot symlinks'"
echo "  2. Try a command:       /thunderdoctor"
echo "  3. Pull updates later:  git subtree pull --prefix=$PREFIX thunderbot main --squash"
echo ""
