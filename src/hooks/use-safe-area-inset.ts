import { invoke } from '@tauri-apps/api/core'
import { useEffect } from 'react'
import { isTauri } from '@/lib/platform'

type AndroidInsets = {
  adjustedInsetTop: number
  adjustedInsetBottom: number
}

type SafeAreaInsetDeps = {
  isTauri: () => boolean
  getInsets: () => Promise<AndroidInsets | null>
}

const defaultDeps: SafeAreaInsetDeps = {
  isTauri,
  getInsets: () => invoke<AndroidInsets | null>('plugin:platform-utils|get_android_insets'),
}

export const createCSSVars = (insets: { bottom: number; top: number }) => {
  document.documentElement.style.setProperty(
    '--safe-area-top-padding',
    insets?.top > 0 ? `${insets.top}px` : 'env(safe-area-inset-top, 24px)',
  )

  document.documentElement.style.setProperty(
    '--safe-area-bottom-padding',
    insets?.bottom > 0 ? `${insets.bottom}px` : 'env(safe-area-inset-bottom, 24px)',
  )
}

export const useSafeAreaInset = (deps: SafeAreaInsetDeps = defaultDeps) => {
  /**
   * This hook sets the `--safe-area-top-padding` and `--safe-area-bottom-padding` CSS custom properties on the root `<html>` element.
   * On iOS env(safe-area-inset-*) works fine, but on Android it can fail due the edge-to-edge display.
   *
   * So in your CSS instead of using env(safe-area-inset-*) use can/should use var(--safe-area-top-padding) and var(--safe-area-bottom-padding).
   */
  useEffect(() => {
    // Set defaults synchronously so CSS vars are never unset — components
    // reference them without a CSS fallback (e.g. bare var(--safe-area-top-padding)).
    createCSSVars({ bottom: 0, top: 0 })

    if (deps.isTauri()) {
      // On Android, overwrite with real insets once the native call resolves.
      ;(async () => {
        try {
          const insets = await deps.getInsets()
          createCSSVars({
            bottom: insets?.adjustedInsetBottom ?? 0,
            top: insets?.adjustedInsetTop ?? 0,
          })
        } catch (e) {
          console.info('Failed to get Android insets, using CSS env() defaults:', e)
        }
      })()
    }
  }, [])
}
