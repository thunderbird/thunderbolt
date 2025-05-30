#!/bin/bash
# Native messaging host for Thunderbird MCP

# Check if we're being called by Claude Desktop (it sets specific environment variables)
if [ ! -z "$MCP_SESSION_ID" ] || [ "$1" = "--mcp" ]; then
    # MCP mode - start the stdio server
    cd /home/user/dev/thunderbolt/thunderbird
    exec /home/user/n/bin/node mcp-stdio-server.js
else
    # Native messaging mode - use the simple client for ping/pong
    cd /home/user/dev/thunderbolt/thunderbird/native-messaging
    exec /home/user/n/bin/node mcp-client-simple.cjs
fi