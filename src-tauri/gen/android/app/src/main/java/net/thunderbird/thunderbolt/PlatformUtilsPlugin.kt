package net.thunderbird.thunderbolt

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
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

    /**
     * Saves base64 `data` into the public Downloads folder through MediaStore and
     * resolves with `{ name }`, the display name MediaStore actually used (it
     * suffixes a taken name). plugin-fs cannot do this: its `Download` is the
     * app-private getExternalFilesDir. Called from `src/lib/download.ts`.
     */
    @Command
    fun saveToDownloads(invoke: Invoke) {
        // shortcut: MediaStore.Downloads needs API 29, so Android 7-9 (minSdk 24) cannot save files;
        // upgrade by writing to Environment.getExternalStoragePublicDirectory with
        // WRITE_EXTERNAL_STORAGE if those devices matter.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            invoke.reject("Saving files needs Android 10 or later")
            return
        }
        val args = invoke.getArgs()
        val bytes = Base64.decode(args.getString("data"), Base64.DEFAULT)
        val resolver = activity.contentResolver
        val pending = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, args.getString("name"))
            put(MediaStore.MediaColumns.MIME_TYPE, args.getString("mimeType"))
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, pending)
        if (uri == null) {
            invoke.reject("Could not create ${args.getString("name")} in Downloads")
            return
        }
        try {
            resolver.openOutputStream(uri)!!.use { it.write(bytes) }
            resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (error: Exception) {
            // Don't leave a half-written file behind in the user's Downloads.
            resolver.delete(uri, null, null)
            throw error
        }
        val name = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)!!.use {
            it.moveToFirst()
            it.getString(0)
        }
        val result = JSObject()
        result.put("name", name)
        invoke.resolve(result)
    }
}
