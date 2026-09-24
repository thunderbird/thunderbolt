# Introduction

Thunderbolt is an open-source AI chat client that you host yourself. It runs on the web, macOS, Windows, Linux, iOS, and Android, and it talks to whichever AI models you choose. That can be a commercial provider on your own account, a model running on your own hardware, or a catalog your deployment serves on behalf of your users.

![Thunderbolt Main Dashboard](https://raw.githubusercontent.com/thunderbird/thunderbolt/main/docs/screenshots/main.png)

## What you get

**Your models.** Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible endpoint, each reached with a key your users supply. [Ollama](https://ollama.com/) and [llama.cpp](https://github.com/ggml-org/llama.cpp) cover local inference at no cost. You can also give the server its own provider keys and serve a managed catalog with per-account spend limits, so people can start chatting without holding a key at all. A key a user supplies is stored on the device that added it and is never synced. See [Models](./self-hosting/models.md).

**Your infrastructure.** The whole server stack runs on a single Docker host, a Kubernetes cluster, or AWS, with no SaaS control plane to call home to and no vendor account to lose access to.

**Your data.** Each device keeps its own local database and reads and writes there first. Cross-device sync is off until a user signs in, which turns it on for that device; they can switch it off again under Settings → Preferences → Data. You can switch on [end-to-end encryption](./admin/security-and-privacy.md) so the server holds only ciphertext for chat content, titles, settings and other covered fields.

**Your identity provider.** Sign-in runs through OIDC or SAML against the identity provider you already operate. Deployments without one can use emailed sign-in codes instead. You choose which method to run, and only one is active at a time. See [Authentication](./self-hosting/authentication.md).

**Your extensions.** Connect Model Context Protocol (MCP) servers, external coding agents, and reusable instruction bundles called skills; see [Customize](./customize.md).

## Who it is for

We built Thunderbolt for **organizations deploying on-premises**. Individuals can self-host it too, but a backend is currently required for sign-in and for web search, so "install and run" means running the server stack as well. A hosted version is planned, with no release date.

## What it costs

Thunderbolt is free and open source under the Mozilla Public License 2.0, funded through a dedicated investment from Mozilla. Inference is the only line item, billed by whichever provider you point it at. A local model through Ollama or llama.cpp costs nothing beyond the hardware.

## Limitations

- End-to-end encryption is in preview and has not had a cryptography audit. It is off unless you turn it on.
- Sign-in requires the backend, so the app is not yet usable fully offline. Once a user is signed in, chats, edits, and settings changes are written locally and replay when the network returns, but answering them needs a network unless the model runs on your own hardware.
- Web search reaches an external provider. It is part of the **Thunderbolt** connection under **Settings → Connections**, on by default, and it only works when the deployment sets `EXA_API_KEY`. A user can switch the connection off there.
- Analytics are opt-in and off by default.

## Where to go next

| If you want to…                                 | Start here                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| See what Thunderbolt can do                     | [Using Thunderbolt](./using/README.md)                           |
| Know what you can plug into it                  | [Customize](./customize.md): models, agents, skills, connections |
| Run it on one machine to evaluate it            | [Docker Compose](./self-hosting/docker-compose.md)               |
| Deploy it for an organization                   | [Self-Hosting overview](./self-hosting/README.md)                |
| Wire it to your identity provider               | [Authentication](./self-hosting/authentication.md)               |
| Look up a setting or environment variable       | [Configuration reference](./self-hosting/configuration.md)       |
| Understand link previews and the in-app browser | [WebView](./features/webview.md)                                 |
| Ask a common question                           | [FAQ](./faq.md)                                                  |

Found a bug or have a request? [File an issue](https://github.com/thunderbird/thunderbolt/issues). For a security vulnerability, use the [private reporting form](https://github.com/thunderbird/thunderbolt/security/advisories/new) instead of a public issue.
