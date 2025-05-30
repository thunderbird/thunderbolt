#!/bin/bash

echo "Testing native messaging setup..."

# Check if manifest exists
MANIFEST_PATH="$HOME/Library/Application Support/Thunderbird/NativeMessagingHosts/com.thunderbird.mcp.json"
if [ -f "$MANIFEST_PATH" ]; then
    echo "✓ Manifest found at: $MANIFEST_PATH"
    echo "Manifest contents:"
    cat "$MANIFEST_PATH"
else
    echo "✗ Manifest not found at: $MANIFEST_PATH"
    exit 1
fi

# Check if the path in manifest exists
SCRIPT_PATH=$(cat "$MANIFEST_PATH" | grep -o '"path": "[^"]*"' | cut -d'"' -f4)
if [ -f "$SCRIPT_PATH" ]; then
    echo "✓ Script found at: $SCRIPT_PATH"
    if [ -x "$SCRIPT_PATH" ]; then
        echo "✓ Script is executable"
    else
        echo "✗ Script is not executable"
    fi
else
    echo "✗ Script not found at: $SCRIPT_PATH"
fi

echo ""
echo "To test the connection:"
echo "1. Make sure Thunderbird is running"
echo "2. Click on the Thunderbird MCP extension icon"
echo "3. Click 'Test Connection'"
echo "4. Check /tmp/thunderbird-native-messaging.log for debug output"