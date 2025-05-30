#!/usr/bin/env node

/**
 * Helper script to find the Thunderbird extension path
 * This helps users locate the correct path for Claude Desktop configuration
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const EXTENSION_ID = 'thunderbird-mcp@example.com';

function findThunderbirdProfiles() {
  const platform = os.platform();
  let profilesDir;
  
  switch (platform) {
    case 'darwin':
      profilesDir = path.join(os.homedir(), 'Library', 'Thunderbird', 'Profiles');
      break;
    case 'linux':
      profilesDir = path.join(os.homedir(), '.thunderbird');
      break;
    case 'win32':
      profilesDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Thunderbird', 'Profiles');
      break;
    default:
      console.error(`Unsupported platform: ${platform}`);
      return [];
  }
  
  if (!fs.existsSync(profilesDir)) {
    console.error(`Thunderbird profiles directory not found: ${profilesDir}`);
    return [];
  }
  
  // Find all profile directories
  const profiles = fs.readdirSync(profilesDir)
    .filter(name => name.includes('.default'))
    .map(name => path.join(profilesDir, name));
  
  return profiles;
}

function findExtensionPath(profilePath) {
  const extensionsDir = path.join(profilePath, 'extensions');
  const extensionPath = path.join(extensionsDir, EXTENSION_ID);
  
  if (fs.existsSync(extensionPath)) {
    return extensionPath;
  }
  
  // Check if it's installed as an XPI file
  const xpiPath = path.join(extensionsDir, `${EXTENSION_ID}.xpi`);
  if (fs.existsSync(xpiPath)) {
    return xpiPath;
  }
  
  return null;
}

function main() {
  console.log('🔍 Searching for Thunderbird MCP extension...\n');
  
  const profiles = findThunderbirdProfiles();
  
  if (profiles.length === 0) {
    console.log('❌ No Thunderbird profiles found.');
    console.log('Make sure Thunderbird is installed and has been run at least once.');
    return;
  }
  
  console.log(`Found ${profiles.length} Thunderbird profile(s):\n`);
  
  let foundExtension = false;
  
  profiles.forEach((profilePath, index) => {
    const profileName = path.basename(profilePath);
    console.log(`Profile ${index + 1}: ${profileName}`);
    
    const extensionPath = findExtensionPath(profilePath);
    
    if (extensionPath) {
      foundExtension = true;
      const bridgePath = path.join(extensionPath, 'claude-desktop-bridge.js');
      
      console.log(`✅ Extension found at: ${extensionPath}`);
      
      if (fs.existsSync(bridgePath)) {
        console.log(`✅ Bridge script found at: ${bridgePath}\n`);
        
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📋 CLAUDE DESKTOP CONFIGURATION');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('\nAdd this to your Claude Desktop config:\n');
        
        const config = {
          mcpServers: {
            thunderbird: {
              command: 'node',
              args: [bridgePath],
              env: {},
              alwaysAllow: ['read']
            }
          }
        };
        
        console.log(JSON.stringify(config, null, 2));
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      } else {
        console.log(`⚠️  Bridge script not found. Expected at: ${bridgePath}`);
        console.log('   Make sure the extension was built with the build script.\n');
      }
    } else {
      console.log(`❌ Extension not installed in this profile\n`);
    }
  });
  
  if (!foundExtension) {
    console.log('💡 To install the extension:');
    console.log('   1. Build the extension: ./build-extension.sh');
    console.log('   2. In Thunderbird: Tools → Add-ons → Install Add-on From File');
    console.log('   3. Select the .xpi file from the extension directory');
  }
  
  // Also show config file locations
  console.log('\n📁 Claude Desktop config file locations:');
  switch (os.platform()) {
    case 'darwin':
      console.log('   ~/Library/Application Support/Claude/claude_desktop_config.json');
      break;
    case 'win32':
      console.log('   %APPDATA%\\Claude\\claude_desktop_config.json');
      break;
    case 'linux':
      console.log('   ~/.config/Claude/claude_desktop_config.json');
      break;
  }
}

main();