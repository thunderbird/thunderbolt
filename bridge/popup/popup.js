// Popup script for Thunderbolt Bridge
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const enableToggle = document.getElementById('enableToggle');

// Update UI based on connection status
function updateStatus(status, enabled) {
  // Update status indicator
  statusIndicator.className = 'status-indicator';
  
  if (!enabled) {
    statusIndicator.classList.add('disconnected');
    statusText.textContent = 'Bridge disabled';
  } else {
    switch (status) {
      case 'connected':
        statusIndicator.classList.add('connected');
        statusText.textContent = 'Connected to Thunderbolt';
        break;
        
      case 'error':
        statusIndicator.classList.add('error');
        statusText.textContent = 'Connection error';
        break;
        
      case 'disconnected':
      default:
        statusIndicator.classList.add('disconnected');
        statusText.textContent = 'Disconnected';
    }
  }
  
  // Update toggle
  enableToggle.checked = enabled;
}

// Get current status from background script
async function getStatus() {
  try {
    const response = await browser.runtime.sendMessage({ action: 'getStatus' });
    updateStatus(response.status, response.enabled);
  } catch (error) {
    console.error('Failed to get status:', error);
    updateStatus('error', false);
  }
}

// Handle toggle change
enableToggle.addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  
  try {
    await browser.runtime.sendMessage({
      action: 'setEnabled',
      enabled: enabled
    });
    
    // Update status after a short delay to allow connection
    setTimeout(getStatus, 1000);
  } catch (error) {
    console.error('Failed to update enabled state:', error);
    // Revert toggle on error
    enableToggle.checked = !enabled;
  }
});

// Initialize
getStatus();

// Refresh status periodically
setInterval(getStatus, 2000);