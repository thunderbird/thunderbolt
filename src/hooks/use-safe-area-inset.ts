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
  getInsets: () => invoke<AndroidInsets | null>('get_android_insets'),
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
    if (deps.isTauri()) {
      deps
        .getInsets()
        .then((insets) => {
          createCSSVars({
            bottom: insets?.adjustedInsetBottom ?? 0,
            top: insets?.adjustedInsetTop ?? 0,
          })
        })
        .catch(() => {
          createCSSVars({ bottom: 0, top: 0 })
        })

      return
    }

    createCSSVars({
      bottom: 0,
      top: 0,
    })
  }, [])
}
