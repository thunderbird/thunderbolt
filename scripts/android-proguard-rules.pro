# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Preserve line number information for debugging stack traces
-keepattributes SourceFile,LineNumberTable
-keepattributes *Annotation*

# Keep native methods (JNI)
-keepclasseswithmembernames class * {
    native <methods>;
}

# Keep Tauri framework classes
-keep class app.tauri.** { *; }
-keepclassmembers class app.tauri.** { *; }

# Keep WebView JavaScript interfaces
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep WebView-related classes
-keep class android.webkit.** { *; }
-keepclassmembers class android.webkit.** { *; }

# Keep Kotlin metadata for reflection
-keep class kotlin.Metadata { *; }
-keepclassmembers class kotlin.Metadata { *; }

# Keep main activity and all activities
-keep public class * extends android.app.Activity
-keep public class * extends androidx.appcompat.app.AppCompatActivity

# Keep application classes that might be accessed via reflection
-keep class net.thunderbird.thunderbolt.** { *; }
-keepclassmembers class net.thunderbird.thunderbolt.** { *; }

# Keep R class and fields
-keepclassmembers class **.R$* {
    public static <fields>;
}

# Keep Parcelable implementations
-keep class * implements android.os.Parcelable {
  public static final android.os.Parcelable$Creator *;
}

# Keep Serializable classes
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}

# Keep AndroidX and Support Library classes
-keep class androidx.** { *; }
-keep interface androidx.** { *; }
-dontwarn androidx.**

