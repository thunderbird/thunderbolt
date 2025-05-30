#!/usr/bin/env node

/**
 * Native Messaging Host for Thunderbird MCP
 * Handles both connection tests and MCP server mode
 */

import { createInterface } from 'readline';
import { spawn } from 'child_process';

// Native messaging protocol helpers
function sendMessage(message) {
  const json = JSON.stringify(message);
  const length = Buffer.byteLength(json);
  
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32LE(length, 0);
  
  process.stdout.write(lengthBuffer);
  process.stdout.write(json);
}

function readMessages(callback) {
  let buffer = Buffer.alloc(0);
  
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      
      if (buffer.length >= 4 + length) {
        const messageBuffer = buffer.slice(4, 4 + length);
        const message = JSON.parse(messageBuffer.toString());
        callback(message);
        buffer = buffer.slice(4 + length);
      } else {
        break;
      }
    }
  });
}

// Check if this is being run by Claude Desktop (MCP mode)
const isMCPMode = process.env.USER === 'claude' || process.argv.includes('--mcp');

if (isMCPMode) {
  // MCP Server Mode - start the stdio server
  const mcpServer = spawn('/home/user/n/bin/node', [
    '/home/user/dev/thunderbolt/thunderbird/mcp-stdio-server.js'
  ], {
    stdio: ['inherit', 'inherit', 'inherit']
  });
  
  mcpServer.on('error', (err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
  
  mcpServer.on('close', (code) => {
    process.exit(code || 0);
  });
} else {
  // Native Messaging Mode - handle extension communication
  readMessages((message) => {
    // Handle ping messages for connection testing
    if (message.action === 'ping') {
      sendMessage({ action: 'pong', timestamp: Date.now() });
      return;
    }
    
    // Handle MCP requests
    if (message.action === 'mcp-request') {
      // Forward to extension (in a real implementation)
      // For now, just echo back
      sendMessage({
        id: message.id,
        result: {
          jsonrpc: '2.0',
          result: 'MCP request received'
        }
      });
      return;
    }
    
    // Unknown message
    sendMessage({
      id: message.id,
      error: {
        code: -32601,
        message: 'Method not found'
      }
    });
  });
  
  // Keep the process running
  process.stdin.resume();
}