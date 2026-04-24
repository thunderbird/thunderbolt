# Introduction

Thunderbolt is an open-source, cross-platform AI client for web, mobile, and desktop. Our goal in building Thunderbolt is to create an open-source alternative to the major closed-source frontier AI stacks that anyone can run on their own machine and that any org can deploy inside their own infrastructure.

⚠️ Thunderbolt is in active development. We encourage you to self-host and evaluate it, but it is not yet intended for production use.

## Features

Most features in Thunderbolt are modular "primitives" that you can customize:
- **Models** - By using the built-in Thunderbolt agent, you can use any OpenAI-compatible AI model - on-device, on-prem, cloud, etc.
- **Widgets** - Thunderbolt supports UI widgets - interative components that can be embedded inside of chats.
- **MCP Servers** - Add your own MCP servers for context.
- **Automations** - (Deprecated) reusable prompts for quick access.
- **Agents** - (Coming Soon) By implementing Agent Client Protocol (ACP), you can connect to any local or remote agent.
- **Skills** - (Coming Soon) Automations will be migrated to match the industry-standard *skills* specification soon.

## Getting Started

- [Quick Start](./development/quick-start.md) — bootstrap the full stack locally
- [Testing](./development/testing.md) — test strategy and guidelines
- [Features and Roadmap](./roadmap.md)
- [FAQ](./faq.md)

## Self-Hosting

- [Self-Hosting Overview](./self-hosting/) — pick a deployment target
- [Docker Compose](./self-hosting/docker-compose.md)
- [Kubernetes](./self-hosting/kubernetes.md)
- [Pulumi (AWS)](./self-hosting/pulumi.md)

## Architecture & Sync

- [Architecture](./architecture/)
- [Multi-Device Sync](./architecture/multi-device-sync.md)
- [End-to-End Encryption](./architecture/e2e-encryption.md)
- [PowerSync, Account & Device Management](./architecture/powersync-account-devices.md)
- [PowerSync Sync Middleware](./architecture/powersync-sync-middleware.md)
- [Composite Primary Keys and Default Data](./architecture/composite-primary-keys-and-default-data.md)
- [Delete Account and Revoke Device Access](./architecture/delete-account-and-revoke-device.md)

## Features

- [WebView](./features/webview.md)
- [Widget System Guide](./features/widgets.md)
- [Tauri Signing Keys](./features/tauri-signing-keys.md)

## Reference

- [Configuration](./self-hosting/configuration.md) — every backend env var

## Dev Tooling

- [Storybook](./dev-tooling/storybook.md)
- [Vite Bundle Analyzer](./dev-tooling/vite-bundle-analyzer.md)
- [Local CDN for App Update Testing](./dev-tooling/local-cdn-for-app-update-testing.md)

Contributions welcome — open a PR against the [GitHub repo](https://github.com/thunderbird/thunderbolt).
