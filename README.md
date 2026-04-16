# Thunderbolt [![CI](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml/badge.svg)](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml)

**AI You Control: Choose your models. Own your data. Eliminate vendor lock-in.**

![Thunderbolt Main Dashboard](./docs/screenshots/main.png)

> [!IMPORTANT]
> ⚠️ **We are excited about the amount of interest Thunderbolt has been getting and want to clarify that it is still early and under active development**. Currently, we are targeting enterprise customers that want to deploy it on-prem. We encourage you to self-host it and try it out, but there are a few caveats we are still working on:
>
> - While we eventually plan to make Thunderbolt fully offline-first, it currently depends on authentication and search functionality (though you can disable search on the integrations screen in the app). You can [deploy your own backend with Docker](./deploy/README.md) and sign up in order to test it locally.
> - You’ll need to add your own model providers - we don’t yet have a public inference endpoint. We recommend using Thunderbolt with [Ollama](https://ollama.com) or [llama.cpp](https://github.com/ggml-org/llama.cpp) if you want free local inference, or you can add API keys for any OpenAI-compatible model provider in the settings.

Thunderbolt is an open-source, cross-platform AI client that can be deployed on-prem anywhere.

- 🌐 Available on all major desktop and mobile platforms: web, iOS, Android, Mac, Linux, and Windows.
- 🧠 Compatible with frontier, local, and on-prem models.
- 🙋 Enterprise features, support, and FDEs available.

**Thunderbolt is under active development, currently undergoing a security audit, and preparing for enterprise production readiness.**

## Need Help?

Found a bug? Have an idea?

- We're actively working on our docs, community, and roadmap. For now, the best way to get in touch is to [File an issue](https://github.com/thunderbird/thunderbolt/issues).

## Contributing

We welcome contributions from everyone.

- **Development**: The [development guide](./docs/development.md) will help you get started.
- Make sure to check out the [Mozilla Community Participation Guidelines](https://www.mozilla.org/about/governance/policies/participation/).

## Documentation

- [FAQ](./docs/faq.md) - Frequently asked questions
- [Deployment](./deploy/README.md) - Self-host with Docker Compose or Kubernetes
- [Development](./docs/development.md) - Quick start, setup, and testing
- [Architecture](./docs/architecture.md) - System architecture and diagrams
- [Features and Roadmap](./docs/roadmap.md) - Platform and feature status
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
