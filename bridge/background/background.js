// Thunderbolt Bridge Background Script
console.log('Thunderbolt Bridge: Background script loaded');

let websocket = null;
let reconnectTimer = null;
let connectionStatus = 'disconnected';
let isEnabled = false;

// WebSocket configuration
const WS_URL = 'ws://localhost:9001';
const RECONNECT_DELAY = 5000;

// Initialize extension state
browser.storage.local.get(['enabled']).then(result => {
  isEnabled = result.enabled || false;
  if (isEnabled) {
    connect();
  }
});

// Connect to WebSocket server
function connect() {
  if (!isEnabled || websocket?.readyState === WebSocket.OPEN) {
    return;
  }

  console.log('Thunderbolt Bridge: Connecting to WebSocket server...');
  
  try {
    websocket = new WebSocket(WS_URL);
    
    websocket.onopen = () => {
      console.log('Thunderbolt Bridge: Connected to WebSocket server');
      connectionStatus = 'connected';
      updateIcon('connected');
      clearTimeout(reconnectTimer);
    };
    
    websocket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('Thunderbolt Bridge: Received message:', message);
        await handleMessage(message);
      } catch (error) {
        console.error('Thunderbolt Bridge: Error parsing message:', error);
      }
    };
    
    websocket.onerror = (error) => {
      console.error('Thunderbolt Bridge: WebSocket error:', error);
      connectionStatus = 'error';
      updateIcon('error');
    };
    
    websocket.onclose = () => {
      console.log('Thunderbolt Bridge: WebSocket connection closed');
      connectionStatus = 'disconnected';
      updateIcon('disconnected');
      websocket = null;
      
      // Reconnect if still enabled
      if (isEnabled) {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
      }
    };
  } catch (error) {
    console.error('Thunderbolt Bridge: Failed to create WebSocket:', error);
    connectionStatus = 'error';
    updateIcon('error');
  }
}

// Disconnect from WebSocket server
function disconnect() {
  console.log('Thunderbolt Bridge: Disconnecting...');
  isEnabled = false;
  clearTimeout(reconnectTimer);
  
  if (websocket) {
    websocket.close();
    websocket = null;
  }
  
  connectionStatus = 'disconnected';
  updateIcon('disconnected');
}

// Handle incoming messages from WebSocket
async function handleMessage(message) {
  if (message.type !== 'request') {
    return;
  }
  
  const { id, method, params } = message;
  let result = null;
  let error = null;
  
  try {
    switch (method) {
      case 'thunderbird_contacts':
        result = await getContacts(params);
        break;
        
      case 'thunderbird_emails':
        result = await getEmails(params);
        break;
        
      case 'thunderbird_accounts':
        result = await getAccounts();
        break;
        
      default:
        error = `Unknown method: ${method}`;
    }
  } catch (err) {
    error = err.message || 'Unknown error';
    console.error(`Thunderbolt Bridge: Error handling ${method}:`, err);
  }
  
  // Send response
  const response = {
    type: 'response',
    id,
    result,
    error
  };
  
  if (websocket?.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(response));
  }
}

// Get contacts from Thunderbird
async function getContacts(params) {
  const { query } = params || {};
  const books = await browser.addressBooks.list();
  const allContacts = [];
  
  for (const book of books) {
    const contacts = await browser.contacts.list(book.id);
    
    for (const contact of contacts) {
      // Filter by query if provided
      if (query) {
        const searchString = `${contact.properties.DisplayName} ${contact.properties.PrimaryEmail}`.toLowerCase();
        if (!searchString.includes(query.toLowerCase())) {
          continue;
        }
      }
      
      allContacts.push({
        id: contact.id,
        name: contact.properties.DisplayName,
        email: contact.properties.PrimaryEmail,
        addressBook: book.name
      });
    }
  }
  
  return allContacts;
}

// Get emails from Thunderbird
async function getEmails(params) {
  const { folder = 'INBOX', limit = 50 } = params || {};
  const accounts = await browser.accounts.list();
  const allMessages = [];
  
  for (const account of accounts) {
    if (account.type !== 'imap' && account.type !== 'pop3') {
      continue;
    }
    
    const folders = await browser.folders.list(account.id);
    const targetFolder = folders.find(f => f.name === folder || f.path === `/${folder}`);
    
    if (targetFolder) {
      const messageList = await browser.messages.list(targetFolder.id);
      const messages = messageList.messages.slice(0, limit);
      
      for (const msg of messages) {
        const full = await browser.messages.getFull(msg.id);
        
        allMessages.push({
          id: msg.id,
          subject: msg.subject,
          from: msg.author,
          date: msg.date,
          folder: targetFolder.path,
          account: account.name,
          body: extractBody(full)
        });
      }
    }
  }
  
  return allMessages;
}

// Get email accounts from Thunderbird
async function getAccounts() {
  const accounts = await browser.accounts.list();
  
  return accounts.map(account => ({
    id: account.id,
    name: account.name,
    type: account.type,
    identities: account.identities
  }));
}

// Extract body from message parts
function extractBody(messagePart) {
  if (messagePart.body) {
    return messagePart.body;
  }
  
  if (messagePart.parts) {
    for (const part of messagePart.parts) {
      const body = extractBody(part);
      if (body) {
        return body;
      }
    }
  }
  
  return '';
}

// Update extension icon based on connection status
function updateIcon(status) {
  let path;
  
  switch (status) {
    case 'connected':
      path = {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png'
      };
      break;
      
    case 'error':
    case 'disconnected':
    default:
      // TODO: Create grayed out versions of icons
      path = {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png'
      };
  }
  
  browser.browserAction.setIcon({ path });
}

// Handle messages from popup
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'getStatus':
      sendResponse({
        status: connectionStatus,
        enabled: isEnabled
      });
      break;
      
    case 'setEnabled':
      isEnabled = request.enabled;
      browser.storage.local.set({ enabled: isEnabled });
      
      if (isEnabled) {
        connect();
      } else {
        disconnect();
      }
      
      sendResponse({ success: true });
      break;
      
    default:
      sendResponse({ error: 'Unknown action' });
  }
  
  return true;
});