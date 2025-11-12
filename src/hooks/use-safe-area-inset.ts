import { useEffect } from 'react'
import { M3 } from 'tauri-plugin-m3'

export const useSafeAreaInset = () => {
  /**
   * This hook sets the `--safe-area-top-padding` and `--safe-area-bottom-padding` CSS custom properties on the root `<html>` element.
   * On iOS env(safe-area-inset-*) works fine, but on Android it can fail due the edge-to-edge display.
   *
   * So in your CSS instead of using env(safe-area-inset-*) use can/should use var(--safe-area-top-padding) and var(--safe-area-bottom-padding).
   */
  useEffect(() => {
    M3.getInsets().then((insets) => {
      if (insets) {
        document.documentElement.style.setProperty(
          '--safe-area-top-padding',
          insets.adjustedInsetTop ? `${insets.adjustedInsetTop}px` : 'env(safe-area-inset-top, 24px)',
        )

        document.documentElement.style.setProperty(
          '--safe-area-bottom-padding',
          insets.adjustedInsetBottom ? `${insets.adjustedInsetBottom}px` : 'env(safe-area-inset-bottom, 24px)',
        )
      }
    })
  }, [])
}
