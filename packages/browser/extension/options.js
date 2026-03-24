const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const saveBtn = document.getElementById('save');
const statusDiv = document.getElementById('status');

// Load saved values
chrome.storage.local.get(['relayPort', 'relayToken'], (result) => {
  if (result.relayPort) portInput.value = result.relayPort;
  if (result.relayToken) tokenInput.value = result.relayToken;
});

function showStatus(text, type) {
  statusDiv.textContent = text;
  statusDiv.className = `status ${type}`;
  statusDiv.style.display = 'block';
}

saveBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    showStatus('Invalid port number (1024-65535)', 'error');
    return;
  }

  const token = tokenInput.value.trim();

  // Save
  await chrome.storage.local.set({
    relayPort: port,
    relayToken: token,
  });

  // Test connection
  showStatus('Testing connection...', 'checking');

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/`);
    if (resp.ok) {
      const data = await resp.json();
      showStatus(
        `Connected! Relay is running (extension connected: ${data.connected})`,
        'ok',
      );
    } else {
      showStatus(`Relay responded with status ${resp.status}`, 'error');
    }
  } catch {
    showStatus(
      'Cannot reach relay server. Make sure CereWorker is running with browser mode set to "extension".',
      'error',
    );
  }
});
