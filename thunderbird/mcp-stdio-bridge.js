#!/usr/bin/env node

/**
 * MCP stdio bridge for Thunderbird extension
 * This acts as a stdio MCP server that Claude Desktop can connect to,
 * forwarding requests to the Thunderbird extension via native messaging.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'child_process';

// Native messaging protocol
function sendNativeMessage(port, message) {
  const json = JSON.stringify(message);
  const length = Buffer.byteLength(json);
  
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32LE(length, 0);
  
  port.stdin.write(lengthBuffer);
  port.stdin.write(json);
}

function readNativeMessages(port, callback) {
  let buffer = Buffer.alloc(0);
  
  port.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      
      if (buffer.length >= 4 + length) {
        const messageBuffer = buffer.slice(4, 4 + length);
        try {
          const message = JSON.parse(messageBuffer.toString());
          callback(message);
        } catch (e) {
          console.error('Failed to parse native message:', e);
        }
        
        buffer = buffer.slice(4 + length);
      } else {
        break;
      }
    }
  });
}

// Main server
async function main() {
  // Connect to Thunderbird extension via native messaging
  console.error('Starting Thunderbird MCP stdio bridge...');
  
  // Use the native application ID directly
  const nativeApp = spawn('/Applications/Thunderbird.app/Contents/MacOS/thunderbird', [
    '--native-messaging-hosts',
    'com.thunderbird.mcp'
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // Actually, we need to connect to the native messaging host directly
  const hostPath = '/home/user/Library/Application Support/Thunderbird/NativeMessagingHosts/com.thunderbird.mcp.json';
  
  // Read the manifest to get the actual path
  const fs = await import('fs');
  const manifest = JSON.parse(fs.readFileSync(hostPath, 'utf8'));
  
  // Spawn the native messaging host
  const nativeHost = spawn(manifest.path, [], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let requestId = 0;
  const pendingRequests = new Map();

  // Handle messages from native host
  readNativeMessages(nativeHost, (message) => {
    if (message.id && pendingRequests.has(message.id)) {
      const { resolve } = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      resolve(message);
    }
  });

  nativeHost.on('error', (err) => {
    console.error('Native host error:', err);
    process.exit(1);
  });

  nativeHost.on('close', (code) => {
    console.error('Native host closed with code:', code);
    process.exit(code || 0);
  });

  // Helper to send requests to Thunderbird
  function sendToThunderbird(action, data = {}) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pendingRequests.set(id, { resolve, reject });
      
      sendNativeMessage(nativeHost, {
        action,
        ...data,
        id
      });

      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  // Test native messaging connection
  try {
    console.error('Testing native messaging connection...');
    const pong = await sendToThunderbird('ping');
    console.error('Native messaging connected!');
  } catch (error) {
    console.error('Failed to connect to Thunderbird:', error);
    process.exit(1);
  }

  // Create MCP server
  const server = new Server({
    name: 'thunderbird',
    version: '1.0.0',
    description: 'Access Thunderbird data via MCP'
  }, {
    capabilities: {
      resources: {}
    }
  });

  // Handle all requests by forwarding to Thunderbird
  server.setRequestHandler('initialize', async (request) => {
    const response = await sendToThunderbird('mcp-request', {
      data: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: request.params,
        id: request.id
      }
    });
    return response.result || response;
  });

  server.setRequestHandler('resources/list', async (request) => {
    const response = await sendToThunderbird('mcp-request', {
      data: {
        jsonrpc: '2.0',
        method: 'resources/list',
        params: request.params || {},
        id: request.id
      }
    });
    return response.result || response;
  });

  server.setRequestHandler('resources/read', async (request) => {
    const response = await sendToThunderbird('mcp-request', {
      data: {
        jsonrpc: '2.0',
        method: 'resources/read',
        params: request.params,
        id: request.id
      }
    });
    return response.result || response;
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Thunderbird MCP Server ready for Claude Desktop');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});