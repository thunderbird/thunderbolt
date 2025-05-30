<template>
  <div id="app">
    <div class="container">
      <h1>Thunderbird MCP Server</h1>
      
      <!-- Onboarding Flow -->
      <div v-if="showOnboarding" class="onboarding-card">
        <h2>Welcome! Let's get you set up 🚀</h2>
        
        <div class="steps">
          <div class="step" :class="{ active: currentStep === 1, completed: currentStep > 1 }">
            <div class="step-number">{{ currentStep > 1 ? '✓' : '1' }}</div>
            <div class="step-content">
              <h3>Extension Installed</h3>
              <p>Great! The Thunderbird MCP extension is now installed.</p>
            </div>
          </div>
          
          <div class="step" :class="{ active: currentStep === 2, completed: currentStep > 2 }">
            <div class="step-number">{{ currentStep > 2 ? '✓' : '2' }}</div>
            <div class="step-content">
              <h3>Set up Native Messaging</h3>
              <p>This allows Claude Desktop to communicate with Thunderbird.</p>
              
              <div v-if="currentStep === 2" class="setup-instructions">
                <p>Run this command in your terminal:</p>
                <div class="command-box">
                  <code>{{ setupCommand }}</code>
                  <button @click="copyCommand" class="copy-btn">
                    {{ copied ? '✓ Copied!' : 'Copy' }}
                  </button>
                </div>
                <p class="help-text">
                  <strong>{{ osName }} users:</strong> {{ osInstructions }}
                </p>
                
                <div class="important-note">
                  <strong>⚠️ Important:</strong> You must run this command before testing the connection.
                </div>
                
                <div class="test-section">
                  <button @click="testNativeMessaging" :disabled="testingConnection" class="btn btn-primary">
                    {{ testingConnection ? 'Testing...' : 'Test Connection' }}
                  </button>
                  
                  <div v-if="connectionStatus" class="connection-status" :class="connectionStatus.success ? 'success' : 'error'">
                    <span class="status-icon">{{ connectionStatus.success ? '✅' : '❌' }}</span>
                    <span>{{ connectionStatus.message }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <div class="step" :class="{ active: currentStep === 3, completed: currentStep > 3 }">
            <div class="step-number">{{ currentStep > 3 ? '✓' : '3' }}</div>
            <div class="step-content">
              <h3>Configure Claude Desktop</h3>
              <p>Add this extension to your Claude Desktop configuration.</p>
              
              <div v-if="currentStep === 3" class="setup-instructions">
                <p>Click the button below to generate your configuration:</p>
                <button @click="generateClaudeConfig" class="btn btn-primary">
                  Generate Configuration
                </button>
                
                <div v-if="claudeConfig" class="config-display">
                  <p>Add this to your Claude Desktop config file:</p>
                  <p class="config-path"><strong>{{ configPath }}</strong></p>
                  <div class="command-box config-json">
                    <pre><code>{{ claudeConfig }}</code></pre>
                    <button @click="copyConfig" class="copy-btn">
                      {{ configCopied ? '✓ Copied!' : 'Copy' }}
                    </button>
                  </div>
                  <p v-if="pathInstructions" class="path-instructions">{{ pathInstructions }}</p>
                </div>
              </div>
            </div>
          </div>
          
          <div class="step" :class="{ active: currentStep === 4 }">
            <div class="step-number">{{ currentStep === 4 ? '✓' : '4' }}</div>
            <div class="step-content">
              <h3>All Set!</h3>
              <p>Start the server and restart Claude Desktop.</p>
              
              <div v-if="currentStep === 4" class="setup-instructions">
                <button @click="completeOnboarding" class="btn btn-success">
                  Start Using Thunderbird MCP
                </button>
              </div>
            </div>
          </div>
        </div>
        
        <div class="onboarding-footer">
          <button v-if="currentStep > 1" @click="previousStep" class="btn btn-secondary">
            Back
          </button>
          <button v-if="currentStep < 4" @click="nextStep" class="btn btn-primary" :disabled="!canProceed">
            {{ currentStep === 2 && !nativeMessagingWorking ? 'Skip for Now' : 'Next' }}
          </button>
        </div>
      </div>
      
      <!-- Normal Interface (shown after onboarding) -->
      <div v-else>
        <div class="status-card">
          <h2>Server Status</h2>
          <div class="status-indicator" :class="{ active: serverStatus.running }">
            <span class="dot"></span>
            <span>{{ serverStatus.running ? 'Running' : 'Stopped' }}</span>
          </div>
          
          <!-- Connection Status -->
          <div class="connection-overview">
            <div class="connection-item" :class="{ active: nativeMessagingWorking }">
              <span class="connection-dot"></span>
              <span>Native Messaging {{ nativeMessagingWorking ? 'Connected' : 'Disconnected' }}</span>
              <span v-if="testingConnection" class="testing-indicator">Testing...</span>
            </div>
          </div>
          
          <div v-if="serverStatus.running" class="server-info">
            <label>Connection Mode:</label>
            <code>{{ serverStatus.mode === 'native' ? 'Native Messaging' : 'Extension Messaging' }}</code>
            <p v-if="serverStatus.message" class="info-message">{{ serverStatus.message }}</p>
          </div>
          
          <div class="controls">
            <button 
              v-if="!serverStatus.running" 
              @click="startServer"
              :disabled="loading"
              class="btn btn-primary"
            >
              Start Server
            </button>
            <button 
              v-else 
              @click="stopServer"
              :disabled="loading"
              class="btn btn-danger"
            >
              Stop Server
            </button>
          </div>
          
          <div v-if="!nativeMessagingWorking" class="warning-box">
            <span class="warning-icon">⚠️</span>
            <span>Native messaging not detected. <a href="#" @click.prevent="showOnboarding = true; currentStep = 2">Set it up</a></span>
          </div>
        </div>
        
        <div class="resources-card">
          <h2>Available Resources</h2>
          <div class="resource-list">
            <div class="resource-item" v-for="resource in resources" :key="resource.name">
              <span class="resource-icon">{{ resource.icon }}</span>
              <div class="resource-info">
                <h3>{{ resource.name }}</h3>
                <p>{{ resource.description }}</p>
              </div>
              <span class="resource-count">{{ resource.count }}</span>
            </div>
          </div>
        </div>
        
        <div class="footer">
          <p>Access Thunderbird data via Model Context Protocol</p>
          <p><a href="#" @click.prevent="showOnboarding = true; currentStep = 1">Run Setup Again</a></p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watchEffect } from 'vue';

interface ServerStatus {
  running: boolean;
  mode: string | null;
  message?: string;
}

// State
const serverStatus = ref<ServerStatus>({
  running: false,
  mode: null,
  message: ''
});

const loading = ref(false);
const showOnboarding = ref(true);
const currentStep = ref(1);
const nativeMessagingWorking = ref(false);
const testingConnection = ref(false);
const connectionStatus = ref<{ success: boolean; message: string } | null>(null);
const copied = ref(false);
const configCopied = ref(false);
const claudeConfig = ref('');
const configPath = ref('');
const osName = ref('');
const osInstructions = ref('');
const setupCommand = ref('');
const pathInstructions = ref('');

const resources = ref([
  {
    name: 'Contacts',
    description: 'Access address books and contacts',
    icon: '👥',
    count: 0
  },
  {
    name: 'Emails',
    description: 'Read email messages and folders',
    icon: '📧',
    count: 0
  },
  {
    name: 'Calendar',
    description: 'View calendar events',
    icon: '📅',
    count: 0
  }
]);

// Check if running in extension context
const isExtension = typeof (window as any).browser !== 'undefined' && (window as any).browser?.runtime;

// Computed
const canProceed = computed(() => {
  if (currentStep.value === 2) {
    return true; // Allow skipping native messaging setup
  }
  return true;
});

// Methods
async function detectOS() {
  if (isExtension) {
    const info = await (window as any).browser.runtime.getPlatformInfo();
    
    switch (info.os) {
      case 'mac':
        osName.value = 'macOS';
        osInstructions.value = 'Open Terminal.app and paste the command';
        configPath.value = '~/Library/Application Support/Claude/claude_desktop_config.json';
        break;
      case 'win':
        osName.value = 'Windows';
        osInstructions.value = 'Open Command Prompt or PowerShell and paste the command';
        configPath.value = '%APPDATA%\\Claude\\claude_desktop_config.json';
        break;
      case 'linux':
        osName.value = 'Linux';
        osInstructions.value = 'Open your terminal and paste the command';
        configPath.value = '~/.config/Claude/claude_desktop_config.json';
        break;
      default:
        osName.value = 'Your OS';
        osInstructions.value = 'Open your terminal and paste the command';
        configPath.value = 'your Claude Desktop config file';
    }
    
    // Generate the setup command
    // For now, provide the manual setup command
    // In production, this would download a setup script from your repository
    if (info.os === 'mac') {
      setupCommand.value = `# First, download the native messaging files
curl -L https://github.com/your-repo/releases/latest/download/native-messaging.zip -o native-messaging.zip
unzip native-messaging.zip
cd native-messaging
./setup.sh`;
    } else {
      setupCommand.value = `# First, download the native messaging files
wget https://github.com/your-repo/releases/latest/download/native-messaging.zip
unzip native-messaging.zip
cd native-messaging
./setup.sh`;
    }
    
    // For development, use the local command
    if (window.location.hostname === 'localhost' || window.location.protocol === 'moz-extension:') {
      // Provide a more helpful command for users
      setupCommand.value = `# Clone the repository or download the native messaging files
# Then navigate to the native-messaging directory and run:
cd path/to/thunderbird-mcp/thunderbird/native-messaging
./setup.sh`;
    }
  }
}

async function testNativeMessaging() {
  testingConnection.value = true;
  connectionStatus.value = null;
  
  if (isExtension) {
    try {
      const response = await (window as any).browser.runtime.sendMessage({ action: 'testNativeMessaging' });
      
      if (response.success) {
        connectionStatus.value = {
          success: true,
          message: 'Native messaging is working! ✨'
        };
        nativeMessagingWorking.value = true;
        
        // Auto-advance after successful test
        setTimeout(() => {
          if (currentStep.value === 2) {
            nextStep();
          }
        }, 1500);
      } else {
        connectionStatus.value = {
          success: false,
          message: response.error || 'Native messaging not set up yet. Please run the setup command above first.'
        };
      }
    } catch (error) {
      connectionStatus.value = {
        success: false,
        message: 'Could not connect. Make sure you ran the setup command.'
      };
    }
  }
  
  testingConnection.value = false;
}

async function generateClaudeConfig() {
  if (isExtension) {
    try {
      // Get the proper path for the extension
      const response = await (window as any).browser.runtime.sendMessage({ action: 'getExtensionPath' });
      const bridgePath = response.path || `<extension-folder>/claude-desktop-bridge.js`;
      const pathInstructions = response.instructions || '';
      
      const config = {
        mcpServers: {
          thunderbird: {
            command: 'node',
            args: [bridgePath],
            env: {},
            alwaysAllow: ['read']
          }
        }
      };
      
      claudeConfig.value = JSON.stringify(config, null, 2);
      
      // Store the instructions for display
      if (response.instructions) {
        pathInstructions.value = response.instructions;
      }
      
      // If user wants to open in a new tab, do it here
      if (window.location.search.includes('tab=true')) {
        // We're already in a tab, just show the config
        return;
      }
    } catch (error) {
      console.error('Failed to generate config:', error);
    }
  }
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText(setupCommand.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch (e) {
    console.error('Failed to copy:', e);
  }
}

async function copyConfig() {
  try {
    await navigator.clipboard.writeText(claudeConfig.value);
    configCopied.value = true;
    setTimeout(() => { configCopied.value = false; }, 2000);
  } catch (e) {
    console.error('Failed to copy:', e);
  }
}

function nextStep() {
  if (currentStep.value < 4) {
    currentStep.value++;
  }
}

function previousStep() {
  if (currentStep.value > 1) {
    currentStep.value--;
  }
}

async function completeOnboarding() {
  // Save onboarding completion
  if (isExtension) {
    await (window as any).browser.storage.local.set({ onboardingCompleted: true });
  }
  showOnboarding.value = false;
}

// Removed openConfigInTab - now using generateClaudeConfig directly

async function checkOnboardingStatus() {
  if (isExtension) {
    const result = await (window as any).browser.storage.local.get('onboardingCompleted');
    if (result.onboardingCompleted) {
      showOnboarding.value = false;
      // Auto-test connection when popup opens if onboarding is done
      await testNativeMessaging();
    } else {
      // If still in onboarding, test connection on step 2
      if (currentStep.value === 2) {
        await testNativeMessaging();
      }
    }
  }
}

async function getServerStatus() {
  if (isExtension) {
    try {
      const response = await (window as any).browser.runtime.sendMessage({ action: 'getServerStatus' });
      serverStatus.value = response;
    } catch (error) {
      console.error('Failed to get server status:', error);
    }
  }
}

async function startServer() {
  loading.value = true;
  
  if (isExtension) {
    try {
      const response = await (window as any).browser.runtime.sendMessage({ action: 'startServer' });
      if (response.success) {
        serverStatus.value.running = true;
        serverStatus.value.mode = response.mode;
        serverStatus.value.message = response.message;
      }
    } catch (error) {
      console.error('Failed to start server:', error);
    }
  }
  
  loading.value = false;
}

async function stopServer() {
  loading.value = true;
  
  if (isExtension) {
    try {
      const response = await (window as any).browser.runtime.sendMessage({ action: 'stopServer' });
      if (response.success) {
        serverStatus.value.running = false;
        serverStatus.value.mode = null;
        serverStatus.value.message = '';
      }
    } catch (error) {
      console.error('Failed to stop server:', error);
    }
  }
  
  loading.value = false;
}

// Auto-poll for native messaging when on step 2
let pollInterval: number | null = null;

watchEffect(() => {
  if (currentStep.value === 2 && showOnboarding.value) {
    // Start polling
    if (!pollInterval) {
      pollInterval = window.setInterval(() => {
        if (!connectionStatus.value?.success) {
          testNativeMessaging();
        }
      }, 3000);
    }
  } else {
    // Stop polling
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }
});

onMounted(async () => {
  await detectOS();
  await getServerStatus();
  
  // Check if we're in tab mode
  const urlParams = new URLSearchParams(window.location.search);
  const isTabMode = urlParams.get('tab') === 'true';
  const requestedStep = parseInt(urlParams.get('step') || '1');
  
  if (isTabMode) {
    // Force show onboarding in tab mode
    showOnboarding.value = true;
    currentStep.value = requestedStep;
    
    // If we're on step 3, auto-generate the config
    if (requestedStep === 3) {
      setTimeout(() => {
        generateClaudeConfig();
      }, 500);
    }
  } else {
    await checkOnboardingStatus();
  }
});
</script>

<style scoped>
.container {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
  font-family: system-ui, -apple-system, sans-serif;
}

/* In popup mode, limit the width */
@media (max-width: 600px) {
  .container {
    max-width: 500px;
  }
}

h1 {
  font-size: 24px;
  color: #333;
  margin-bottom: 20px;
  text-align: center;
}

.onboarding-card {
  background: #f8f9fa;
  border-radius: 12px;
  padding: 30px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

.onboarding-card h2 {
  font-size: 22px;
  color: #333;
  margin-bottom: 30px;
  text-align: center;
}

.steps {
  margin-bottom: 30px;
}

.step {
  display: flex;
  gap: 20px;
  margin-bottom: 25px;
  opacity: 0.5;
  transition: opacity 0.3s;
}

.step.active, .step.completed {
  opacity: 1;
}

.step-number {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #e9ecef;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  color: #666;
  flex-shrink: 0;
}

.step.active .step-number {
  background: #007bff;
  color: white;
}

.step.completed .step-number {
  background: #28a745;
  color: white;
}

.step-content {
  flex: 1;
}

.step-content h3 {
  font-size: 18px;
  color: #333;
  margin: 0 0 8px 0;
}

.step-content p {
  font-size: 14px;
  color: #666;
  margin: 0;
}

.setup-instructions {
  margin-top: 20px;
  padding: 20px;
  background: white;
  border-radius: 8px;
  border: 1px solid #dee2e6;
}

.command-box {
  position: relative;
  margin: 15px 0;
  padding: 15px;
  background: #f8f9fa;
  border-radius: 6px;
  border: 1px solid #dee2e6;
  font-family: monospace;
  font-size: 13px;
  overflow-x: auto;
}

.command-box.config-json {
  background: #282828;
  border: 2px solid #404040;
  padding: 16px;
  padding-right: 80px; /* Space for copy button */
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}

.command-box.config-json pre {
  margin: 0;
  padding: 0;
  overflow-x: auto;
}

.command-box.config-json code {
  color: #f8f8f2;
  font-family: 'Monaco', 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre;
  display: block;
  font-weight: 500;
}

/* Better contrast for light mode */
@media (prefers-color-scheme: light) {
  .command-box.config-json {
    background: #f8f9fa;
    border: 2px solid #e9ecef;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  
  .command-box.config-json code {
    color: #212529;
  }
}

/* Always use dark theme for JSON in popup for better readability */
.container .command-box.config-json {
  background: #2d3748;
  border: 2px solid #4a5568;
}

.container .command-box.config-json code {
  color: #e2e8f0;
}

.copy-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 4px 12px;
  background: #6c757d;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.copy-btn:hover {
  background: #5a6268;
}

.help-text {
  font-size: 13px;
  color: #666;
  margin: 10px 0;
}

.test-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid #dee2e6;
}

.connection-status {
  margin-top: 15px;
  padding: 12px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}

.connection-status.success {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}

.connection-status.error {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}

.config-display {
  margin-top: 20px;
}

.config-path {
  font-size: 13px;
  color: #666;
  margin: 10px 0;
}

.path-instructions {
  margin-top: 15px;
  padding: 12px;
  background: #e3f2fd;
  border: 1px solid #90caf9;
  border-radius: 4px;
  font-size: 13px;
  color: #1565c0;
  line-height: 1.5;
  white-space: pre-wrap;
}

.onboarding-footer {
  display: flex;
  justify-content: space-between;
  margin-top: 30px;
  padding-top: 20px;
  border-top: 1px solid #dee2e6;
}

.status-card, .resources-card {
  background: #f8f9fa;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

h2 {
  font-size: 18px;
  color: #555;
  margin-bottom: 15px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 15px;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #dc3545;
}

.status-indicator.active .dot {
  background: #28a745;
}

.connection-overview {
  margin: 15px 0;
  padding: 15px;
  background: white;
  border-radius: 6px;
  border: 1px solid #dee2e6;
}

.connection-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: #666;
}

.connection-item.active {
  color: #28a745;
}

.connection-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #dc3545;
  flex-shrink: 0;
}

.connection-item.active .connection-dot {
  background: #28a745;
}

.testing-indicator {
  font-size: 12px;
  color: #007bff;
  font-style: italic;
}

.server-info {
  margin-bottom: 15px;
}

.server-info label {
  display: block;
  font-size: 14px;
  color: #666;
  margin-bottom: 5px;
}

.server-info code {
  display: block;
  padding: 8px;
  background: #e9ecef;
  border-radius: 4px;
  font-size: 12px;
  word-break: break-all;
}

.info-message {
  margin-top: 10px;
  font-size: 12px;
  color: #666;
  line-height: 1.4;
}

.controls {
  display: flex;
  gap: 10px;
}

.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: #007bff;
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: #0056b3;
}

.btn-secondary {
  background: #6c757d;
  color: white;
}

.btn-secondary:hover:not(:disabled) {
  background: #5a6268;
}

.btn-success {
  background: #28a745;
  color: white;
}

.btn-success:hover:not(:disabled) {
  background: #218838;
}

.btn-danger {
  background: #dc3545;
  color: white;
}

.btn-danger:hover:not(:disabled) {
  background: #c82333;
}

.warning-box {
  margin-top: 15px;
  padding: 12px;
  background: #fff3cd;
  border: 1px solid #ffeaa7;
  border-radius: 6px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: #856404;
}

.warning-box a {
  color: #533f03;
  font-weight: 500;
}

.resource-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.resource-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: white;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

.resource-icon {
  font-size: 24px;
}

.resource-info {
  flex: 1;
}

.resource-info h3 {
  font-size: 16px;
  color: #333;
  margin: 0 0 4px 0;
}

.resource-info p {
  font-size: 14px;
  color: #666;
  margin: 0;
}

.resource-count {
  font-size: 18px;
  font-weight: bold;
  color: #007bff;
}

.footer {
  text-align: center;
  margin-top: 20px;
}

.footer p {
  font-size: 14px;
  color: #666;
  margin: 5px 0;
}

.footer a {
  color: #007bff;
  text-decoration: none;
}

.footer a:hover {
  text-decoration: underline;
}

.important-note {
  background: #fff3cd;
  border: 1px solid #ffeaa7;
  border-radius: 4px;
  padding: 12px;
  margin-top: 15px;
  font-size: 13px;
  color: #856404;
}
</style>