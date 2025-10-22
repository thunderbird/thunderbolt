import { describe, expect, it } from 'vitest'
import type { SidebarWebviewConfig } from './use-sidebar-webview'

describe('useSidebarWebview', () => {
  it('should accept valid config', () => {
    const config: SidebarWebviewConfig = {
      url: 'https://example.com',
    }

    expect(config.url).toBe('https://example.com')
  })

  it('should allow optional onClose callback', () => {
    const onClose = () => {}
    const config: SidebarWebviewConfig = {
      url: 'https://example.com',
      onClose,
    }

    expect(config.onClose).toBe(onClose)
  })

  it('should work without onClose', () => {
    const config: SidebarWebviewConfig = {
      url: 'https://example.com',
    }

    expect(config.onClose).toBeUndefined()
  })
})
