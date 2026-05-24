# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# tao calls WryActivity.getId() via JNI from Rust at every activity lifecycle
# event (onCreate, onSaveInstanceState, onDestroy). R8 strips the
# Kotlin-generated getter because there are no Java/Kotlin call sites, which
# crashes release builds with `Err(JavaException)` at tao/.../ndk_glue.rs:393.
# The shipped wry proguard-wry.pro template misses this rule.
-keepclassmembers class net.thunderbird.thunderbolt.WryActivity {
    int getId();
}