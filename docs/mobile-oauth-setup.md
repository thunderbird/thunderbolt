# Mobile OAuth Configuration Guide

This guide explains how OAuth client IDs are managed for Google and Microsoft integrations on Android and iOS mobile apps.

## 🏗️ Architecture

OAuth configuration is managed through **environment variables** that are injected at build time into multiple configuration files:

1. **`tauri.conf.json`** - Deep link URL schemes for mobile apps
2. **`AndroidManifest.xml`** - Android intent filters (via Gradle manifest placeholders)
3. **`build.gradle.kts`** - Android build configuration

## 🔐 Required Environment Variables

### For Android:
```bash
GOOGLE_CLIENT_ID_ANDROID=860884698243-ckjfmfr7nab9ckeh5p3f362nsh6ii5g6
MICROSOFT_CLIENT_ID_ANDROID=your-microsoft-client-id
```

### For iOS (optional, will fallback to Android values):
```bash
GOOGLE_CLIENT_ID_IOS=your-ios-google-client-id
MICROSOFT_CLIENT_ID_IOS=your-ios-microsoft-client-id
```

### Backend:
```bash
GOOGLE_CLIENT_ID_ANDROID=860884698243-ckjfmfr7nab9ckeh5p3f362nsh6ii5g6
GOOGLE_CLIENT_SECRET_ANDROID=  # Empty for installed app clients
MICROSOFT_CLIENT_ID_ANDROID=your-microsoft-client-id
MICROSOFT_CLIENT_SECRET_ANDROID=  # Empty for MSAL apps
```

## 🚀 Local Development Setup

### 1. Create your `.env` file:
```bash
# Copy example and fill in your values
cp .env.example .env
```

### 2. Export environment variables:
```bash
export GOOGLE_CLIENT_ID_ANDROID=860884698243-ckjfmfr7nab9ckeh5p3f362nsh6ii5g6
export MICROSOFT_CLIENT_ID_ANDROID=your-microsoft-client-id
```

### 3. Inject OAuth client IDs before building:
```bash
node scripts/inject-oauth-client-ids.js
```

### 4. Build your mobile app:
```bash
# Android
bun tauri android build

# iOS
bun tauri ios build
```

## ☁️ CI/CD Setup (GitHub Actions)

### Required GitHub Secrets

Navigate to **Settings → Secrets and variables → Actions → Repository secrets** and add:

#### Android Secrets:
- `GOOGLE_CLIENT_ID_ANDROID` - Your Android Google OAuth client ID
- `MICROSOFT_CLIENT_ID_ANDROID` - Your Android Microsoft OAuth client ID

#### iOS Secrets (optional):
- `GOOGLE_CLIENT_ID_IOS` - Your iOS Google OAuth client ID
- `MICROSOFT_CLIENT_ID_IOS` - Your iOS Microsoft OAuth client ID

### How CI/CD Works

The GitHub Actions workflows automatically inject OAuth client IDs:

1. **Android Release** (`.github/workflows/android-release.yml`):
   - Reads secrets from `GOOGLE_CLIENT_ID_ANDROID` and `MICROSOFT_CLIENT_ID_ANDROID`
   - Runs `node` script to inject into `tauri.conf.json`
   - Gradle reads from environment variables to populate `AndroidManifest.xml` placeholders
   - Builds the Android app with correct deep link schemes

2. **iOS Release** (`.github/workflows/ios-release.yml`):
   - Similar process for iOS using iOS-specific secrets (or fallback to Android)

## 📋 Google OAuth Setup (Android)

### Create Android OAuth Client:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **APIs & Services → Credentials**
3. Click **Create Credentials → OAuth Client ID**
4. Select **Android** as application type
5. Fill in:
   - **Package name**: `net.thunderbird.thunderbolt`
   - **SHA-1 certificate fingerprint**: (Get from your keystore)
6. Click **Create**

### Redirect URI Format:
- **Automatic**: Android OAuth clients use the format `com.googleusercontent.apps.CLIENT_ID:/oauth2redirect`
- No manual configuration needed in Google Cloud Console

### Get Client ID:
Download the JSON configuration file and extract the `client_id` field:
```json
{
  "installed": {
    "client_id": "860884698243-ckjfmfr7nab9ckeh5p3f362nsh6ii5g6.apps.googleusercontent.com",
    ...
  }
}
```

Use the part before `.apps.googleusercontent.com` as your `GOOGLE_CLIENT_ID_ANDROID`.

## 📋 Microsoft OAuth Setup (Android)

### Create MSAL App Registration:

1. Go to [Azure Portal](https://portal.azure.com/)
2. Navigate to **Microsoft Entra ID → App registrations**
3. Click **New registration**
4. Fill in:
   - **Name**: Thunderbolt Android
   - **Supported account types**: Accounts in any organizational directory and personal Microsoft accounts
5. Click **Register**
6. Note the **Application (client) ID**

### Configure Redirect URI:
1. Go to **Authentication**
2. Click **Add a platform → Android**
3. Add redirect URI: `msal{CLIENT_ID}://auth`

### Client Secret:
- **Not required** for MSAL mobile apps (leave `MICROSOFT_CLIENT_SECRET_ANDROID` empty or unset)

## 🔧 How Files Are Updated

### `tauri.conf.json`
```json
{
  "plugins": {
    "deep-link": {
      "mobile": [{
        "scheme": [
          "thunderbolt",
          "com.googleusercontent.apps.860884698243-ckjfmfr7nab9ckeh5p3f362nsh6ii5g6",
          "msalyour-microsoft-client-id"
        ]
      }]
    }
  }
}
```

### `AndroidManifest.xml`
```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="com.googleusercontent.apps.${googleClientId}" />
</intent-filter>
```

The `${googleClientId}` placeholder is replaced by Gradle at build time using values from `build.gradle.kts`:
```kotlin
manifestPlaceholders["googleClientId"] = System.getenv("GOOGLE_CLIENT_ID_ANDROID") ?: "YOUR_GOOGLE_CLIENT_ID_HERE"
```

## 🐛 Troubleshooting

### Error: "Access Blocked: Authorization error"
- **Cause**: Using wrong OAuth client type (Web instead of Android)
- **Fix**: Create an Android OAuth client in Google Cloud Console

### Error: "redirect_uri_mismatch"
- **Cause**: Redirect URI doesn't match what's configured
- **Fix**: For Android OAuth clients, the redirect URI is automatic and should be `com.googleusercontent.apps.YOUR_CLIENT_ID:/oauth2redirect`

### Deep link not opening app
- **Cause**: Intent filter not registered or wrong scheme
- **Fix**: 
  1. Check that `GOOGLE_CLIENT_ID_ANDROID` is set during build
  2. Verify `AndroidManifest.xml` has correct scheme after build
  3. Rebuild app: `bun tauri android build`

### Build fails with "Could not find deep-link configuration"
- **Cause**: `tauri.conf.json` structure changed
- **Fix**: Check that `plugins.deep-link.mobile[0].scheme` path exists in `tauri.conf.json`

## 📚 References

- [Google OAuth for Mobile Apps](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Microsoft MSAL for Android](https://docs.microsoft.com/en-us/azure/active-directory/develop/msal-android-getting-started)
- [Tauri Deep Link Plugin](https://tauri.app/plugin/deep-link)

