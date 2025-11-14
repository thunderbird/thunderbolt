#!/usr/bin/env node

/**
 * Injects OAuth client IDs into configuration files for local development and CI/CD.
 * 
 * Reads from environment variables:
 * - GOOGLE_CLIENT_ID_ANDROID (for Android builds)
 * - GOOGLE_CLIENT_ID_IOS (for iOS builds)
 * - MICROSOFT_CLIENT_ID_ANDROID (for Android builds)
 * - MICROSOFT_CLIENT_ID_IOS (for iOS builds)
 * 
 * Note: Mobile OAuth uses PKCE flow - NO client secrets required!
 * 
 * Updates:
 * - src-tauri/tauri.conf.json (deep-link schemes)
 * - src-tauri/gen/android/app/build.gradle.kts (via env vars, read at build time)
 * - src-tauri/gen/android/app/src/main/AndroidManifest.xml (via manifest placeholders)
 */

const fs = require('fs')
const path = require('path')

const TAURI_CONFIG_PATH = path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json')

// Detect target platform from environment or arguments
const targetPlatform = process.env.TAURI_PLATFORM || process.argv[2] || 'android'
const isIos = targetPlatform === 'ios'

// Get client IDs for the target platform
const googleClientId = isIos 
  ? (process.env.GOOGLE_CLIENT_ID_IOS || process.env.GOOGLE_CLIENT_ID_ANDROID)
  : (process.env.GOOGLE_CLIENT_ID_ANDROID || process.env.GOOGLE_CLIENT_ID_IOS)

const microsoftClientId = isIos
  ? (process.env.MICROSOFT_CLIENT_ID_IOS || process.env.MICROSOFT_CLIENT_ID_ANDROID)
  : (process.env.MICROSOFT_CLIENT_ID_ANDROID || process.env.MICROSOFT_CLIENT_ID_IOS)

console.log(`🔧 Injecting OAuth client IDs for ${isIos ? 'iOS' : 'Android'}...\n`)

if (!googleClientId && !microsoftClientId) {
  console.warn('⚠️  No OAuth client IDs found in environment variables.')
  console.warn('   Set GOOGLE_CLIENT_ID_ANDROID/IOS or MICROSOFT_CLIENT_ID_ANDROID/IOS\n')
}

// Update tauri.conf.json
try {
  const data = JSON.parse(fs.readFileSync(TAURI_CONFIG_PATH, 'utf8'))
  
  if (data.plugins && data.plugins['deep-link'] && data.plugins['deep-link'].mobile) {
    const schemes = ['thunderbolt']
    
    if (googleClientId) {
      schemes.push(`com.googleusercontent.apps.${googleClientId}`)
    }
    
    if (microsoftClientId) {
      schemes.push(`msal${microsoftClientId}`)
    }
    
    data.plugins['deep-link'].mobile[0].scheme = schemes
    
    fs.writeFileSync(TAURI_CONFIG_PATH, JSON.stringify(data, null, 2) + '\n')
    
    console.log('✅ Updated tauri.conf.json deep-link schemes:')
    console.log(`   - Base: thunderbolt://`)
    if (googleClientId) {
      console.log(`   - Google: com.googleusercontent.apps.${googleClientId}:/oauth2redirect`)
    }
    if (microsoftClientId) {
      console.log(`   - Microsoft: msal${microsoftClientId}://auth`)
    }
  } else {
    console.warn('⚠️  Could not find deep-link configuration in tauri.conf.json')
  }
} catch (error) {
  console.error('❌ Failed to update tauri.conf.json:', error.message)
  process.exit(1)
}

console.log('\n📝 Note: For Android builds, AndroidManifest.xml uses placeholders replaced by Gradle.')
console.log(`   Make sure GOOGLE_CLIENT_ID_${isIos ? 'IOS' : 'ANDROID'} and MICROSOFT_CLIENT_ID_${isIos ? 'IOS' : 'ANDROID'} are set.\n`)

console.log('✨ Done! You can now build your mobile app with the updated OAuth configuration.')
console.log(`   Run: bun tauri ${isIos ? 'ios' : 'android'} build`)

