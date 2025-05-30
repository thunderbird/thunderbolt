// Background script for Thunderbird MCP Server extension
// Note: mcp-server.js is loaded before this script via manifest.json

// Store for MCP server status
let serverStatus = {
  running: false,
  mode: 'native', // 'native' for native messaging, 'internal' for extension-only
  connectionId: null
};

// Initialize the extension
browser.runtime.onInstalled.addListener(() => {
  console.log('Thunderbird MCP Server extension installed');
  
  // Set default settings
  browser.storage.local.set({
    serverPort: 3100,
    autoStart: true
  });
});

// Handle messages from popup
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'getServerStatus':
      sendResponse(serverStatus);
      break;
      
    case 'startServer':
      startMCPServer().then(sendResponse);
      return true; // Will respond asynchronously
      
    case 'stopServer':
      stopMCPServer().then(sendResponse);
      return true;
      
    case 'configureClaudeDesktop':
      configureClaudeDesktop().then(sendResponse);
      return true;
      
    case 'checkClaudeConfiguration':
      checkClaudeConfiguration().then(sendResponse);
      return true;
      
    case 'testNativeMessaging':
      testNativeMessaging().then(sendResponse);
      return true;
      
    case 'getExtensionPath':
      getExtensionPath().then(sendResponse);
      return true;
      
    case 'openConfigTab':
      openConfigTab(request.step).then(sendResponse);
      return true;
      
    case 'getContacts':
      getContacts(request.params).then(sendResponse);
      return true;
      
    case 'getEmails':
      getEmails(request.params).then(sendResponse);
      return true;
      
    case 'getCalendarEvents':
      getCalendarEvents(request.params).then(sendResponse);
      return true;
      
    case 'mcp-request':
      handleMCPRequest(request.data).then(sendResponse);
      return true;
  }
});

// Start MCP server (internal implementation)
async function startMCPServer() {
  try {
    // The MCP server is always available via the imported mcp-server.js
    serverStatus.running = true;
    serverStatus.mode = 'internal';
    
    console.log('MCP Server started (internal mode)');
    
    // Register native messaging if available
    if (browser.runtime.connectNative) {
      try {
        // Test native messaging availability
        serverStatus.mode = 'native';
        console.log('Native messaging available');
      } catch (e) {
        console.log('Native messaging not available, using internal mode only');
      }
    }
    
    return { 
      success: true, 
      mode: serverStatus.mode,
      message: 'MCP server running internally. Connect via native messaging or extension messaging.'
    };
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    return { success: false, error: error.message };
  }
}

// Stop MCP server
async function stopMCPServer() {
  try {
    serverStatus.running = false;
    serverStatus.mode = null;
    
    console.log('MCP Server stopped');
    return { success: true };
  } catch (error) {
    console.error('Failed to stop MCP server:', error);
    return { success: false, error: error.message };
  }
}

// Configure Claude Desktop
async function configureClaudeDesktop() {
  try {
    // Get the extension's installation directory
    // When installed as an extension, the claude-desktop-bridge.js file
    // would be located in the extension's directory
    const extensionId = browser.runtime.id;
    
    // Determine the config file path based on the platform
    const platform = await getPlatform();
    let configPath;
    let extensionPath;
    
    switch (platform) {
      case 'mac':
        configPath = '~/Library/Application Support/Claude/claude_desktop_config.json';
        // Thunderbird extensions are typically installed in the profile directory
        extensionPath = `~/Library/Thunderbird/Profiles/*/extensions/${extensionId}/claude-desktop-bridge.js`;
        break;
      case 'win':
        configPath = '%APPDATA%\\Claude\\claude_desktop_config.json';
        extensionPath = `%APPDATA%\\Thunderbird\\Profiles\\*\\extensions\\${extensionId}\\claude-desktop-bridge.js`;
        break;
      case 'linux':
        configPath = '~/.config/Claude/claude_desktop_config.json';
        extensionPath = `~/.thunderbird/*/extensions/${extensionId}/claude-desktop-bridge.js`;
        break;
      default:
        throw new Error('Unsupported platform');
    }
    
    // Create the configuration snippet - point to the native messaging host
    let hostCommand;
    switch (platform) {
      case 'mac':
        hostCommand = '~/thunderbird-mcp/thunderbird/native-messaging/mcp-host.sh';
        break;
      case 'win':
        hostCommand = '%USERPROFILE%\\thunderbird-mcp\\thunderbird\\native-messaging\\mcp-host.bat';
        break;
      case 'linux':
        hostCommand = '~/thunderbird-mcp/thunderbird/native-messaging/mcp-host.sh';
        break;
      default:
        hostCommand = '~/thunderbird-mcp/thunderbird/native-messaging/mcp-host.sh';
    }
    
    const configSnippet = {
      mcpServers: {
        thunderbird: {
          command: hostCommand,
          args: [],
          env: {},
          alwaysAllow: ['read']
        }
      }
    };
    
    // Try to use native messaging to write the config
    if (browser.runtime.connectNative) {
      try {
        // Attempt to use native messaging to configure Claude Desktop
        const port = browser.runtime.connectNative('com.thunderbird.mcp');
        
        port.postMessage({
          action: 'configureClaudeDesktop',
          config: configSnippet,
          configPath: configPath
        });
        
        return new Promise((resolve) => {
          port.onMessage.addListener((response) => {
            port.disconnect();
            if (response.success) {
              resolve({
                success: true,
                message: 'Claude Desktop configured successfully! Please restart Claude Desktop.'
              });
            } else {
              resolve({
                success: false,
                message: response.error || 'Failed to configure Claude Desktop'
              });
            }
          });
          
          port.onDisconnect.addListener(() => {
            resolve({
              success: false,
              message: 'Native messaging not available. Please configure manually.'
            });
          });
        });
      } catch (e) {
        // Native messaging not available, fall back to manual instructions
      }
    }
    
    // If native messaging is not available, provide manual instructions
    return {
      success: true,
      message: 'Copy this configuration to Claude Desktop',
      config: configSnippet,
      configPath: configPath,
      instructions: `1. Open ${configPath}\n2. Add the Thunderbird configuration to the "mcpServers" section\n3. Restart Claude Desktop`
    };
  } catch (error) {
    console.error('Failed to configure Claude Desktop:', error);
    return { success: false, error: error.message };
  }
}

// Check if Claude Desktop is configured
async function checkClaudeConfiguration() {
  try {
    // Since we can't directly read the Claude Desktop config file from a browser extension,
    // we would need to implement this check via native messaging or other means.
    // For now, return false as we cannot verify the configuration.
    
    return {
      configured: false,
      message: 'Cannot verify Claude Desktop configuration from extension'
    };
  } catch (error) {
    console.error('Failed to check Claude configuration:', error);
    return { configured: false, error: error.message };
  }
}

// Get platform information
async function getPlatform() {
  const info = await browser.runtime.getPlatformInfo();
  
  switch (info.os) {
    case 'mac':
      return 'mac';
    case 'win':
      return 'win';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

// Handle MCP requests from popup or other extensions
async function handleMCPRequest(request) {
  if (!serverStatus.running) {
    throw new Error('MCP server not running');
  }
  
  return await mcpServer.handleRequest(request);
}

// Get contacts from Thunderbird
async function getContacts(params = {}) {
  try {
    const { addressBookId, limit } = params;
    const contacts = [];
    
    // Get all address books
    const addressBooks = await messenger.addressBooks.list();
    
    for (const book of addressBooks) {
      if (addressBookId && book.id !== addressBookId) continue;
      
      // Get contacts from this address book
      const bookContacts = await messenger.contacts.list(book.id);
      
      for (const contact of bookContacts) {
        contacts.push({
          id: contact.id,
          displayName: contact.properties.DisplayName || '',
          firstName: contact.properties.FirstName || '',
          lastName: contact.properties.LastName || '',
          email: contact.properties.PrimaryEmail || '',
          phone: contact.properties.WorkPhone || contact.properties.HomePhone || '',
          organization: contact.properties.Company || '',
          addressBookId: book.id,
          addressBookName: book.name
        });
        
        if (limit && contacts.length >= limit) break;
      }
      
      if (limit && contacts.length >= limit) break;
    }
    
    return { success: true, data: contacts };
  } catch (error) {
    console.error('Failed to get contacts:', error);
    return { success: false, error: error.message };
  }
}

// Get emails from Thunderbird
async function getEmails(params = {}) {
  try {
    const { folderId, limit = 50, includeBody = false } = params;
    const messages = [];
    
    // Get all accounts
    const accounts = await messenger.accounts.list();
    
    for (const account of accounts) {
      // Get folders for this account
      const folders = await messenger.folders.list(account.id);
      
      for (const folder of folders) {
        if (folderId && folder.id !== folderId) continue;
        
        // Get messages from this folder
        const page = await messenger.messages.list(folder.id);
        
        for (const message of page.messages) {
          const messageData = {
            id: message.id,
            subject: message.subject,
            from: message.from,
            to: message.to,
            cc: message.cc,
            date: message.date,
            folder: folder.name,
            folderId: folder.id,
            read: message.read,
            flagged: message.flagged,
            accountId: account.id,
            accountName: account.name
          };
          
          // Get full message with body if requested
          if (includeBody) {
            try {
              const full = await messenger.messages.getFull(message.id);
              messageData.body = extractBody(full);
            } catch (e) {
              console.warn('Could not get message body:', e);
            }
          }
          
          messages.push(messageData);
          
          if (messages.length >= limit) break;
        }
        
        if (messages.length >= limit) break;
      }
      
      if (messages.length >= limit) break;
    }
    
    return { success: true, data: messages };
  } catch (error) {
    console.error('Failed to get emails:', error);
    return { success: false, error: error.message };
  }
}

// Extract body from message parts
function extractBody(messagePart) {
  if (messagePart.body) {
    return messagePart.body;
  }
  
  if (messagePart.parts) {
    for (const part of messagePart.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }
  
  return '';
}

// Get calendar events (using experiment API if available)
async function getCalendarEvents(params = {}) {
  try {
    // This would use the calendar experiment API when available
    // For now, return mock data
    return {
      success: true,
      data: [],
      message: 'Calendar API not yet implemented'
    };
  } catch (error) {
    console.error('Failed to get calendar events:', error);
    return { success: false, error: error.message };
  }
}

// Test native messaging connection
async function testNativeMessaging() {
  try {
    // Try to connect to native messaging host
    const port = browser.runtime.connectNative('com.thunderbird.mcp');
    
    return new Promise((resolve) => {
      let timeout = setTimeout(() => {
        port.disconnect();
        resolve({
          success: false,
          error: 'Connection timeout - native messaging may not be set up'
        });
      }, 5000);
      
      port.onMessage.addListener((message) => {
        clearTimeout(timeout);
        port.disconnect();
        resolve({
          success: true,
          message: 'Native messaging is working'
        });
      });
      
      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        if (browser.runtime.lastError) {
          let errorMsg = browser.runtime.lastError.message || 'Failed to connect to native messaging host';
          
          // Provide more helpful error messages
          if (errorMsg.includes('No such native application')) {
            errorMsg = 'Native messaging not installed. Please run the setup command first.';
          }
          
          resolve({
            success: false,
            error: errorMsg
          });
        } else {
          resolve({
            success: false,
            error: 'Native messaging host disconnected'
          });
        }
      });
      
      // Send a test message
      port.postMessage({ action: 'ping' });
    });
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Failed to connect to native messaging host'
    };
  }
}

// Get extension path for configuration
async function getExtensionPath() {
  try {
    const platform = await getPlatform();
    
    // Return the native messaging host path for Claude Desktop config
    let hostPath;
    let instructions = '';
    
    switch (platform) {
      case 'mac':
        hostPath = '~/thunderbird-mcp/thunderbird/native-messaging/mcp-host.sh';
        instructions = 'Replace "~/thunderbird-mcp" with the actual path where you downloaded/cloned the Thunderbird MCP files.\n\nExample: If you cloned to ~/Documents/thunderbird-mcp, use:\n~/Documents/thunderbird-mcp/thunderbird/native-messaging/mcp-host.sh';
        break;
      case 'win':
        hostPath = '%USERPROFILE%\\thunderbird-mcp\\thunderbird\\native-messaging\\mcp-host.bat';
        instructions = 'Replace "thunderbird-mcp" with the actual folder where you downloaded the extension files. You may need to create a .bat wrapper script for Windows.';
        break;
      case 'linux':
        hostPath = '~/thunderbird-mcp/thunderbird/native-messaging/mcp-host.sh';
        instructions = 'Replace "~/thunderbird-mcp" with the actual path where you downloaded/cloned the Thunderbird MCP files.';
        break;
      default:
        hostPath = '~/thunderbird-mcp/thunderbird/native-messaging/mcp-host.sh';
        instructions = 'Replace "~/thunderbird-mcp" with the actual path where you downloaded the extension files.';
    }
    
    return { 
      path: hostPath,
      instructions: instructions,
      extensionId: browser.runtime.id
    };
  } catch (error) {
    console.error('Failed to get extension path:', error);
    return { 
      path: '~/thunderbird-mcp/thunderbird/native-messaging/mcp-host.sh',
      instructions: 'Update the path to match where you downloaded the Thunderbird MCP extension files.',
      extensionId: 'unknown'
    };
  }
}

// Open configuration in a new tab
async function openConfigTab(step) {
  try {
    // Get the popup URL
    const popupUrl = browser.runtime.getURL('popup/index.html');
    
    // Add query parameter to indicate we're in tab mode and which step to show
    const tabUrl = `${popupUrl}?tab=true&step=${step || 1}`;
    
    // Open in a new tab
    await browser.tabs.create({
      url: tabUrl,
      active: true
    });
    
    return { success: true };
  } catch (error) {
    console.error('Failed to open config tab:', error);
    return { success: false, error: error.message };
  }
}

// Auto-start server if enabled
browser.storage.local.get('autoStart').then(result => {
  if (result.autoStart) {
    startMCPServer();
  }
});