#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_ROOT/powersync-service/docker-compose.yml"

if ! command -v docker &>/dev/null; then
  echo -e "${RED}✗ Docker is not installed.${NC}"
  echo "  Install Docker Desktop: https://docker.com/products/docker-desktop"
  exit 1
fi

if ! docker info &>/dev/null; then
  echo -e "${RED}✗ Docker daemon is not running.${NC}"
  echo "  Start Docker Desktop and try again."
  exit 1
fi

echo -e "${GREEN}✓ Docker is running${NC}"
echo ""

if [ ! -f "$COMPOSE_FILE" ]; then
  echo -e "${YELLOW}! Compose file not found: $COMPOSE_FILE${NC}"
  exit 1
fi

echo "Container status:"
docker compose -f "$COMPOSE_FILE" ps
