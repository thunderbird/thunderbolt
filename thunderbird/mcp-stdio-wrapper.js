#!/usr/bin/env node

/**
 * Simple MCP stdio wrapper for Thunderbird native messaging
 * This translates between Claude Desktop's stdio MCP and Thunderbird's native messaging
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';

// Spawn the native messaging host
const hostPath = '/home/user/dev/thunderbolt/thunderbird/native-messaging/mcp-host.sh';
const nativeHost = spawn('/bin/bash', [hostPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, THUNDERBIRD_MCP_MODE: 'server' }
});

// Handle native messaging protocol
function sendToNative(message) {
  const json = JSON.stringify(message);
  const length = Buffer.byteLength(json);
  
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32LE(length, 0);
  
  nativeHost.stdin.write(lengthBuffer);
  nativeHost.stdin.write(json);
}

let buffer = Buffer.alloc(0);
nativeHost.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    
    if (buffer.length >= 4 + length) {
      const messageBuffer = buffer.slice(4, 4 + length);
      try {
        const message = JSON.parse(messageBuffer.toString());
        // Forward to stdio
        process.stdout.write(JSON.stringify(message) + '\n');
      } catch (e) {
        console.error('Parse error:', e);
      }
      
      buffer = buffer.slice(4 + length);
    } else {
      break;
    }
  }
});

// Handle stdio input
const rl = require('readline').createInterface({
  input: process.stdin,
  output: null,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    // Forward to native messaging with mcp-request wrapper
    sendToNative({
      action: 'mcp-request',
      data: message
    });
  } catch (e) {
    console.error('Failed to parse stdio message:', e);
  }
});

nativeHost.on('error', (err) => {
  console.error('Native host error:', err);
  process.exit(1);
});

nativeHost.on('close', (code) => {
  process.exit(code || 0);
});