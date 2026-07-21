/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Setup detail the ACP registry doesn't carry: packaged install commands,
 * binary-agent run commands, API-key environment variables, and setup docs.
 *
 * Keyed by `RegistryEntry.id`. Agents without authored metadata fall back to a
 * registry-derived npx/uvx run command when available.
 */
export type AgentInstallMeta = {
  /** One-time install command (macOS/Linux), shown above the run command. */
  installCommand?: string
  /** Overrides the registry-derived run command — an authored command always wins.
   *  Required for `binary`-distributed agents, whose registry cmd is a
   *  post-archive-extraction path (see buildRunCommand). */
  runCommand?: string
  requiredEnv?: ReadonlyArray<{ name: string; description: string }>
  docsUrl?: string
  setupNote?: string
}

export const agentInstallMetadata: Readonly<Record<string, AgentInstallMeta>> = {
  gemini: {
    requiredEnv: [{ name: 'GEMINI_API_KEY', description: 'API key from Google AI Studio.' }],
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  'claude-acp': {
    requiredEnv: [{ name: 'ANTHROPIC_API_KEY', description: 'API key from the Anthropic Console.' }],
    docsUrl: 'https://github.com/agentclientprotocol/claude-agent-acp',
  },
  'codex-acp': {
    requiredEnv: [{ name: 'OPENAI_API_KEY', description: 'API key from the OpenAI Platform.' }],
    docsUrl: 'https://github.com/agentclientprotocol/codex-acp',
  },
  'grok-build': {
    requiredEnv: [{ name: 'XAI_API_KEY', description: 'API key from the xAI Console.' }],
    docsUrl: 'https://x.ai/cli',
  },
  'amp-acp': {
    // Authored rather than derived: the registry lists only binary archives for
    // amp-acp, but the same project ships the `amp-acp` package on npm.
    runCommand: 'npx -y amp-acp',
    requiredEnv: [
      {
        name: 'AMP_API_KEY',
        description: 'API key from ampcode.com settings, or run `amp login` with the Amp CLI installed.',
      },
    ],
    docsUrl: 'https://github.com/tao12345666333/amp-acp',
  },
  cursor: {
    installCommand: 'curl https://cursor.com/install -fsS | bash',
    runCommand: 'agent acp',
    setupNote: 'Sign in first with `agent login`.',
    docsUrl: 'https://cursor.com/docs/cli/acp',
  },
  goose: {
    installCommand: 'brew install block-goose-cli',
    runCommand: 'goose acp',
    setupNote: 'Configure your model provider first with `goose configure`.',
    docsUrl: 'https://block.github.io/goose/',
  },
  opencode: {
    installCommand: 'curl -fsSL https://opencode.ai/install | bash',
    runCommand: 'opencode acp',
    setupNote: 'Sign in with `opencode auth login`.',
    docsUrl: 'https://opencode.ai/docs/acp/',
  },
  devin: {
    installCommand: 'curl -fsSL https://cli.devin.ai/install.sh | bash',
    runCommand: 'devin acp',
    setupNote: 'Sign in with `devin auth login`.',
    docsUrl: 'https://docs.devin.ai/cli',
  },
  kimi: {
    installCommand: 'brew install kimi-cli',
    runCommand: 'kimi acp',
    setupNote: 'Run `kimi` once and send /login to authenticate before connecting.',
    docsUrl: 'https://moonshotai.github.io/kimi-cli/',
  },
  'mistral-vibe': {
    installCommand: 'brew install mistral-vibe',
    runCommand: 'vibe-acp',
    requiredEnv: [{ name: 'MISTRAL_API_KEY', description: 'API key from La Plateforme.' }],
    docsUrl: 'https://mistral.ai/products/vibe',
  },
  junie: {
    installCommand: 'curl -fsSL https://junie.jetbrains.com/install.sh | bash',
    runCommand: 'junie --acp=true',
    requiredEnv: [
      {
        name: 'JUNIE_API_KEY',
        description: 'Token from junie.jetbrains.com/cli; JetBrains account login also works.',
      },
    ],
    docsUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
  },
  poolside: {
    installCommand: 'curl -fsSL https://downloads.poolside.ai/pool/install.sh | sh',
    runCommand: 'pool acp',
    setupNote: 'Sign in with `pool login`, or set POOLSIDE_API_KEY.',
    docsUrl: 'https://docs.poolside.ai/cli/pool',
  },
  stakpak: {
    installCommand: 'brew tap stakpak/stakpak && brew install stakpak',
    runCommand: 'stakpak acp',
    requiredEnv: [{ name: 'STAKPAK_API_KEY', description: 'API key from stakpak.dev.' }],
    docsUrl: 'https://github.com/stakpak/agent',
  },
  vtcode: {
    installCommand: 'brew install vtcode',
    // VT Code refuses to start its ACP server unless both gates are enabled.
    runCommand: 'VT_ACP_ENABLED=1 VT_ACP_ZED_ENABLED=1 vtcode acp',
    setupNote: 'Configure your provider first with `vtcode init`.',
    docsUrl: 'https://github.com/vinhnx/VTCode/blob/main/docs/guides/zed-acp.md',
  },
  'crow-cli': {
    // crow-cli requires Python >= 3.14; the flag makes uv provision it.
    installCommand: 'uv tool install crow-cli --python 3.14',
    runCommand: 'crow-cli acp',
    setupNote: 'Run `crow-cli init` once to configure before connecting.',
    docsUrl: 'https://github.com/crow-cli/crow-cli',
  },
  'cortex-code': {
    installCommand: 'curl -LsS https://ai.snowflake.com/static/cc-scripts/install.sh | sh',
    runCommand: 'cortex acp serve',
    setupNote: 'Authenticate first with `cortex auth login` — ACP mode does not prompt for authentication.',
    docsUrl: 'https://docs.snowflake.com/en/user-guide/cortex-code/cortex-code-acp',
  },
  'corust-agent': {
    runCommand: './corust-agent-acp',
    setupNote:
      'Download the release archive for your platform from GitHub Releases, extract it, and run the command from that directory.',
    docsUrl: 'https://github.com/Corust-ai/corust-agent-release/releases',
  },
  harn: {
    installCommand: 'curl -fsSL https://harnlang.com/install.sh | sh',
    runCommand: 'harn serve acp',
    docsUrl: 'https://github.com/burin-labs/harn',
  },
}
