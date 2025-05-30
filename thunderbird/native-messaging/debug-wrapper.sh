#!/bin/bash
# Debug wrapper for native messaging

LOG_FILE="/tmp/thunderbird-native-messaging.log"

echo "=== Native messaging started at $(date) ===" >> "$LOG_FILE"
echo "PATH=$PATH" >> "$LOG_FILE"
echo "Working directory: $(pwd)" >> "$LOG_FILE"
echo "Script arguments: $@" >> "$LOG_FILE"

# Check if node exists
if command -v node &> /dev/null; then
    echo "Node found at: $(which node)" >> "$LOG_FILE"
    echo "Node version: $(node --version)" >> "$LOG_FILE"
else
    echo "Node NOT found in PATH" >> "$LOG_FILE"
fi

# Try different node paths
NODE_PATHS=(
    "/home/user/n/bin/node"
    "/usr/local/bin/node"
    "/opt/homebrew/bin/node"
    "node"
)

NODE_EXEC=""
for NODE_PATH in "${NODE_PATHS[@]}"; do
    if [ -x "$NODE_PATH" ]; then
        echo "Found executable node at: $NODE_PATH" >> "$LOG_FILE"
        NODE_EXEC="$NODE_PATH"
        break
    fi
done

if [ -z "$NODE_EXEC" ]; then
    echo "ERROR: Could not find Node.js executable" >> "$LOG_FILE"
    exit 1
fi

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SCRIPT_PATH="$SCRIPT_DIR/mcp-client-simple.cjs"

echo "Executing: $NODE_EXEC $SCRIPT_PATH" >> "$LOG_FILE"

# Execute the Node.js script and log any errors
exec "$NODE_EXEC" "$SCRIPT_PATH" 2>> "$LOG_FILE"