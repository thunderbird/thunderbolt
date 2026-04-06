#!/usr/bin/env bash
set -eo pipefail

echo "Tearing down Thunderbolt k8s deployment..."

if [ "$1" = "--volumes" ] || [ "$1" = "-v" ]; then
  echo "Deleting namespace (all resources + persistent volumes)..."
  kubectl delete namespace thunderbolt --ignore-not-found
  kubectl delete pvc -n thunderbolt --all --ignore-not-found 2>/dev/null
else
  echo "Deleting deployments (keeping persistent volumes)..."
  kubectl delete -f . --ignore-not-found -n thunderbolt 2>/dev/null
fi

echo "Done."
