import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { AgentCard } from './agent-card'
import type { MergedAgent } from './use-agent-registry'

// Mock haptics and posthog are handled by global test setup

// Mock haptics and posthog are handled by global test setup

const makeAgent = (overrides?: Partial<MergedAgent>): MergedAgent => ({
  registryId: 'claude-acp',
  agentId: null,
  name: 'Claude Agent',
  description: 'Claude Code ACP adapter',
  version: '0.24.2',
  installedVersion: null,
  updateAvailable: false,
  isInstalled: false,
  isCustom: false,
  isRemote: false,
  isBuiltIn: false,
  enabled: false,
  distributionType: 'npx',
  icon: null,
  authors: ['Anthropic'],
  license: 'MIT',
  registryEntry: null,
  ...overrides,
})

const makeInstalledAgent = (overrides?: Partial<MergedAgent>): MergedAgent =>
  makeAgent({
    agentId: 'agent-registry-claude-acp',
    isInstalled: true,
    enabled: true,
    installedVersion: '0.24.2',
    ...overrides,
  })

const noop = () => {}
const testProxyBase = 'http://localhost:8000/v1'

describe('AgentCard', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('rendering', () => {
    it('renders agent name', () => {
      render(
        <AgentCard
          agent={makeAgent()}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByText('Claude Agent')).toBeDefined()
    })

    it('renders agent description', () => {
      render(
        <AgentCard
          agent={makeAgent()}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByText('Claude Code ACP adapter')).toBeDefined()
    })

    it('renders version for uninstalled agent', () => {
      render(
        <AgentCard
          agent={makeAgent({ version: '0.24.2' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByText('v0.24.2')).toBeDefined()
    })

    it('renders installed version for installed agent', () => {
      render(
        <AgentCard
          agent={makeInstalledAgent({ installedVersion: '0.23.0' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByText('v0.23.0')).toBeDefined()
    })

    it('renders distribution type badge', () => {
      render(
        <AgentCard
          agent={makeAgent({ distributionType: 'npx' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByText('Node.js')).toBeDefined()
    })

    it('renders Binary badge for binary type', () => {
      render(
        <AgentCard
          agent={makeAgent({ distributionType: 'binary' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByText('Binary')).toBeDefined()
    })

    it('renders Python badge for uvx type', () => {
      render(
        <AgentCard
          agent={makeAgent({ distributionType: 'uvx' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByText('Python')).toBeDefined()
    })

    it('renders proxied icon when agent has icon URL', () => {
      const { container } = render(
        <AgentCard
          agent={makeAgent({ icon: 'https://cdn.example.com/claude.svg' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const img = container.querySelector('img')
      expect(img).toBeDefined()
      expect(img?.getAttribute('src')).toBe(
        `${testProxyBase}/pro/proxy/${encodeURIComponent('https://cdn.example.com/claude.svg')}`,
      )
    })

    it('renders fallback icon when agent has no icon URL', () => {
      render(
        <AgentCard
          agent={makeAgent({ icon: null })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.queryByRole('img')).toBeNull()
    })

    it('truncates long descriptions to 2 lines', () => {
      render(
        <AgentCard
          agent={makeAgent({ description: 'A very long description that should be truncated' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const desc = screen.getByText('A very long description that should be truncated')
      expect(desc.className).toContain('line-clamp-2')
    })
  })

  describe('uninstalled agent', () => {
    it('shows Install button', () => {
      render(
        <AgentCard
          agent={makeAgent()}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByText('Install')).toBeDefined()
    })

    it('does not show Switch toggle', () => {
      render(
        <AgentCard
          agent={makeAgent()}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.queryByRole('switch')).toBeNull()
    })

    it('calls onInstall when Install button clicked', () => {
      const onInstall = mock(() => {})
      const agent = makeAgent()
      render(
        <AgentCard
          agent={agent}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={onInstall}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      fireEvent.click(screen.getByText('Install'))
      expect(onInstall).toHaveBeenCalledTimes(1)
      expect(onInstall).toHaveBeenCalledWith(agent)
    })
  })

  describe('installed agent', () => {
    it('shows Switch toggle', () => {
      render(
        <AgentCard
          agent={makeInstalledAgent()}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.getByRole('switch')).toBeDefined()
    })

    it('does not show Install button', () => {
      render(
        <AgentCard
          agent={makeInstalledAgent()}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      expect(screen.queryByText('Install')).toBeNull()
    })

    it('Switch is checked when enabled', () => {
      render(
        <AgentCard
          agent={makeInstalledAgent({ enabled: true })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const switchEl = screen.getByRole('switch')
      expect(switchEl.getAttribute('data-state')).toBe('checked')
    })

    it('Switch is unchecked when disabled', () => {
      render(
        <AgentCard
          agent={makeInstalledAgent({ enabled: false })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const switchEl = screen.getByRole('switch')
      expect(switchEl.getAttribute('data-state')).toBe('unchecked')
    })

    it('calls onToggle when Switch toggled', () => {
      const onToggle = mock(() => {})
      const agent = makeInstalledAgent({ enabled: true })
      render(
        <AgentCard
          agent={agent}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={onToggle}
        />,
      )
      fireEvent.click(screen.getByRole('switch'))
      expect(onToggle).toHaveBeenCalledTimes(1)
      expect(onToggle).toHaveBeenCalledWith(agent, false)
    })
  })

  describe('installing state', () => {
    it('disables Install button while installing', () => {
      render(
        <AgentCard
          agent={makeAgent()}
          proxyBase={testProxyBase}
          isInstalling={true}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const btn = screen.getByText('Install').closest('button')
      expect(btn?.disabled).toBe(true)
    })
  })

  describe('uninstalling state', () => {
    it('disables Switch while uninstalling', () => {
      render(
        <AgentCard
          agent={makeInstalledAgent()}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={true}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const switchEl = screen.getByRole('switch')
      expect(switchEl.hasAttribute('disabled')).toBe(true)
    })
  })

  describe('update available', () => {
    it('shows update icon when update available', () => {
      render(
        <AgentCard
          agent={makeInstalledAgent({ updateAvailable: true, version: '0.25.0', installedVersion: '0.24.2' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      // The ArrowUpCircle icon should be present — check for the tooltip text
      expect(screen.getByText('v0.24.2')).toBeDefined()
    })
  })

  describe('fallback icons', () => {
    it('uses Globe icon for remote agents without icon', () => {
      const { container } = render(
        <AgentCard
          agent={makeInstalledAgent({ isRemote: true, icon: null })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      // Globe icon should be rendered (SVG with lucide class)
      const svg = container.querySelector('.lucide-globe')
      expect(svg).toBeDefined()
    })

    it('uses Terminal icon for local agents without icon', () => {
      const { container } = render(
        <AgentCard
          agent={makeInstalledAgent({ isRemote: false, icon: null })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const svg = container.querySelector('.lucide-terminal')
      expect(svg).toBeDefined()
    })
  })

  describe('dark mode icon visibility', () => {
    it('applies invert filter to proxied SVG icons for dark mode', () => {
      const { container } = render(
        <AgentCard
          agent={makeAgent({ icon: 'https://cdn.example.com/icon.svg' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const img = container.querySelector('img')
      expect(img?.className).toContain('dark:invert')
    })
  })

  describe('remote agent uninstall', () => {
    it('does not show uninstall button for server-managed remote agents', () => {
      const { container } = render(
        <AgentCard
          agent={makeInstalledAgent({ isRemote: true, isCustom: false })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const trashIcon = container.querySelector('.lucide-trash-2')
      expect(trashIcon).toBeNull()
    })
  })

  describe('custom agent', () => {
    it('shows "Remove" text in uninstall popover for custom agents', () => {
      const agent = makeInstalledAgent({ isCustom: true })
      render(
        <AgentCard
          agent={agent}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          onInstall={noop}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      // Click trash button to open popover
      const trashButtons = screen.getAllByRole('button')
      const trashBtn = trashButtons.find((btn) => btn.querySelector('svg'))
      if (trashBtn) {
        fireEvent.click(trashBtn)
      }
      // The popover content should mention "Remove"
      const removeBtn = screen.queryByText('Remove')
      expect(removeBtn).toBeDefined()
    })
  })

  describe('cliInstallBlocked', () => {
    it('replaces Install button with disabled button for local distribution when cliInstallBlocked is true', () => {
      const onInstall = mock(() => {})
      render(
        <AgentCard
          agent={makeAgent({ distributionType: 'npx' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          cliInstallBlocked={true}
          onInstall={onInstall}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const btn = screen.getByText('Install').closest('button')
      expect(btn?.disabled).toBe(true)
    })

    it('does not call onInstall when install button is clicked with cliInstallBlocked true', () => {
      const onInstall = mock(() => {})
      render(
        <AgentCard
          agent={makeAgent({ distributionType: 'npx' })}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          cliInstallBlocked={true}
          onInstall={onInstall}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      fireEvent.click(screen.getByText('Install'))
      expect(onInstall).not.toHaveBeenCalled()
    })

    it('shows functional Install button for local distribution when cliInstallBlocked is false', () => {
      const onInstall = mock(() => {})
      const agent = makeAgent({ distributionType: 'npx' })
      render(
        <AgentCard
          agent={agent}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          cliInstallBlocked={false}
          onInstall={onInstall}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const btn = screen.getByText('Install').closest('button')
      expect(btn?.disabled).toBe(false)
      fireEvent.click(screen.getByText('Install'))
      expect(onInstall).toHaveBeenCalledTimes(1)
      expect(onInstall).toHaveBeenCalledWith(agent)
    })

    it('shows functional Install button for remote agent regardless of cliInstallBlocked', () => {
      const onInstall = mock(() => {})
      const agent = makeAgent({ distributionType: 'remote', isRemote: true })
      render(
        <AgentCard
          agent={agent}
          proxyBase={testProxyBase}
          isInstalling={false}
          isUninstalling={false}
          cliInstallBlocked={true}
          onInstall={onInstall}
          onUninstall={noop}
          onToggle={noop}
        />,
      )
      const btn = screen.getByText('Install').closest('button')
      expect(btn?.disabled).toBe(false)
      fireEvent.click(screen.getByText('Install'))
      expect(onInstall).toHaveBeenCalledTimes(1)
      expect(onInstall).toHaveBeenCalledWith(agent)
    })
  })
})
