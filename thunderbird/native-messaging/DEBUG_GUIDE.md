# Thunderbird Native Messaging Debug Guide

## Common Issues Causing "Native messaging host disconnected"

### 1. **Extension ID Mismatch**
- Extension manifest.json has: `"id": "thunderbird-mcp@example.com"`
- Native manifest must have matching: `"allowed_extensions": ["thunderbird-mcp@example.com"]`
- ✅ This is correctly configured

### 2. **Path Issues**
- Native messaging cannot use shebangs with `#!/usr/bin/env node`
- Node.js might not be in PATH when Thunderbird executes the script
- Solution: Use absolute paths or wrapper scripts

### 3. **File Permissions**
- Script must be executable: `chmod +x script.js`
- ✅ Permissions are set correctly

### 4. **ES Modules Issues**
- Native messaging might have issues with ES modules (`import`/`export`)
- Solution: Use CommonJS (`require`) or ensure Node.js supports ES modules

### 5. **Native Manifest Location**
- macOS: `~/Library/Application Support/Thunderbird/NativeMessagingHosts/`
- Linux: `~/.thunderbird/native-messaging-hosts/`
- ✅ Manifest is in correct location

## Debugging Steps

1. **Check the debug log**:
   ```bash
   tail -f /tmp/thunderbird-native-messaging.log
   ```

2. **Test the connection**:
   - Open Thunderbird
   - Install the extension
   - Click the extension icon
   - Click "Test Connection"
   - Check the log file for errors

3. **Manual test**:
   ```bash
   # Test if the script runs
   /home/user/dev/thunderbolt/thunderbird/native-messaging/debug-wrapper.sh
   ```

4. **Common fixes**:
   - Restart Thunderbird after changing native manifests
   - Ensure Node.js is installed and accessible
   - Check Thunderbird's browser console for errors (Ctrl+Shift+J)

## Current Setup

- **Extension ID**: `thunderbird-mcp@example.com`
- **Native Host Name**: `com.thunderbird.mcp`
- **Script Path**: `/home/user/dev/thunderbolt/thunderbird/native-messaging/debug-wrapper.sh`
- **Debug Log**: `/tmp/thunderbird-native-messaging.log`

## Files Created for Debugging

1. `mcp-client-simple.js` - Simplified CommonJS version without ES modules
2. `debug-wrapper.sh` - Wrapper that logs all execution details
3. `test-native-messaging.js` - Test script with detailed logging

## Next Steps

1. Try the test connection in Thunderbird
2. Check `/tmp/thunderbird-native-messaging.log` for errors
3. Look for specific error messages in Thunderbird's browser console
4. If Node.js path is the issue, update `debug-wrapper.sh` with correct path