#!/bin/bash

# Script to setup ProGuard rules for Android release builds
# This ensures the necessary rules are in place to prevent blank screen issues

set -e

PROGUARD_FILE="src-tauri/gen/android/app/proguard-rules.pro"
BACKUP_FILE="scripts/android-proguard-rules.pro"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}→ Setting up Android ProGuard rules...${NC}"

# Check if gen/android directory exists
if [ ! -d "src-tauri/gen/android" ]; then
    echo -e "${RED}✗ Android project not initialized. Run 'bun tauri android init' first.${NC}"
    exit 1
fi

# Check if backup file exists, if not create it
if [ ! -f "$BACKUP_FILE" ]; then
    echo -e "${YELLOW}  Creating backup of ProGuard rules...${NC}"
    mkdir -p "$(dirname "$BACKUP_FILE")"
    cat > "$BACKUP_FILE" << 'EOF'
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
EOF
fi

# Copy backup to actual location
echo -e "${YELLOW}  Copying ProGuard rules to ${PROGUARD_FILE}...${NC}"
cp "$BACKUP_FILE" "$PROGUARD_FILE"

echo -e "${GREEN}✓ ProGuard rules configured successfully!${NC}"
echo -e "${YELLOW}  Note: These rules prevent Tauri and WebView classes from being stripped during release builds.${NC}"

