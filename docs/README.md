# Introduction

Thunderbolt is an open-source AI client you can deploy on-prem anywhere. One React codebase wrapped in Tauri runs on web, macOS, Windows, Linux, iOS, and Android.

> **Under active development.** Thunderbolt is undergoing a security audit and preparing for enterprise production readiness. Self-host and evaluate it, but do not run it in production yet.

![Thunderbolt Main Dashboard](https://raw.githubusercontent.com/thunderbird/thunderbolt/main/docs/screenshots/main.png)

## AI you control

- **Choose your models.** Anthropic, OpenAI, Mistral, Fireworks, OpenRouter, or any OpenAI-compatible endpoint; locally, [Ollama](https://ollama.com/) and [llama.cpp](https://github.com/ggml-org/llama.cpp) are recommended. Keys live on the device, or a deployment holds the provider credential and meters usage ([Managed Inference](./architecture/managed-inference.md)).
- **Own your data.** Every device reads and writes a local SQLite database first. Cross-device sync is opt-in and can run [end-to-end encrypted](./architecture/e2e-encryption.md), so the server only ever sees ciphertext.
- **Eliminate vendor lock-in.** [Self-host the backend](./self-hosting/README.md) on Docker Compose, Kubernetes, or AWS via Pulumi. Nothing depends on a SaaS control plane.

## Who it's for today

Today's target is **enterprise customers deploying on-prem**. The backend is required for authentication and search (web search can be disabled under _Settings → Connections_); individuals can self-host and sign up against their own backend. A hosted consumer version is planned, with no release date yet.

## Where to go next

| If you want to…                            | Start here                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Run Thunderbolt on one machine             | [Docker Compose](./self-hosting/docker-compose.md)                                                                                          |
| Deploy it for an organization              | [Self-Hosting overview](./self-hosting/README.md), then the [configuration reference](./self-hosting/configuration.md)                      |
| Add models, agents, skills, or MCP servers | [Customize](./customize.md)                                                                                                                 |
| Understand how the pieces connect          | [Architecture](./architecture/README.md)                                                                                                    |
| Contribute code                            | [Quick Start](./development/quick-start.md), [Frontend Structure](./development/frontend-structure.md), [Testing](./development/testing.md) |
| Ask the usual questions                    | [FAQ](./faq.md)                                                                                                                             |
| Do a specific task                         | [How do I...?](./how-do-i.md), a task index covering the common ones                                                                        |

## How it's put together

| Layer    | Stack                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| Client   | React 19 · Vite · Tauri 2 · Radix UI · Zustand · TanStack Query · Drizzle over SQLite      |
| AI       | Vercel AI SDK v6 · MCP client for tool use                                                 |
| Sync     | PowerSync (custom SharedWorker + transform middleware for E2E encryption)                  |
| Backend  | Elysia on Bun · Drizzle ORM · Better Auth (email OTP / OIDC / SAML) · React Email / Resend |
| Database | PostgreSQL (production) · PGLite for backend tests                                         |
| Infra    | Docker Compose · Kubernetes manifests · Pulumi (ECS Fargate or EKS)                        |

## Where documentation lives

- **`docs/`** is published: every `.md` under it goes to `thunderbolt.io/docs/*` via `web/src/loaders/repo-docs-loader.ts`. The sidebar is a hand-maintained allowlist in `web/astro.config.mjs`, so a new file needs an entry there or it ships with no navigation.
- **`backend/docs/`, `deploy/`, component `README.md`** are repo-local: not published, and may assume a reader with a checkout.
- **`.thunderbot/` and `.claude/`** are agent instructions. Never published.
