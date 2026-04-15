# Thunderbolt [![CI](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml/badge.svg)](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml)

**AI You Control: Choose your models. Own your data. Eliminate vendor lock-in.**

Thunderbolt is an open-source, cross-platform AI client that can be deployed on-prem anywhere.

- 🌐 Available on all major desktop and mobile platforms: web, iOS, Android, Mac, Linux, and Windows.
- 🔒 Data is stored on-device with optional end-to-end-encrypted cloud syncing.
- 🧠 Compatible with frontier, local, and on-prem models.
- 🙋 Enterprise features, support, and FDEs available.

**Thunderbolt is under active development, currently undergoing a security audit, and preparing for enterprise production readiness.**

![Thunderbolt Main Dashboard](./docs/screenshots/main.png)

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


## Need Help?

Found a bug? Have an idea?

- We're actively working on our docs, community, and roadmap. For now, the best way to get in touch is to [File an issue](https://github.com/thunderbird/thunderbolt/issues).

## Contributing

We welcome contributions from everyone.

- **Development**: The [CONTRIBUTING](./CONTRIBUTING.md) guide will help you get started.
- Make sure to check out the [Mozilla Community Participation Guidelines](https://www.mozilla.org/about/governance/policies/participation/).

## Documentation

- [Roadmap](./docs/roadmap.md) - Platform and feature status
- [Claude Code Skills](./docs/claude-code.md) - Slash commands, automation, and subtree syncing
- [Storybook](./docs/storybook.md) - Build, test, and document components
- [Vite Bundle Analyzer](./docs/vite-bundle-analyzer.md) - Analyze frontend bundle size
- [Tauri Signing Keys](./docs/tauri-signing-keys.md) - Generate and manage signing keys for releases
- [Release Process](./RELEASE.md) - Instructions for creating and publishing new releases
- [Telemetry](./TELEMETRY.md) - Information about data collection and privacy policy

## Code of Conduct

Please read our [Code of Conduct](./CODE_OF_CONDUCT.md). All participants in the Thunderbolt community agree to follow these guidelines and [Mozilla's Community Participation Guidelines](https://www.mozilla.org/about/governance/policies/participation/).

## Security

If you discover a security vulnerability, please report it responsibly via our [vulnerability reporting form](https://github.com/thunderbird/thunderbolt/security/advisories/new). Please do **not** file public GitHub issues for security vulnerabilities.

## License

Thunderbolt is licensed under the [Mozilla Public License 2.0](./LICENSE).
