# Thunderbolt [![CI](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml/badge.svg)](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml)

**AI You Control: Choose your models. Own your data. Eliminate vendor lock-in.**

Thunderbolt is an open-source, cross-platform AI client that can be deployed on-prem anywhere.

- 🌐 Available on all major desktop and mobile platforms: web, iOS, Android, Mac, Linux, and Windows.
- 🔒 Data is stored on-device with optional end-to-end-encrypted cloud syncing.
- 🧠 Compatible with frontier, local, and on-prem models.
- 🙋 Enterprise features, support, and FDEs available.

**Thunderbolt is under active development, currently undergoing a security audit, and preparing for enterprise production readiness.**

![Thunderbolt Main Dashboard](./docs/screenshots/main.png)

## Roadmap

| Platform | Status |
| --- | --- |
| Web | ✅ |
| Mac | ✅ |
| Linux | ✅ |
| Windows | ✅ |
| Android | ✅ Available - App Store Release Planned |
| iOS | ✅ Available - App Store Release Planned |

| Feature | Status |
| --- | --- |
| ACP | In Development - Release Planned: April 2026 |️
| MCP Support | ✅ |
| OIDC | ✅ |
| Chat Widgets | ✅ |
| Chat Mode | ✅ |
| Search Mode | ✅ |
| Research Mode | ✅ |
| Custom Models / Providers | ✅ |
| Optional End-to-End Encryption | ✅ |
| Cross-Device Cloud Sync | ✅ |
| Google Integration | ✅ |
| Microsoft Integration | ✅ |
| Ollama Compatibility | ✅ |
| Agent Memory | Planned |
| Agent Skills | Planned |
| Offline Support | Planned |
| Research Mode v2 | Planned |
| Tasks | Preview |

## Quick Start

You must have Bun, Rust, and Docker installed first. Then:

```sh
# Install dependencies
make setup

# Set up .env files
cp .env.example .env
cd backend && cp .env.example .env

# Run postgres + powersync
make docker-up

# Run backend
# cd backend && bun dev

# Browser:
bun dev
# -> open http://localhost:1420 in your browser.

# Desktop
bun tauri:dev:desktop

# iOS Simulator
bun tauri:dev:ios

# Android Emulator
bun tauri:dev:android
```

## Testing

```sh
# Run frontend tests (src/ and scripts/)
bun run test

# Run frontend tests in watch mode
bun run test:watch

# Run backend tests
bun run test:backend

# Run backend tests in watch mode
bun run test:backend:watch
```

**Note**: Don't use `bun test` without the npm script from the project root, as it will pick up both frontend and backend tests. The `test` script is configured to only run tests in `./src` and `./scripts` directories.

See [docs/testing.md](./docs/testing.md) for detailed testing guidelines.

## Run Android

```sh
# Android builds work with default (empty) features
bun tauri android dev
```

## Documentation

- [Claude Code Skills](./docs/claude-code.md) - Slash commands, automation, and subtree syncing
- [Storybook](./docs/storybook.md) - Build, test, and document components
- [Vite Bundle Analyzer](./docs/vite-bundle-analyzer.md) - Analyze frontend bundle size
- [Tauri Signing Keys](./docs/tauri-signing-keys.md) - Generate and manage signing keys for releases
- [Release Process](./RELEASE.md) - Instructions for creating and publishing new releases
- [Telemetry](./TELEMETRY.md) - Information about data collection and privacy policy
