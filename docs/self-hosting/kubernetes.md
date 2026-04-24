# Kubernetes

The Kubernetes manifests at `deploy/k8s/` deploy the full Thunderbolt stack — frontend, backend, PostgreSQL, MongoDB, Keycloak, and PowerSync — onto any conformant cluster.

## Local Clusters

Any local Kubernetes works. Pick one:

| Option                  | How                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| **Docker Desktop**      | Settings → Kubernetes → Enable. `kubectl cluster-info` to verify.                         |
| **Minikube**            | `brew install minikube && minikube start`                                                 |
| **kind**                | `brew install kind && kind create cluster --name thunderbolt`                             |

## Deploy

### 1. Build Images

From the repo root:

```bash
docker build -f deploy/docker/backend.Dockerfile -t thunderbolt-backend .
docker build -f deploy/docker/frontend.Dockerfile -t thunderbolt-frontend .
```

(Also build `postgres`, `keycloak`, and `powersync` Dockerfiles for clusters that can't pull the upstream images directly.)

### 2. Configure Secrets

```bash
cd deploy/k8s
cp secrets.yaml.example secrets.yaml
# Edit secrets.yaml — rotate every default
```

### 3. Install an Ingress Controller

If your cluster doesn't already have one:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/cloud/deploy.yaml
```

### 4. Apply Manifests

```bash
kubectl apply -f namespace.yaml
kubectl apply -f secrets.yaml
kubectl apply -f configmaps.yaml
kubectl apply -f postgres.yaml
kubectl apply -f mongo.yaml
kubectl apply -f keycloak.yaml

kubectl -n thunderbolt wait --for=condition=ready pod -l app=postgres --timeout=60s
kubectl -n thunderbolt wait --for=condition=ready pod -l app=mongo --timeout=60s

kubectl apply -f powersync.yaml
kubectl apply -f backend.yaml
kubectl apply -f frontend.yaml
kubectl apply -f ingress.yaml
```

### 5. Access the App

On Docker Desktop or Minikube (with `minikube tunnel`), the app is at `http://localhost`. Keycloak realm is at `http://localhost/realms/thunderbolt`.

## Routing

The `ingress.yaml` routes are path-based:

```
/v1/*         → backend Service
/realms/*     → keycloak Service
/powersync/*  → powersync Service
/*            → frontend Service
```

## Manifest Reference

| File                    | Resources                        | Purpose                                                     |
| ----------------------- | -------------------------------- | ----------------------------------------------------------- |
| `namespace.yaml`        | Namespace                        | Isolated `thunderbolt` namespace                            |
| `secrets.yaml.example`  | Secret                           | Template — copy to `secrets.yaml` before applying           |
| `configmaps.yaml`       | ConfigMaps                       | nginx.conf, Postgres init SQL, PowerSync config, Keycloak realm — synthesized from `deploy/config/` and `deploy/docker/` |
| `postgres.yaml`         | StatefulSet + Service            | PostgreSQL with WAL + PVC                                   |
| `mongo.yaml`            | StatefulSet + Service + Job      | MongoDB replica set + init job                              |
| `powersync.yaml`        | Deployment + Service             | PowerSync sync service                                      |
| `keycloak.yaml`         | Deployment + Service + ConfigMap | Keycloak with realm import                                  |
| `backend.yaml`          | Deployment + Service             | Elysia API server                                           |
| `frontend.yaml`         | Deployment + Service             | nginx SPA                                                   |
| `ingress.yaml`          | Ingress                          | Path-based routing                                          |

## Differences from Docker Compose

| Concept              | Docker Compose              | Kubernetes                              |
| -------------------- | --------------------------- | --------------------------------------- |
| Service discovery    | Container names             | ClusterIP services (DNS)                |
| Ingress / routing    | nginx proxy in the frontend | Ingress resource                        |
| Persistent storage   | Docker volumes              | PersistentVolumeClaims                  |
| Health checks        | `healthcheck:` in compose   | `livenessProbe` / `readinessProbe`      |
| Config files         | Volume mounts               | ConfigMaps                              |
| Secrets              | `.env` file                 | Kubernetes Secrets                      |

## Production on EKS

For a production deployment to AWS EKS, use the Pulumi project:

```bash
cd deploy/pulumi
pulumi config set platform k8s
pulumi up
```

This creates the VPC and EKS cluster, pushes ECR images, installs `nginx-ingress`, and applies the manifests above automatically. See [Pulumi (AWS)](./pulumi.md).
