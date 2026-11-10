/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package net.thunderbird.thunderbolt.pages

import android.app.Activity
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

@InvokeArg
class PageInsets {
    var top: Double = 0.0
    var right: Double = 0.0
    var bottom: Double = 0.0
    var left: Double = 0.0
}

@InvokeArg
class PageBounds {
    var x: Double = 0.0
    var y: Double = 0.0
    var width: Double = 1.0
    var height: Double = 1.0
    var clip: PageInsets? = null
}

@InvokeArg
class PageArgs {
    var epoch: Long = 0
    var label: String? = null
    var url: String? = null
    var bounds: PageBounds? = null
    var hidden: Boolean = false
    var visible: Boolean = false
    var action: String? = null
    var script: String? = null
}

private fun allowedUrl(value: String): Boolean {
    if (value == "about:blank") return true
    if (value.length > 8192) return false
    val uri = Uri.parse(value)
    return uri.scheme?.lowercase() in setOf("http", "https") && !uri.host.isNullOrEmpty()
}

private class Page(
    val epoch: Long,
    val view: WebView,
    val container: FrameLayout,
    var currentUrl: String,
) {
    var alive = true
    var loading = false
    var error: String? = null
    var title = ""
    val newTabUrls = mutableListOf<String>()

    fun state(): JSObject {
        val urls = JSONArray(newTabUrls)
        newTabUrls.clear()
        return JSObject()
            .put("url", if (alive) view.url ?: currentUrl else currentUrl)
            .put("title", title)
            .put("isLoading", loading)
            .put("canGoBack", alive && view.canGoBack())
            .put("canGoForward", alive && view.canGoForward())
            .put("faviconUrls", JSONArray())
            .put("newTabUrls", urls)
            .put("error", error ?: JSONObject.NULL)
    }

    fun close() {
        (container.parent as? ViewGroup)?.removeView(container)
        if (alive) {
            view.stopLoading()
            container.removeView(view)
            view.destroy()
            alive = false
        }
    }
}

/** Browser pages never inherit Tauri's WebView class, bridge, schemes, or host profile. */
@TauriPlugin
class PagesPlugin(private val activity: Activity) : Plugin(activity) {
    private var host = WeakReference<WebView>(null)
    private val pages = mutableMapOf<String, Page>()
    private var minimumEpoch: Long = 0
    private val popups = mutableSetOf<WebView>()
    private val main = Handler(Looper.getMainLooper())
    // A dedicated profile keeps app.thunderbolt.io in a page from sharing host
    // authentication/storage. All browser tabs intentionally share this profile.
    private val profileName = "thunderbolt-browser-pages"

    override fun load(webView: WebView) {
        activity.runOnUiThread {
            closeAll()
            host = WeakReference(webView)
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        closeAll()
        host.clear()
    }

    private fun closeAll() {
        pages.values.forEach { it.close() }
        pages.clear()
        popups.toList().forEach { it.destroy() }
        popups.clear()
    }

    private fun run(invoke: Invoke, block: (PageArgs) -> Unit) {
        try {
            val args = invoke.parseArgs(PageArgs::class.java)
            activity.runOnUiThread {
                try { block(args) }
                catch (error: Exception) { invoke.reject(error.message ?: "Page operation failed") }
            }
        } catch (error: Exception) { invoke.reject(error.message ?: "Invalid page request") }
    }

    private fun page(args: PageArgs): Page {
        val page = pages[args.label] ?: error("The page is closed")
        check(page.epoch == args.epoch) { "The page belongs to an earlier session" }
        return page
    }

    private fun livePage(args: PageArgs): Page = page(args).also {
        check(it.alive) { "The page process stopped. Close and reopen this tab." }
    }

    @Suppress("DEPRECATION")
    private fun present(page: Page, bounds: PageBounds, visible: Boolean) {
        val hostView = host.get() ?: error("The main webview is unavailable")
        val parent = hostView.parent as? ViewGroup ?: error("The main view is detached")
        val hostPosition = IntArray(2)
        val parentPosition = IntArray(2)
        hostView.getLocationInWindow(hostPosition)
        parent.getLocationInWindow(parentPosition)
        val scale = hostView.scale.takeIf { it > 0 } ?: activity.resources.displayMetrics.density
        val clip = bounds.clip ?: PageInsets()
        page.container.layoutParams = ViewGroup.LayoutParams(
            ((bounds.width - clip.left - clip.right) * scale).toInt().coerceAtLeast(1),
            ((bounds.height - clip.top - clip.bottom) * scale).toInt().coerceAtLeast(1),
        )
        page.container.x = hostPosition[0] - parentPosition[0] + ((bounds.x + clip.left) * scale).toFloat()
        page.container.y = hostPosition[1] - parentPosition[1] + ((bounds.y + clip.top) * scale).toFloat()
        page.view.layoutParams = FrameLayout.LayoutParams(
            (bounds.width * scale).toInt().coerceAtLeast(1),
            (bounds.height * scale).toInt().coerceAtLeast(1),
        )
        page.view.x = (-clip.left * scale).toFloat()
        page.view.y = (-clip.top * scale).toFloat()
        if (page.container.parent !== parent) parent.addView(page.container)
        page.container.visibility = if (visible && page.alive) View.VISIBLE else View.GONE
    }

    private fun isolatedWebView(): WebView {
        check(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            "Update Android System WebView to use the in-app browser with isolated storage."
        }
        return WebView(activity).also { WebViewCompat.setProfile(it, profileName) }
    }

    @Command
    fun capabilities(invoke: Invoke) {
        activity.runOnUiThread {
            invoke.resolve(JSObject()
                .put("available", WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
                .put("nativeInput", false).put("screenshot", false).put("isolatedSession", true))
        }
    }

    @Command
    fun create(invoke: Invoke) = run(invoke) { args ->
        check(args.epoch >= minimumEpoch) { "The main page navigated" }
        val label = args.label ?: error("A page label is required")
        check(!pages.containsKey(label)) { "The page already exists" }
        val url = args.url ?: error("A page URL is required")
        check(allowedUrl(url)) { "An HTTP(S) page address is required" }
        val bounds = args.bounds ?: error("Page bounds are required")
        val view = isolatedWebView()
        val container = FrameLayout(activity).apply { clipChildren = true; clipToPadding = true }
        container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val page = Page(args.epoch, view, container, url)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                request.isForMainFrame && !allowedUrl(request.url.toString())

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                page.currentUrl = url ?: page.currentUrl
                page.loading = true
                page.error = null
            }

            override fun onPageFinished(view: WebView, url: String?) { page.loading = false }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    page.error = error.description.toString()
                    page.loading = false
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                page.error = "The page process stopped. Close and reopen this tab."
                page.loading = false
                page.close()
                return true
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String?) { page.title = title.orEmpty() }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                if (!isUserGesture || page.newTabUrls.size >= 8) return false
                val popup = isolatedWebView()
                popups.add(popup)
                var finished = false
                val finish: (String?) -> Unit = finish@{ destination ->
                    if (finished) return@finish
                    finished = true
                    if (pages[label] === page && destination != null && destination != "about:blank" && allowedUrl(destination) && page.newTabUrls.size < 8) {
                        page.newTabUrls.add(destination)
                    }
                    // Destroy outside WebView's navigation callback.
                    main.post { if (popups.remove(popup)) popup.destroy() }
                }
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        finish(request.url.toString())
                        return true
                    }
                    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { finish(url) }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                main.postDelayed({ if (popups.remove(popup)) popup.destroy() }, 5_000)
                return true
            }
        }
        try {
            present(page, bounds, !args.hidden && url != "about:blank")
            pages[label] = page
            page.loading = true
            view.loadUrl(url)
            invoke.resolve()
        } catch (error: Exception) {
            page.close()
            throw error
        }
    }

    @Command
    fun present(invoke: Invoke) = run(invoke) { args ->
        present(page(args), args.bounds ?: error("Page bounds are required"), args.visible)
        invoke.resolve()
    }

    @Command
    fun navigate(invoke: Invoke) = run(invoke) { args ->
        val page = livePage(args)
        val url = args.url ?: error("A page URL is required")
        check(allowedUrl(url)) { "An HTTP(S) page address is required" }
        page.error = null
        page.currentUrl = url
        page.loading = true
        page.view.loadUrl(url)
        invoke.resolve()
    }

    @Command
    fun action(invoke: Invoke) = run(invoke) { args ->
        val page = livePage(args)
        page.error = null
        when (args.action) {
            "back" -> if (page.view.canGoBack()) page.view.goBack()
            "forward" -> if (page.view.canGoForward()) page.view.goForward()
            "reload" -> page.view.reload()
            "stop" -> { page.view.stopLoading(); page.loading = false }
            else -> error("Unsupported page navigation action")
        }
        invoke.resolve()
    }

    @Command
    fun state(invoke: Invoke) = run(invoke) { args -> invoke.resolve(page(args).state()) }

    @Command
    fun close(invoke: Invoke) = run(invoke) { args ->
        val page = pages[args.label]
        if (page != null && page.epoch == args.epoch) { pages.remove(args.label); page.close() }
        invoke.resolve()
    }

    /** Only Rust's fixed observer/picker methods can invoke this; there is no frontend eval command. */
    @Command
    fun evaluate(invoke: Invoke) = run(invoke) { args ->
        val page = livePage(args)
        val script = args.script ?: error("No host observation supplied")
        page.view.evaluateJavascript(script) { raw ->
            try {
                check(pages[args.label] === page && page.alive) { "The page closed during observation" }
                val value = JSONArray("[$raw]").get(0)
                check(value is String) { "The page returned no observation" }
                invoke.resolveObject(value)
            } catch (error: Exception) { invoke.reject(error.message ?: "Invalid page observation") }
        }
    }

    /** A delayed cleanup may only remove pages from older host documents. */
    @Command
    fun reset(invoke: Invoke) = run(invoke) { args ->
        minimumEpoch = maxOf(minimumEpoch, args.epoch)
        val labels = pages.filterValues { it.epoch < args.epoch }.keys.toList()
        labels.forEach { pages.remove(it)?.close() }
        invoke.resolve()
    }
}
