#!/bin/bash
# Wrapper script for mcp-client.js that ensures Node.js is found

# Use the absolute path to Node.js
NODE_PATH="/home/user/n/bin/node"

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Execute the Node.js script
exec "$NODE_PATH" "$SCRIPT_DIR/mcp-client.js"