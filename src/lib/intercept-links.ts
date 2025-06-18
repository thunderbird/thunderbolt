import { isTauri } from './platform'

const handler = async (event: MouseEvent) => {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return
  const url = new URL(anchor.href)
  // app://, file://, or any origin you own stays inside
  if (url.origin === location.origin || url.protocol === 'app:') {
    return
  }

  event.preventDefault()

  if (isTauri()) {
    // Use Tauri's openUrl in Tauri environment
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(anchor.href)
    } catch (error) {
      console.error('Failed to open URL with Tauri:', error)
      // Fallback to window.open
      window.open(anchor.href, '_blank', 'noopener,noreferrer')
    }
  } else {
    window.open(anchor.href, '_blank', 'noopener,noreferrer')
  }
}

/**
 * Intercepts clicks on links and opens them in the system's default browser
 * in Tauri, and in a new tab in the browser.
 */
export const initializeLinkInterception = () => {
  document.addEventListener('click', handler)

  return () => {
    document.removeEventListener('click', handler)
  }
}
