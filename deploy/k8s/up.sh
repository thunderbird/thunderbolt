#!/usr/bin/env bash
set -eo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
NC='\033[0m'

step() { echo -e "\n${CYAN}▸ $1${NC}"; }

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Build images
step "Building Docker images..."
docker build -f "$REPO_ROOT/deploy/docker/backend.Dockerfile" -t thunderbolt-backend "$REPO_ROOT"
docker build -f "$REPO_ROOT/deploy/docker/frontend.Dockerfile" -t thunderbolt-frontend "$REPO_ROOT"

# Namespace + config
step "Applying namespace, secrets, and config..."
kubectl apply -f namespace.yaml
if [ -f secrets.yaml ]; then
  kubectl apply -f secrets.yaml
else
  echo "  No secrets.yaml found — using secrets.yaml.example"
  kubectl apply -f secrets.yaml.example
fi

CONFIG_DIR="$REPO_ROOT/deploy/config"
INIT_DIR="$REPO_ROOT/deploy/docker/postgres-init"

kubectl -n thunderbolt create configmap nginx-config --from-file=default.conf="$CONFIG_DIR/nginx.conf" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n thunderbolt create configmap postgres-init --from-file="$INIT_DIR/01-powersync.sql" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n thunderbolt create configmap powersync-config --from-file=config.yaml="$CONFIG_DIR/powersync-config.yaml" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n thunderbolt create configmap keycloak-realm --from-file=thunderbolt-realm.json="$CONFIG_DIR/keycloak-realm.json" --dry-run=client -o yaml | kubectl apply -f -

# Databases
step "Starting databases..."
kubectl apply -f postgres.yaml
kubectl apply -f mongo.yaml

step "Waiting for Postgres..."
kubectl -n thunderbolt wait --for=condition=ready pod -l app=postgres --timeout=120s

step "Waiting for MongoDB..."
kubectl -n thunderbolt wait --for=condition=ready pod -l app=mongo --timeout=120s

# Services
step "Starting Keycloak, PowerSync, backend, frontend..."
kubectl apply -f keycloak.yaml
kubectl apply -f powersync.yaml
kubectl apply -f backend.yaml
kubectl apply -f frontend.yaml
kubectl apply -f ingress.yaml

step "Waiting for pods to be ready..."
kubectl -n thunderbolt wait --for=condition=ready pod -l app=keycloak --timeout=120s
kubectl -n thunderbolt wait --for=condition=ready pod -l app=backend --timeout=60s
kubectl -n thunderbolt wait --for=condition=ready pod -l app=frontend --timeout=60s

echo -e "\n${GREEN}═══ Thunderbolt is running ═══${NC}"
echo "  App:            http://localhost"
echo "  Keycloak admin: http://localhost/realms/thunderbolt"
echo "  Demo login:     demo@thunderbolt.so / demo"
echo ""
echo "  kubectl -n thunderbolt get pods"
