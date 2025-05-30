#!/home/user/n/bin/node

// Simple test script for native messaging
import { stdin, stdout } from 'process';

// Log to stderr so it doesn't interfere with the protocol
console.error('Test native messaging script started');

function sendMessage(message) {
  const json = JSON.stringify(message);
  const length = Buffer.byteLength(json);
  
  // Write 4-byte length header
  const lengthBuffer = Buffer.allocUnsafe(4);
  lengthBuffer.writeUInt32LE(length, 0);
  
  stdout.write(lengthBuffer);
  stdout.write(json);
}

let buffer = Buffer.alloc(0);

stdin.on('data', (chunk) => {
  console.error('Received data chunk:', chunk.length, 'bytes');
  buffer = Buffer.concat([buffer, chunk]);
  
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    console.error('Message length:', length);
    
    if (buffer.length >= 4 + length) {
      const messageBuffer = buffer.slice(4, 4 + length);
      const message = JSON.parse(messageBuffer.toString());
      console.error('Received message:', JSON.stringify(message));
      
      // Respond to ping with pong
      if (message.action === 'ping') {
        console.error('Sending pong response');
        sendMessage({ action: 'pong', timestamp: Date.now() });
      }
      
      buffer = buffer.slice(4 + length);
    } else {
      break;
    }
  }
});

stdin.on('end', () => {
  console.error('stdin closed');
  process.exit(0);
});

stdin.on('error', (err) => {
  console.error('stdin error:', err);
  process.exit(1);
});

// Handle process termination
process.on('SIGTERM', () => {
  console.error('Received SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.error('Received SIGINT');
  process.exit(0);
});

console.error('Waiting for messages...');