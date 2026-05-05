package net.thunderbird.thunderbolt

import android.webkit.WebView

class MainActivity : TauriActivity() {
    // Prevent the WebView from scrolling when the keyboard appears.
    // With adjustResize, the viewport shrinks but the WebView may also scroll
    // to show the focused input, pushing the header off-screen.
    // Our JS-based approach (useKeyboardInset + --kb CSS variable) handles
    // keyboard layout instead.
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        webView.overScrollMode = WebView.OVER_SCROLL_NEVER
        webView.isVerticalScrollBarEnabled = false
        webView.setOnScrollChangeListener { v, _, _, _, _ ->
            v.scrollTo(0, 0)
        }
    }
}
