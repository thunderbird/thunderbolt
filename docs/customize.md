# Customize

Most Thunderbolt features are modular primitives you can extend:

- **Agents** - Connect any local or remote agent over Agent Client Protocol (ACP), via a WebSocket endpoint or a peer-to-peer iroh ticket; the backend can also serve managed agents. Settings → Agents. See [ACP Agents](./architecture/acp-agents.md).
- **Models** - Any OpenAI-compatible model: on-device, on-prem, or cloud.
- **Skills** - Reusable instruction bundles named per the AgentSkills spec, invoked with `/slug` in the composer or loaded by the model on demand. Settings → Skills.
- **Projects** - A workspace whose instructions every chat inherits, plus a tool for searching its other chats. See [Projects](./architecture/projects.md).
- **Widgets** - Interactive UI components embedded in chat responses. See [Widgets](./features/widgets.md).
- **Artifacts** - Model-authored HTML in a sandboxed iframe with no access to the app's DOM, cookies, or storage. See [HTML Artifacts](./architecture/artifacts.md).
- **MCP Servers** - Add your own MCP servers to extend the agent's context.
- **Search Providers** - _Coming Soon_ - Plug in your own search provider for web-grounded answers.
- **Auth Providers** - Plug in your own authentication provider (e.g. OIDC, SAML, magic link).
- **Backends** - _Coming Soon_ - Connect Thunderbolt to any backend server.
- **Extensions** - _Coming Soon_ - Bundles of primitives that can be installed as a unit.
