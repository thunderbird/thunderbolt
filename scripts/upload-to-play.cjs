#!/usr/bin/env node

const { google } = require('googleapis')
const fs = require('fs')
const path = require('path')

async function uploadToPlayStore() {
  try {
    // Get environment variables
    const serviceAccountFile = process.env.SERVICE_ACCOUNT_FILE
    const packageName = process.env.PACKAGE_NAME
    const aabPath = process.env.AAB_PATH
    const track = process.env.TRACK || 'internal'

    if (!serviceAccountFile || !packageName || !aabPath) {
      throw new Error('Missing required environment variables: SERVICE_ACCOUNT_FILE, PACKAGE_NAME, AAB_PATH')
    }

    // Validate AAB file exists
    if (!fs.existsSync(aabPath)) {
      throw new Error(`AAB file not found: ${aabPath}`)
    }

    // Validate service account file exists
    if (!fs.existsSync(serviceAccountFile)) {
      throw new Error(`Service account file not found: ${serviceAccountFile}`)
    }

    console.log(`📱 Uploading ${aabPath} to ${packageName} on ${track} track`)

    // Load service account credentials from file
    const serviceAccountJson = fs.readFileSync(serviceAccountFile, 'utf8')
    const credentials = JSON.parse(serviceAccountJson)
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    })

    // Build the service
    const androidpublisher = google.androidpublisher({ version: 'v3', auth })

    // Create a new edit
    console.log('🔄 Creating new edit...')
    const editResponse = await androidpublisher.edits.insert({
      packageName,
    })
    const editId = editResponse.data.id
    console.log(`✅ Edit created: ${editId}`)

    try {
      // Upload the AAB file
      console.log('📤 Uploading AAB file...')
      const media = {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(aabPath),
      }

      const uploadResponse = await androidpublisher.edits.bundles.upload({
        packageName,
        editId,
        media,
      })

      console.log(`✅ Upload successful:`, uploadResponse.data)

      // Set the release track
      if (track !== 'production') {
        console.log(`🎯 Setting track to ${track}...`)
        const trackResponse = await androidpublisher.edits.tracks.update({
          packageName,
          editId,
          track,
          requestBody: {
            releases: [
              {
                versionCodes: [uploadResponse.data.versionCode],
                // To auto-rollout to testers, the app setup must be fully completed in Google Play Console
                // (store listing, content rating, target audience, etc.). Until then, only 'draft' is accepted.
                // Once the setup is done, switch back to: status: track === 'internal' ? 'completed' : 'draft',
                status: 'draft',
              },
            ],
          },
        })
        console.log('✅ Track set to %s:', track, trackResponse.data)
      }

      // Commit the edit
      console.log('💾 Committing edit...')
      const commitResponse = await androidpublisher.edits.commit({
        packageName,
        editId,
      })
      console.log(`✅ Edit committed:`, commitResponse.data)
    } catch (error) {
      console.error(`❌ Upload failed:`, error.message)
      // Abandon the edit on failure
      console.log('🧹 Abandoning edit...')
      await androidpublisher.edits.delete({ packageName, editId })
      throw error
    }
  } catch (error) {
    console.error(`❌ Setup failed:`, error.message)
    process.exit(1)
  }
}

// Run the upload
uploadToPlayStore()
