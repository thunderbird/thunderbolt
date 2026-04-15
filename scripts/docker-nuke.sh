#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_ROOT/powersync-service/docker-compose.yml"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo -e "${RED}✗ Compose file not found: $COMPOSE_FILE${NC}"
  exit 1
fi

CONFIRMED=false
for arg in "$@"; do
  if [ "$arg" = "-y" ]; then
    CONFIRMED=true
  fi
done

if [ "$CONFIRMED" = false ]; then
  echo -e "${YELLOW}This will destroy all docker containers, volumes, and data for this project.${NC}"
  echo -e "${YELLOW}You will lose all local Postgres and Mongo data.${NC}"
  echo ""
  read -rp "Are you sure? (y/N) " answer
  if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi
fi

echo -e "${RED}→ Stopping and removing containers + volumes...${NC}"
docker compose -f "$COMPOSE_FILE" down -v

echo -e "${GREEN}→ Recreating containers from scratch...${NC}"
docker compose -f "$COMPOSE_FILE" up -d

echo -e "${GREEN}✓ Docker environment nuked and recreated!${NC}"
