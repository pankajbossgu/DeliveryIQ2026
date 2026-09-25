const statusPanel = document.querySelector('.sidebar-footer');
const statusMessage = document.querySelector('#service-status');
const pages = document.querySelectorAll('[data-page-panel]');
const mobileNavigation = document.querySelector('#mobile-navigation');
const menuButton = document.querySelector('.menu-button');
const filterSummary = document.querySelector('#filter-summary');

function selectPage(pageName) {
  const selectedPage = [...pages].some((page) => page.dataset.pagePanel === pageName) ? pageName : 'dashboard';
  document.querySelectorAll('[data-page]').forEach((link) => link.classList.toggle('is-active', link.dataset.page === selectedPage));
  pages.forEach((page) => { page.hidden = page.dataset.pagePanel !== selectedPage; });
  const pageLink = document.querySelector(`[data-page="${selectedPage}"]`);
  document.title = `${selectedPage === 'dashboard' ? 'Delivery intelligence' : pageLink.textContent.trim()} | DeliveryIQ`;
  mobileNavigation.hidden = true;
  menuButton?.setAttribute('aria-expanded', 'false');
}
function updatePageFromHash() { selectPage(window.location.hash.slice(1) || 'dashboard'); }
function setFileMessage(event) {
  const file = event.target.files[0];
  if (file) document.querySelector('.upload-help').textContent = `${file.name} selected. Upload processing will be added in the next milestone.`;
}
async function checkService() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('Health check failed');
    statusPanel.classList.add('is-ready');
    statusMessage.textContent = 'Service online';
  } catch { statusMessage.textContent = 'Service unavailable'; }
}
mobileNavigation.innerHTML = document.querySelector('.navigation').innerHTML;
menuButton?.addEventListener('click', () => { const isOpen = mobileNavigation.hidden; mobileNavigation.hidden = !isOpen; menuButton.setAttribute('aria-expanded', String(isOpen)); });
document.querySelector('[data-action="filters"]')?.addEventListener('click', () => { filterSummary.hidden = false; });
document.querySelector('[data-action="close-filters"]')?.addEventListener('click', () => { filterSummary.hidden = true; });
document.querySelector('#file-upload')?.addEventListener('change', setFileMessage);
window.addEventListener('hashchange', updatePageFromHash);
updatePageFromHash();
checkService();
