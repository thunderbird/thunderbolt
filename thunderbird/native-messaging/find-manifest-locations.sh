#!/bin/bash

echo "Checking all possible native messaging manifest locations for Thunderbird..."
echo ""

MANIFEST_NAME="com.thunderbird.mcp.json"

# User-specific locations
LOCATIONS=(
    "$HOME/Library/Application Support/Thunderbird/NativeMessagingHosts"
    "$HOME/Library/Mozilla/NativeMessagingHosts"
    "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    "$HOME/.thunderbird/native-messaging-hosts"
    "$HOME/.mozilla/native-messaging-hosts"
)

# Check each location
for loc in "${LOCATIONS[@]}"; do
    if [ -f "$loc/$MANIFEST_NAME" ]; then
        echo "✓ Found manifest at: $loc/$MANIFEST_NAME"
        echo "  Permissions: $(ls -l "$loc/$MANIFEST_NAME" | awk '{print $1}')"
    else
        echo "✗ Not found at: $loc/$MANIFEST_NAME"
    fi
done

echo ""
echo "System-wide locations (may require sudo to create):"

# System-wide locations
SYS_LOCATIONS=(
    "/Library/Application Support/Thunderbird/NativeMessagingHosts"
    "/Library/Mozilla/NativeMessagingHosts"
    "/Library/Application Support/Mozilla/NativeMessagingHosts"
)

for loc in "${SYS_LOCATIONS[@]}"; do
    if [ -f "$loc/$MANIFEST_NAME" ]; then
        echo "✓ Found manifest at: $loc/$MANIFEST_NAME"
    else
        echo "✗ Not found at: $loc/$MANIFEST_NAME"
    fi
done