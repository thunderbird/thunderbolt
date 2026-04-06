# Thunderbolt on Kubernetes

Run the full Thunderbolt stack on Kubernetes — locally or in production.

## Local Kubernetes

### Option 1: Docker Desktop (easiest)

1. Open Docker Desktop → Settings → Kubernetes → Enable Kubernetes
2. Wait for the cluster to start (green indicator)
3. Verify: `kubectl cluster-info`

### Option 2: Minikube

```bash
brew install minikube
minikube start
```

### Option 3: kind (Kubernetes in Docker)

```bash
brew install kind
kind create cluster --name thunderbolt
```

## Deploy

### 1. Build images

From the repo root:

```bash
docker build -f deploy/docker/backend.Dockerfile -t thunderbolt-backend .
docker build -f deploy/docker/frontend.Dockerfile -t thunderbolt-frontend .
```

### 2. Set up secrets

```bash
cd deploy/k8s
cp secrets.yaml.example secrets.yaml
# Edit secrets.yaml if changing default credentials
```

### 3. Install nginx-ingress (if not already installed)

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/cloud/deploy.yaml
```

### 4. Apply manifests

```bash
kubectl apply -f namespace.yaml
kubectl apply -f secrets.yaml
kubectl apply -f configmaps.yaml
kubectl apply -f postgres.yaml
kubectl apply -f mongo.yaml
kubectl apply -f keycloak.yaml

# Wait for databases to be ready
kubectl -n thunderbolt wait --for=condition=ready pod -l app=postgres --timeout=60s
kubectl -n thunderbolt wait --for=condition=ready pod -l app=mongo --timeout=60s

kubectl apply -f powersync.yaml
kubectl apply -f backend.yaml
kubectl apply -f frontend.yaml
kubectl apply -f ingress.yaml
```

### 5. Access

```bash
# If using Docker Desktop or Minikube with tunnel:
# App is at http://localhost
# Keycloak at http://localhost/realms/thunderbolt

# If using Minikube:
minikube tunnel
```

## Architecture

Same containers as Docker Compose, orchestrated by Kubernetes:

```
  Ingress (nginx-ingress or Traefik)
    /v1/*        → backend Service
    /realms/*    → keycloak Service
    /powersync/* → powersync Service
    /*           → frontend Service

  backend  → postgres (ClusterIP)
  powersync → postgres (ClusterIP, WAL replication)
  powersync → mongo (ClusterIP, replica set)
```

### Key Differences from Docker Compose

| Concept | Docker Compose | Kubernetes |
|---------|---------------|------------|
| Service discovery | Container names | ClusterIP Services (DNS) |
| Ingress/routing | nginx proxy in frontend | Ingress resource |
| Persistent storage | Docker volumes | PersistentVolumeClaims |
| Health checks | `healthcheck:` in compose | `livenessProbe` / `readinessProbe` |
| Config files | Volume mounts | ConfigMaps |
| Secrets | `.env` file | Kubernetes Secrets |

## Manifests

| File | Resources | Purpose |
|------|-----------|---------|
| `namespace.yaml` | Namespace | Isolated `thunderbolt` namespace |
| `secrets.yaml.example` | Secret | Credentials template (copy to `secrets.yaml`) |
| (created by `up.sh`) | ConfigMaps | nginx.conf, postgres init SQL, PowerSync config, Keycloak realm — from `deploy/config/` and `deploy/docker/` |
| `postgres.yaml` | StatefulSet + Service | PostgreSQL with WAL + PVC |
| `mongo.yaml` | StatefulSet + Service + Job | MongoDB replica set + init job |
| `powersync.yaml` | Deployment + Service | PowerSync sync service |
| `keycloak.yaml` | Deployment + Service + ConfigMap | Keycloak with realm import |
| `backend.yaml` | Deployment + Service | Bun API server |
| `frontend.yaml` | Deployment + Service | nginx SPA |
| `ingress.yaml` | Ingress | Path-based routing |

## Production (EKS)

For AWS EKS deployment, use the Pulumi project in `deploy/pulumi/`:

```bash
cd deploy/pulumi
pulumi config set platform k8s
pulumi up
```

This creates an EKS cluster and deploys all manifests automatically.
