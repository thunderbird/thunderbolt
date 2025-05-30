#!/bin/bash

# Setup script for Thunderbird MCP native messaging host

EXTENSION_ID="thunderbird-mcp@example.com"
HOST_NAME="com.thunderbird.mcp"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "🚀 Setting up Thunderbird MCP Native Messaging Host..."
echo ""

# Create native messaging host manifest
cat > "${SCRIPT_DIR}/${HOST_NAME}.json" << EOF
{
  "name": "${HOST_NAME}",
  "description": "Thunderbird MCP Server Native Messaging Host",
  "type": "stdio",
  "allowed_extensions": ["${EXTENSION_ID}"],
  "path": "${SCRIPT_DIR}/mcp-client.js"
}
EOF

# Detect platform and install manifest
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - Thunderbird uses its own directory
    MANIFEST_DIR="$HOME/Library/Application Support/Thunderbird/NativeMessagingHosts"
    PROFILE_DIR="$HOME/Library/Thunderbird/Profiles"
    PLATFORM="macOS"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux - Thunderbird uses its own directory
    MANIFEST_DIR="$HOME/.thunderbird/native-messaging-hosts"
    PROFILE_DIR="$HOME/.thunderbird"
    PLATFORM="Linux"
else
    echo "❌ Unsupported platform: $OSTYPE"
    exit 1
fi

# Create directory if it doesn't exist
mkdir -p "$MANIFEST_DIR"

# Copy manifest
cp "${SCRIPT_DIR}/${HOST_NAME}.json" "$MANIFEST_DIR/"

echo "✅ Native messaging host manifest installed!"
echo "📍 Location: $MANIFEST_DIR/${HOST_NAME}.json"
echo ""

# Try to find Thunderbird profile and extension
echo "🔍 Looking for Thunderbird profile and extension..."

if [ -d "$PROFILE_DIR" ]; then
    # Find the default profile (usually ends with .default or .default-release)
    DEFAULT_PROFILE=$(find "$PROFILE_DIR" -maxdepth 1 -type d -name "*.default*" | head -n 1)
    
    if [ -n "$DEFAULT_PROFILE" ]; then
        PROFILE_NAME=$(basename "$DEFAULT_PROFILE")
        echo "📁 Found Thunderbird profile: $PROFILE_NAME"
        
        # Look for the extension
        EXTENSION_PATH="$DEFAULT_PROFILE/extensions/$EXTENSION_ID"
        
        if [ -d "$EXTENSION_PATH" ]; then
            BRIDGE_PATH="$EXTENSION_PATH/claude-desktop-bridge.js"
            if [ -f "$BRIDGE_PATH" ]; then
                echo "✅ Found extension with bridge script!"
                echo ""
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo "📋 CLAUDE DESKTOP CONFIGURATION"
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo ""
                echo "Add this to your Claude Desktop config file:"
                echo ""
                if [ "$PLATFORM" == "macOS" ]; then
                    echo "Config file: ~/Library/Application Support/Claude/claude_desktop_config.json"
                else
                    echo "Config file: ~/.config/Claude/claude_desktop_config.json"
                fi
                echo ""
                echo "{
  \"mcpServers\": {
    \"thunderbird\": {
      \"command\": \"node\",
      \"args\": [\"$BRIDGE_PATH\"],
      \"env\": {},
      \"alwaysAllow\": [\"read\"]
    }
  }
}"
                echo ""
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            else
                echo "⚠️  Extension found but claude-desktop-bridge.js is missing."
                echo "   Make sure the extension was built with the build script."
                echo ""
                echo "💡 The bridge script should be at:"
                echo "   $BRIDGE_PATH"
            fi
        else
            echo "⚠️  Extension not found at: $EXTENSION_PATH"
            echo ""
            echo "💡 To install the extension:"
            echo "   1. Build the extension: ./build-extension.sh"
            echo "   2. In Thunderbird: Tools → Add-ons → Install Add-on From File"
            echo "   3. Select the .xpi file from the extension directory"
        fi
    else
        echo "⚠️  No default Thunderbird profile found in: $PROFILE_DIR"
    fi
else
    echo "⚠️  Thunderbird profile directory not found at: $PROFILE_DIR"
    echo "   Make sure Thunderbird is installed and has been run at least once."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 NEXT STEPS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. ✅ Native messaging host is set up"
echo "2. 🔧 Install the Thunderbird extension (if not already done)"
echo "3. 🧪 Test the connection in the extension popup"
echo "4. 📋 Add the configuration to Claude Desktop"
echo "5. 🔄 Restart Claude Desktop"
echo ""
echo "For help, see: https://github.com/your-repo/thunderbird-mcp"
echo ""