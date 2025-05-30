#!/usr/bin/env node

/**
 * MCP Server Bridge for Thunderbird
 * This provides a proper MCP stdio server that Claude Desktop can connect to,
 * which communicates with the Thunderbird extension via native messaging.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';

class ThunderbirdNativeMessaging {
  constructor() {
    this.port = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Connect directly to Thunderbird via native messaging
      // We need to use the proper native messaging protocol
      this.port = spawn(process.execPath, [
        new URL('./native-messaging/mcp-client.js', import.meta.url).pathname
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let buffer = Buffer.alloc(0);
      
      this.port.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          
          if (buffer.length >= 4 + length) {
            const messageBuffer = buffer.slice(4, 4 + length);
            try {
              const message = JSON.parse(messageBuffer.toString());
              this.handleMessage(message);
            } catch (e) {
              console.error('Failed to parse message:', e);
            }
            
            buffer = buffer.slice(4 + length);
          } else {
            break;
          }
        }
      });

      this.port.stderr.on('data', (data) => {
        // Skip stderr output from the CLI client
        const output = data.toString();
        if (output.includes('Initialized:')) {
          resolve();
        }
      });

      this.port.on('error', (err) => {
        console.error('Native messaging error:', err);
        reject(err);
      });

      this.port.on('close', (code) => {
        console.error('Native messaging closed with code:', code);
      });
    });
  }

  sendMessage(message) {
    const json = JSON.stringify(message);
    const length = Buffer.byteLength(json);
    
    const lengthBuffer = Buffer.allocUnsafe(4);
    lengthBuffer.writeUInt32LE(length, 0);
    
    this.port.stdin.write(lengthBuffer);
    this.port.stdin.write(json);
  }

  sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      
      this.pendingRequests.set(id, { resolve, reject });
      
      this.sendMessage({
        jsonrpc: '2.0',
        method,
        params,
        id
      });

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  handleMessage(message) {
    if (message.id && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);
      
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result || message);
      }
    }
  }
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

// Create native messaging bridge
const thunderbird = new ThunderbirdNativeMessaging();

// Handle resource listing
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const result = await thunderbird.sendRequest('resources/list');
    return { resources: result.resources || [] };
  } catch (error) {
    console.error('Error listing resources:', error);
    return { resources: [] };
  }
});

// Handle resource reading
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const result = await thunderbird.sendRequest('resources/read', { 
      uri: request.params.uri 
    });
    return result;
  } catch (error) {
    console.error('Error reading resource:', error);
    throw error;
  }
});

// Start the server
async function main() {
  try {
    // Connect to Thunderbird
    console.error('Connecting to Thunderbird extension...');
    await thunderbird.connect();
    
    // Initialize MCP connection
    await thunderbird.sendRequest('initialize', {
      protocolVersion: '1.0.0',
      capabilities: {}
    });
    console.error('Connected to Thunderbird!');

    // Start MCP server on stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    console.error('Thunderbird MCP Server ready');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main().catch(console.error);