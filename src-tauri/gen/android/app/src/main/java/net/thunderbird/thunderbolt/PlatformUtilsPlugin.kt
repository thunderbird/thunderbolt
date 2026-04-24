package net.thunderbird.thunderbolt

import android.app.Activity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class PlatformUtilsPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun getAndroidInsets(invoke: Invoke) {
        activity.runOnUiThread {
            val rootView = activity.window.decorView
            val insets = ViewCompat.getRootWindowInsets(rootView)

            if (insets == null) {
                invoke.resolve()
                return@runOnUiThread
            }

            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val density = activity.resources.displayMetrics.density

            val result = JSObject()
            result.put("adjustedInsetTop", (systemBars.top / density).toDouble())
            result.put("adjustedInsetBottom", (systemBars.bottom / density).toDouble())
            invoke.resolve(result)
        }
    }

    @Command
    fun setBarColor(invoke: Invoke) {
        activity.runOnUiThread {
            val args = invoke.getArgs()
            val style = args.getString("style", "system") ?: "system"
            val window = activity.window
            val controller = WindowInsetsControllerCompat(window, window.decorView)

            when (style) {
                "dark" -> {
                    controller.isAppearanceLightStatusBars = true
                    controller.isAppearanceLightNavigationBars = true
                }
                "light" -> {
                    controller.isAppearanceLightStatusBars = false
                    controller.isAppearanceLightNavigationBars = false
                }
            }

            invoke.resolve()
        }
    }
}
