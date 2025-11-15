#!/usr/bin/env node

/**
 * Injects OAuth client IDs into configuration files for local development and CI/CD.
 * 
 * Reads from:
 * 1. Environment variables (priority)
 * 2. backend/.env file (fallback for local development)
 * 
 * Required variables:
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

// Load environment variables from backend/.env if available
const backendEnvPath = path.join(__dirname, '..', 'backend', '.env')
if (fs.existsSync(backendEnvPath)) {
  const envContent = fs.readFileSync(backendEnvPath, 'utf8')
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=')
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').replace(/^["']|["']$/g, '')
        // Don't override existing env vars
        if (!process.env[key]) {
          process.env[key] = value
        }
      }
    }
  })
  console.log(`📂 Loaded environment variables from backend/.env\n`)
}

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
      // Strip .apps.googleusercontent.com suffix if present
      const cleanGoogleClientId = googleClientId.replace('.apps.googleusercontent.com', '')
      schemes.push(`com.googleusercontent.apps.${cleanGoogleClientId}`)
    }
    
    if (microsoftClientId) {
      schemes.push(`msal${microsoftClientId}`)
    }
    
    data.plugins['deep-link'].mobile[0].scheme = schemes
    
    fs.writeFileSync(TAURI_CONFIG_PATH, JSON.stringify(data, null, 2) + '\n')
    
    console.log('✅ Updated tauri.conf.json deep-link schemes:')
    console.log(`   - Base: thunderbolt://`)
    if (googleClientId) {
      const cleanGoogleClientId = googleClientId.replace('.apps.googleusercontent.com', '')
      console.log(`   - Google: com.googleusercontent.apps.${cleanGoogleClientId}:/oauth2redirect`)
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

