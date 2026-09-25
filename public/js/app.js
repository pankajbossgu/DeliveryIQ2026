const statusPanel = document.querySelector('.status-panel');
const statusMessage = document.querySelector('#service-status');

async function checkService() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('Health check failed');

    statusPanel.classList.add('is-ready');
    statusMessage.textContent = 'Service foundation is online.';
  } catch {
    statusMessage.textContent = 'Service is not available yet.';
  }
}

checkService();
