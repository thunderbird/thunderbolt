#!/home/user/n/bin/node

// Simple MCP Client for testing native messaging
const { stdin, stdout } = require('process');

// Native messaging protocol helpers
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
  buffer = Buffer.concat([buffer, chunk]);
  
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    
    if (buffer.length >= 4 + length) {
      const messageBuffer = buffer.slice(4, 4 + length);
      const message = JSON.parse(messageBuffer.toString());
      
      // Handle ping messages for connection testing
      if (message.action === 'ping') {
        sendMessage({ action: 'pong', timestamp: Date.now() });
      }
      
      buffer = buffer.slice(4 + length);
    } else {
      break;
    }
  }
});

// Keep the process running
stdin.resume();