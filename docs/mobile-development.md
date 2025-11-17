# Mobile Development Guide

This guide covers running Thunderbolt on Android and iOS during local development.

## Prerequisites

**Backend Server Configuration:**

For mobile devices to connect to your local backend, update `backend/src/index.ts`:

```typescript
// Change this:
const hostname = process.env.HOST
  ? process.env.HOST
  : process.env.NODE_ENV === 'production'
    ? '0.0.0.0'
    : 'localhost'

// To this:
const hostname = '0.0.0.0'
```

This binds the backend server to all network interfaces, allowing your mobile device to connect via your computer's local IP address.

## Quick Start

**TL;DR** - Run the app on your device:

```bash
# Android (with device/emulator connected)
bun run tauri:android:dev

# iOS (macOS only, with device/simulator)
bun run tauri:ios:dev
```

These commands handle everything: OAuth configuration, building, and launching the app with hot reload.

## How Mobile Development Commands Work

### `bun run tauri:android:dev`

**Purpose:** Launch Thunderbolt Android app in development mode with hot reload.

**Step-by-step execution:**

1. **Runs `scripts/inject-oauth-client-ids.cjs`**
   - Reads `backend/.env` for OAuth client IDs
   - Extracts: `GOOGLE_CLIENT_ID_ANDROID`, `MICROSOFT_CLIENT_ID_ANDROID`
   - Strips `.apps.googleusercontent.com` suffix from Google client ID if present
   - Updates `src-tauri/tauri.conf.json` → `plugins.deep-link.mobile[0].scheme`
   - Injects deep-link schemes:
     - `thunderbolt` (base app scheme)
     - `com.googleusercontent.apps.{CLIENT_ID}` (Google OAuth callback)
     - `msal{CLIENT_ID}` (Microsoft OAuth callback, if configured)

2. **Changes directory to `src-tauri`**
   - All Tauri mobile commands must run from the `src-tauri` directory

3. **Runs `cargo tauri android dev`**
   - Compiles Rust backend with Android targets
   - Bundles TypeScript/React frontend (via Vite)
   - Generates Android project files in `src-tauri/gen/android/`
   - Reads `GOOGLE_CLIENT_ID_ANDROID` from environment/`.env`
   - Injects into `AndroidManifest.xml` via Gradle `manifestPlaceholders`
   - Builds debug APK with hot-reload enabled
   - Installs APK on connected device/emulator via ADB
   - Launches app automatically
   - Starts development server for hot reload

**Requirements:**
- Android device/emulator connected and authorized (`adb devices`)
- `GOOGLE_CLIENT_ID_ANDROID` in `backend/.env`
- `ANDROID_HOME` environment variable set
- Java JDK 17+ installed
- **Bun** installed ([bun.sh](https://bun.sh))

**Output:** App running on device with live reload for frontend changes.

---

### `bun run tauri:ios:dev`

**Purpose:** Launch Thunderbolt iOS app in development mode with hot reload.

**Step-by-step execution:**

1. **Sets `TAURI_PLATFORM=ios` environment variable**
   - Tells `inject-oauth-client-ids.cjs` to configure for iOS instead of Android

2. **Runs `scripts/inject-oauth-client-ids.cjs`**
   - Reads `backend/.env` for OAuth client IDs
   - Extracts: `GOOGLE_CLIENT_ID_IOS` (fallback to `GOOGLE_CLIENT_ID_ANDROID` if not set)
   - Extracts: `MICROSOFT_CLIENT_ID_IOS` (fallback to `MICROSOFT_CLIENT_ID_ANDROID` if not set)
   - Strips `.apps.googleusercontent.com` suffix from Google client ID if present
   - Updates `src-tauri/tauri.conf.json` → `plugins.deep-link.mobile[0].scheme`
   - Injects iOS-specific deep-link schemes

3. **Changes directory to `src-tauri`**
   - All Tauri mobile commands must run from the `src-tauri` directory

4. **Runs `cargo tauri ios dev`**
   - Compiles Rust backend with iOS targets
   - Bundles TypeScript/React frontend (via Vite)
   - Generates Xcode project in `src-tauri/gen/apple/`
   - Configures iOS-specific OAuth schemes in `Info.plist`
   - Builds debug IPA with hot-reload enabled
   - Opens Xcode or launches simulator
   - Starts development server for hot reload

**Requirements:**
- macOS with Xcode 14+ installed
- iOS device/simulator configured
- `GOOGLE_CLIENT_ID_IOS` in `backend/.env` (or falls back to Android ID)
- Xcode Command Line Tools installed
- CocoaPods installed (`sudo gem install cocoapods`)
- **Bun** installed ([bun.sh](https://bun.sh))
  - Xcode build script automatically detects bun from common locations
  - Works with: system PATH, nvm, Homebrew, or direct install

**Output:** App running on iOS device/simulator with live reload for frontend changes.

---

### Architecture: OAuth Deep Linking

**Problem:** Mobile OAuth requires redirecting from a system browser back to the app after authentication.

**Solution:** Custom URL schemes registered in platform manifests.

**Google OAuth:**
- Redirect URI format: `com.googleusercontent.apps.{CLIENT_ID}:/oauth2redirect`
- Android: Registered via `<intent-filter>` in `AndroidManifest.xml`
- iOS: Registered via `CFBundleURLSchemes` in `Info.plist`
- Backend validates this is a "mobile" client (no secret required)

**Microsoft OAuth:**
- Redirect URI format: `msal{CLIENT_ID}://auth`
- Same registration process as Google

**Flow:**
1. User taps "Connect Google" in app
2. App opens system browser with OAuth URL
3. User authenticates in browser
4. OAuth provider redirects to custom scheme (e.g., `com.googleusercontent.apps.860884698243-ckjfmfr7nab9ckeh5p3f362nsh6ii5g6:/oauth2redirect?code=xyz`)
5. OS intercepts scheme and launches app
6. App's deep-link handler extracts `code` and `state` from URL
7. App sends code to backend for token exchange (PKCE flow)

**Security:** Uses PKCE (Proof Key for Code Exchange) - no client secrets on mobile.
