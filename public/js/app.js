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
window.addEventListener('hashchange', updatePageFromHash);
updatePageFromHash();
checkService();
const upload = { state: 'idle', file: null };
const dropzone = document.querySelector('#upload-dropzone'); const review = document.querySelector('#validation-review');
function showReview(markup, error = false) { review.hidden = false; review.classList.toggle('is-error', error); review.innerHTML = markup; }
function setUploadState(state, title, copy) { upload.state = state; document.querySelector('#upload-state-title').textContent = title; document.querySelector('#upload-state-copy').textContent = copy; }
async function validateFile(file) { if (!file || upload.state === 'validating') return; upload.file = file; if (!/\.(csv|xlsx)$/i.test(file.name)) { setUploadState('error', 'Unable to validate this file', 'Choose a CSV or XLSX file.'); showReview('<h2>Unsupported file</h2><p>Choose a CSV or XLSX file and try again.</p>', true); return; } if (file.size > 10 * 1024 * 1024) { setUploadState('error', 'Unable to validate this file', 'The file is larger than 10 MB.'); showReview('<h2>File is too large</h2><p>Choose a file smaller than 10 MB and try again.</p>', true); return; } setUploadState('validating', 'Validating your file…', 'Your file is being checked securely.'); review.hidden = true; try { const response = await fetch('/api/uploads/validate', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': file.name }, body: file }); const result = await response.json(); if (!response.ok || !result.success) throw result; const warnings = result.validation.warnings.map((item) => `<li>⚠ ${item.message}</li>`).join(''); setUploadState(result.validation.warnings.length ? 'warning' : 'success', 'File ready for review', `${result.file.name} · ${result.file.rows.toLocaleString()} source rows`); showReview(`<h2>File ready</h2><p class="file-name"><strong>${result.file.name}</strong> · ${result.file.rows.toLocaleString()} source rows</p><div class="review-stats"><div><span>Source rows</span><strong>${result.summary.sourceRows.toLocaleString()}</strong></div><div><span>Unique orders</span><strong>${result.summary.uniqueOrders.toLocaleString()}</strong></div><div><span>Product rows</span><strong>${result.summary.productRows.toLocaleString()}</strong></div></div><p><strong>Detected columns</strong><br>${Object.values(result.columns.mapped).map((c) => `✓ ${c.label}`).join(' · ')}</p>${warnings ? `<ul class="validation-list">${warnings}</ul>` : '<p>✓ No blocking issues found.</p>'}<div class="review-actions"><button class="button button-secondary" type="button" id="replace-file">Replace file</button><button class="button button-primary" type="button" disabled aria-disabled="true">Continue (available in mapping phase)</button></div>`); document.querySelector('#replace-file').onclick = () => document.querySelector('#file-upload').click(); } catch (result) { setUploadState('error', 'Unable to validate this file', 'Fix the issues below and try again.'); const details = result.details || {}; const rows = (details.errors || []).slice(0, 5).map((item) => `<li>Row ${item.row}: ${item.message}</li>`).join(''); const columns = (details.missingColumns || []).map((column) => `<li>${column}</li>`).join(''); showReview(`<h2>${result.code === 'MISSING_REQUIRED_COLUMNS' ? 'Missing required columns' : 'We couldn’t validate this file'}</h2><p>${result.message || 'Please try again.'}</p>${columns ? `<p>The following columns are required:</p><ul class="validation-list">${columns}</ul>` : ''}${rows ? `<ul class="validation-list">${rows}</ul>` : ''}<div class="review-actions"><button class="button button-secondary" type="button" id="replace-file">Choose another file</button></div>`, true); document.querySelector('#replace-file').onclick = () => document.querySelector('#file-upload').click(); } }
document.querySelector('#file-upload')?.addEventListener('change', (event) => validateFile(event.target.files[0]));
['dragenter','dragover'].forEach((event) => dropzone?.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.add('is-dragging'); setUploadState('selecting', 'Drop your file here', 'Release to start validation.'); })); ['dragleave','drop'].forEach((event) => dropzone?.addEventListener(event, (e) => { e.preventDefault(); dropzone.classList.remove('is-dragging'); if (event === 'drop') validateFile(e.dataTransfer.files[0]); else if (upload.state === 'selecting') setUploadState('idle', 'Upload your order file', 'Drag and drop your file here, or choose it from your computer.'); }));
dropzone?.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); document.querySelector('#file-upload').click(); } });
