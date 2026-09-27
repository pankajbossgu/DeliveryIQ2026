
const uploadLimits = globalThis.DeliveryIQLimits;
const ACTIVE_PROCESS_STATUSES = new Set(['queued', 'processing', 'review_required', 'finalizing', 'failed']);
const state = { upload: null, result: null, processId: null, selectedReportType: null, config: { statusCategories: ['Delivered', 'In Transit', 'NDR', 'RTO', 'Cancelled', 'Other'], masterCategories: [], productCategories: [] }, reportId: null, restoring: true, restorePromise: null, validating: false, cancelling: false, configLoaded: false, retryingProduct: null, bulkRetry: null, approvedProductsOpen: false, openSuggestionHistories: new Set(), productErrors: new Map(), productSaving: new Set(), selectedProducts: new Set(), selectedStatuses: new Set(), statusSaving: new Set(), statusBulkSaving: false, statusBulkError: '', statusErrors: new Map(), bulkSaving: false, bulkAction: '', bulkError: '', reviewFeedback: '', generating: false, universal: { page: 1, limit: 25, controller: null, detailCache: new Map(), loading: false }, mappingAdmin: { products: null, masters: null, categories: null, statuses: null, productRequest: 0, statusRequest: 0, productLoading: false, statusLoading: false, productSaveGeneration: 0, statusSaveGeneration: 0, productSavingCount: 0, statusSavingCount: 0, categorySaving: false } };
const $ = (selector) => document.querySelector(selector);
$('#upload-help').textContent = `CSV or XLSX · Up to ${uploadLimits.maxSourceRows.toLocaleString('en-US')} non-empty rows · ${uploadLimits.maxFileBytes / (1024 * 1024)} MB maximum`;
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function clear(node) { node.replaceChildren(); }
/* Keep native selects as the source of truth, while presenting a consistent,
   keyboard-friendly menu instead of the browser's platform-specific picker. */
let activePremiumSelect;
function closePremiumSelect(control = activePremiumSelect) { if (!control) return; control.menu.hidden = true; control.trigger.setAttribute('aria-expanded', 'false'); if (activePremiumSelect === control) activePremiumSelect = null; }
function refreshPremiumSelect(select) {
  const control = select._premiumSelect;
  if (!control) return;
  const selected = select.options[select.selectedIndex];
  control.label.textContent = selected?.textContent || 'Choose an option';
  control.trigger.disabled = select.disabled;
  clear(control.menu);
  [...select.options].forEach((option, index) => {
    const choice = el('button', option.textContent, 'premium-select-option');
    choice.type = 'button'; choice.role = 'option'; choice.dataset.index = String(index);
    choice.disabled = option.disabled;
    choice.setAttribute('aria-selected', String(option.selected));
    if (option.selected) choice.classList.add('is-selected');
    choice.addEventListener('click', () => { select.selectedIndex = index; select.dispatchEvent(new Event('change', { bubbles: true })); closePremiumSelect(control); control.trigger.focus(); });
    control.menu.append(choice);
  });
}
function enhanceSelect(select) {
  if (select._premiumSelect || select.multiple || select.closest('.premium-select')) return;
  const shell = el('div', undefined, 'premium-select');
  const trigger = el('button', undefined, 'premium-select-trigger'); trigger.type = 'button';
  const label = el('span', undefined, 'premium-select-value');
  const icon = el('span', '⌄', 'premium-select-chevron'); icon.setAttribute('aria-hidden', 'true');
  const menu = el('div', undefined, 'premium-select-menu'); menu.hidden = true; menu.role = 'listbox';
  const id = select.id || `premium-select-${Math.random().toString(36).slice(2)}`; select.id = id;
  trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${id}-menu`); menu.id = `${id}-menu`;
  trigger.append(label, icon); select.replaceWith(shell); shell.append(select, trigger, menu);
  const control = { shell, trigger, label, menu }; select._premiumSelect = control;
  trigger.addEventListener('click', () => { const opening = menu.hidden; if (activePremiumSelect && activePremiumSelect !== control) closePremiumSelect(); menu.hidden = !opening; trigger.setAttribute('aria-expanded', String(opening)); activePremiumSelect = opening ? control : null; if (opening) menu.querySelector('.is-selected:not(:disabled), .premium-select-option:not(:disabled)')?.focus(); });
  trigger.addEventListener('keydown', (event) => { if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return; event.preventDefault(); if (menu.hidden) trigger.click(); const options = [...menu.querySelectorAll('.premium-select-option:not(:disabled)')]; const current = options.indexOf(document.activeElement); options[Math.max(0, Math.min(options.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)))]?.focus(); });
  menu.addEventListener('keydown', (event) => { const options = [...menu.querySelectorAll('.premium-select-option:not(:disabled)')]; const index = options.indexOf(document.activeElement); if (event.key === 'Escape') { closePremiumSelect(control); trigger.focus(); } if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus(); } if (event.key === 'Enter' || event.key === ' ') document.activeElement?.click(); });
  select.addEventListener('change', () => refreshPremiumSelect(select));
  new MutationObserver(() => refreshPremiumSelect(select)).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  refreshPremiumSelect(select);
}
function enhanceAllSelects(root = document) { root.querySelectorAll?.('select').forEach(enhanceSelect); }
function replacePremiumSelect(select, replacement) { (select._premiumSelect?.shell || select).replaceWith(replacement); return replacement; }
document.addEventListener('pointerdown', (event) => { if (activePremiumSelect && !activePremiumSelect.shell.contains(event.target)) closePremiumSelect(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePremiumSelect(); });
new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => { if (node.nodeType !== Node.ELEMENT_NODE) return; if (node.matches?.('select')) enhanceSelect(node); enhanceAllSelects(node); }))).observe(document.documentElement, { childList: true, subtree: true });
enhanceAllSelects();
function page(name) { if (typeof closeMobileMenu === 'function') closeMobileMenu(); document.querySelectorAll('[data-page-panel]').forEach((node) => { node.hidden = node.dataset.pagePanel !== name; }); document.querySelectorAll('[data-page]').forEach((node) => node.classList.toggle('is-active', node.dataset.page === name)); if (name === 'upload') restoreActiveProcess(); if (name === 'reports' || name === 'history') return loadReports(); if (name === 'universal') loadUniversal(); if (name === 'products') loadProducts(); if (name === 'statuses') loadStatuses(); }
function setUpload(title, text) { $('#upload-state-title').textContent = title; $('#upload-state-copy').textContent = text; }
function setWorkflowStep(active, completed = []) { const steps = [...document.querySelectorAll('#upload-workflow > .workflow-stepper li')]; steps.forEach((step, index) => { const complete = completed.includes(index); step.classList.toggle('is-active', index === active); step.classList.toggle('is-complete', complete); step.setAttribute('aria-current', index === active ? 'step' : 'false'); const number = step.querySelector('.workflow-step-number'); if (number) number.textContent = complete ? '✓' : String(index + 1); }); }
function fileSize(bytes) { return `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 ? 1 : 2)} MB`; }
function setSelectedFile(file, status = 'selected') { const details = $('#selected-file'); if (!file) { details.hidden = true; return; } const loading = status === 'uploading' || status === 'validating'; details.hidden = false; $('#selected-file-name').textContent = file.name; $('#selected-file-meta').textContent = fileSize(file.size); $('#selected-file-status').textContent = status === 'uploading' ? 'Uploading file…' : status === 'validating' ? 'Checking your file…' : status === 'success' ? '✓ File validated successfully' : '✓ File selected'; $('#selected-file').classList.toggle('is-validating', loading); $('#selected-file').classList.toggle('is-success', status === 'success'); $('#remove-selected-file').hidden = loading || status === 'success'; }
function resetSelectedFile() { if (state.restoring || state.validating || state.processId) return; state.upload = null; $('#file-upload').value = ''; setSelectedFile(null); clearNotice(); const name = state.selectedReportType === 'full' ? 'Full Report' : 'Simple Report'; setUpload(`Upload your ${name} file`, 'Drag and drop your CSV or Excel file here, or choose it from your computer.'); setUploadLocked(null); }
const REPORT_TEMPLATES = { simple: { description: "Don't have a file ready? Start with our optional Simple Report template.", downloads: [['Download Simple CSV', '/api/uploads/template/simple.csv'], ['Download Simple Excel', '/api/uploads/template/simple.xlsx']] }, full: { description: "Don't have a detailed delivery file ready? Start with our optional Full Report template.", downloads: [['Download Full CSV', '/api/uploads/template/full.csv'], ['Download Full Excel', '/api/uploads/template/full.xlsx']] } };
function renderSelectedTemplates(type) { const template = REPORT_TEMPLATES[type]; const actions = $('#template-actions'); clear(actions); if (!template) { $('#template-card-copy').textContent = ''; return; } $('#template-card-copy').textContent = template.description; template.downloads.forEach(([label, href]) => { const link = el('a', label, 'button button-secondary'); link.href = href; link.download = ''; actions.append(link); }); }
function renderReportTypeSelection() { const selected = state.selectedReportType; $('#report-type-selector').hidden = Boolean(selected); $('#upload-workflow').hidden = !selected; document.querySelectorAll('[data-report-type]').forEach((button) => { const active = button.dataset.reportType === selected; button.setAttribute('aria-pressed', String(active)); button.closest('.report-type-card').classList.toggle('is-selected', active); }); renderSelectedTemplates(selected); if (!selected) return; const name = selected === 'full' ? 'Full Report' : 'Simple Report'; $('#selected-report-type').textContent = name; $('#selected-report-title').textContent = name; $('#selected-report-description').textContent = `Upload your ${name} file.`; }
function selectReportType(type) { state.selectedReportType = type; setWorkflowStep(0); $('#file-upload').value = ''; state.upload = null; setSelectedFile(null); clearNotice(); renderReportTypeSelection(); setUpload(`Upload your ${type === 'full' ? 'Full Report' : 'Simple Report'} file`, 'Drag and drop your CSV or Excel file here, or choose it from your computer.'); setUploadLocked(null); }
function changeReportType() { const clearSelection = () => { state.selectedReportType = null; state.upload = null; $('#file-upload').value = ''; setSelectedFile(null); clearNotice(); renderReportTypeSelection(); }; if (!state.upload) return clearSelection(); const content = el('div'); content.append(el('p', 'Changing the report type will clear the current selected file. Continue?')); modal({ title: 'Change report type?', description: 'Your selected file has not been uploaded and will be cleared.', destructive: true, content, submitText: 'Continue', onSubmit: async () => clearSelection() }); }
function setUploadLocked(process) { const locked = state.restoring || state.validating || Boolean(process); $('#file-upload').disabled = locked; $('#upload-dropzone').classList.toggle('is-locked', locked); $('#upload-dropzone').setAttribute('aria-disabled', String(locked)); $('#remove-selected-file').disabled = locked; document.querySelectorAll('[data-report-type]').forEach((button) => { button.disabled = locked; }); $('#change-report-type').disabled = locked; if (process && process.status !== 'review_required') setUpload('Report processing in progress', `Current report: ${process.file.name}. Processing is underway.`); }
function notice(title, text, bad = false) { const node = $('#validation-review'); node.hidden = false; node.classList.toggle('is-error', bad); node.classList.remove('validation-loading'); node.removeAttribute('role'); clear(node); node.append(el('h2', title), el('p', text)); return node; }
function clearNotice() { $('#validation-review').hidden = true; clear($('#validation-review')); }
function validationLoading() { const target = notice('Checking your file…', 'Validating the uploaded file structure, columns, and rows.'); target.classList.add('validation-loading'); target.setAttribute('aria-live', 'assertive'); target.prepend(el('span', '', 'report-spinner')); return target; }
function validationAction(target) { const actions = el('div', undefined, 'validation-actions'); const choose = el('button', 'Choose another file', 'button button-primary'); choose.type = 'button'; choose.addEventListener('click', () => $('#file-upload').click()); const template = REPORT_TEMPLATES[state.selectedReportType]; actions.append(choose); if (template) { const download = el('a', 'Download template', 'button button-secondary'); download.href = template.downloads[0][1]; download.download = ''; actions.append(download); } target.append(actions); }
function validationFailure(result) { const target = notice('⚠ File could not be validated', result.message || 'Please correct the file and upload it again.', true); target.setAttribute('role', 'alert'); const details = result.details || {}; const count = details.errorCount || details.missingColumns?.length || details.unknownColumns?.length || details.conflictCount || 1; target.append(el('p', `${count} issue${count === 1 ? '' : 's'} found`, 'validation-count'));
  if (details.missingColumns?.length) { const group = el('section', undefined, 'validation-issue-group'); group.append(el('h3', 'Missing required columns')); const list = el('ul'); details.missingColumns.forEach((column) => list.append(el('li', column))); group.append(list, el('p', 'Please add these columns and upload the file again.')); target.append(group); }
  if (details.unknownColumns?.length) { const group = el('section', undefined, 'validation-issue-group'); group.append(el('h3', 'Unexpected columns for this report type')); const list = el('ul'); details.unknownColumns.forEach((column) => list.append(el('li', column))); group.append(list, el('p', 'Choose the matching report type, or remove/rename these headers before uploading.')); target.append(group); }
  if (details.errors?.length) { const byField = new Map(); details.errors.forEach((item) => { const key = item.column || item.field || 'Other data'; const group = byField.get(key) || []; group.push(item); byField.set(key, group); }); const group = el('section', undefined, 'validation-issue-group'); group.append(el('h3', 'Invalid or missing data')); [...byField.entries()].slice(0, 8).forEach(([field, items]) => { const entry = el('article', undefined, 'validation-row-issue'); const rows = items.map((item) => item.row).filter(Number.isFinite); const preview = rows.slice(0, 5).join(', '); entry.append(el('strong', field), el('p', `${items.length} row${items.length === 1 ? '' : 's'}: ${preview ? `Row${rows.length === 1 ? '' : 's'} ${preview}${rows.length > 5 ? '…' : ''}` : 'See file for details.'}`), el('span', items[0].message)); group.append(entry); }); if (details.errorCount > details.errors.length) group.append(el('p', `Showing ${details.errors.length} of ${details.errorCount} issues.`)); target.append(group); }
  if (details.conflicts?.length) { const group = el('section', undefined, 'validation-issue-group'); group.append(el('h3', 'Conflicting order data')); details.conflicts.slice(0, 8).forEach((item) => group.append(el('p', `${item.orderId} — ${item.field} differs on rows ${item.rows.slice(0, 5).join(', ')}${item.rows.length > 5 ? '…' : ''}.`))); target.append(group); }
  validationAction(target); return target;
}
function showRestoring() { document.body.classList.add('upload-restoring'); state.upload = null; $('#file-upload').value = ''; setUpload('Checking your reports...', 'Checking for unfinished reports.'); setUploadLocked(null); const target = notice('Checking your reports...', 'Checking for unfinished reports.'); target.classList.add('report-restoration-loading'); target.prepend(el('span', '', 'report-spinner')); if (!state.restoreModal) { const backdrop = el('div', undefined, 'app-modal-backdrop report-check-modal'); const dialog = el('section', undefined, 'app-modal'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'report-check-title'); const heading = el('h2', 'Checking your reports...'); heading.id = 'report-check-title'; dialog.append(heading, el('p', 'Checking for unfinished reports.', 'app-modal-description'), el('span', '', 'report-spinner')); backdrop.append(dialog); document.body.append(backdrop); state.restoreModal = backdrop; } }
function hideRestoreModal() { state.restoreModal?.remove(); state.restoreModal = null; }
function restorationFailed(message = "Couldn't check your current report.") { const target = notice(message, 'Please try again.', true); const retry = el('button', 'Retry', 'button button-primary'); retry.type = 'button'; retry.addEventListener('click', restoreActiveProcess); target.append(retry); }
function hasReviewSnapshot(process) { return Array.isArray(process?.classifications?.statuses) && Array.isArray(process?.classifications?.products); }
function unresolvedCount(process) { const classifications = process.classifications || {}; return [...(classifications.statuses || []), ...(classifications.products || [])].filter((item) => item.classificationRequired).length; }
function renderReviewResume(process) { const classifications = process.classifications || {}; const productsRemaining = (classifications.products || []).filter((item) => item.classificationRequired).length; const statusesRemaining = (classifications.statuses || []).filter((item) => item.classificationRequired).length; const suggestionsRemaining = (classifications.products || []).filter((item) => item.classificationRequired && item.suggestedProductCategory).length; const remaining = productsRemaining + statusesRemaining; if (!remaining) return renderReview(); const target = notice('Previous report needs your attention', 'Your previous report is not finished yet. Continue where you left off, or remove it before uploading a new file.'); const stats = el('div', undefined, 'review-stats'); [['Products remaining', productsRemaining], ['Statuses remaining', statusesRemaining], ['AI suggestions remaining', suggestionsRemaining], ['Total unresolved items', remaining]].forEach(([label, value]) => { const card = el('div'); card.append(el('span', label), el('strong', String(value))); stats.append(card); }); const actions = el('div', undefined, 'review-actions'); const continueReview = el('button', 'Continue Review', 'button button-primary'); continueReview.type = 'button'; continueReview.addEventListener('click', () => renderReview()); const remove = el('button', 'Clear Result', 'button button-danger'); remove.type = 'button'; remove.addEventListener('click', removeReportModal); actions.append(continueReview, remove); target.append(stats, actions); }
async function refreshConfig() { const response = await fetch('/api/classifications/config'); if (!response.ok) throw new Error('Configuration could not be loaded.'); const config = await response.json(); state.config = config; state.configLoaded = true; universalRefreshCategories(); }
function choices(select, values, initial = 'All') { const current = select.value; clear(select); select.append(new Option(initial, '')); values.filter(Boolean).sort().forEach((value) => select.append(new Option(value, value))); select.value = values.includes(current) ? current : ''; }
function universalRefreshCategories() { const select = $('#universal-filters')?.elements.categoryStatus; if (select) choices(select, [...new Set(state.config.statusCategories || [])], 'All categories'); }
function renderValidation() { setWorkflowStep(1, [0]); const target = notice('✓ File validated successfully', 'Your file is valid and ready for the next step.'); const stats = el('div', undefined, 'review-stats'); [['File', state.upload?.name || state.result.file?.name || 'Uploaded file'], ['Orders', state.result.summary.uniqueOrders], ['Product rows', state.result.summary.productRows], ['Unique products', state.result.summary.detectedProducts], ['Report type', state.result.templateType === 'full' ? 'Full Report' : 'Simple Report']].forEach(([label, value]) => { const card = el('div'); card.append(el('span', label), el('strong', String(value))); stats.append(card); }); const start = el('button', 'Start Generating Report', 'button button-primary'); start.type = 'button'; start.addEventListener('click', startProcessing); target.append(stats, start); }
function activeUploadBlocked() { if (!state.processId) return false; const process = { status: state.result?.status || 'review_required' }; if (process.status === 'review_required') renderReview(); else notice('Current report is unfinished', 'Your current report needs to be completed before you can upload another file.', true); return true; }
async function validateFile(file) { if (state.restoring || state.validating || !state.selectedReportType || !file || activeUploadBlocked()) return; state.upload = file; clearNotice(); setSelectedFile(file); if (!/\.(csv|xlsx)$/i.test(file.name)) { setUpload('Unsupported file type', 'Please upload a CSV or XLSX file.'); return validationFailure({ code: 'UNSUPPORTED_FILE_TYPE', message: 'Only CSV and XLSX files are supported.' }); } if (file.size > uploadLimits.maxFileBytes) { const maximumSize = `${uploadLimits.maxFileBytes / (1024 * 1024)} MB`; setUpload('File is too large', `Maximum supported size: ${maximumSize}. Please choose a smaller file.`); return validationFailure({ code: 'FILE_TOO_LARGE', message: `The uploaded file is larger than the ${maximumSize} file limit.` }); } state.validating = true; setWorkflowStep(1, [0]); setSelectedFile(file, 'uploading'); setUploadLocked(null); setUpload('Uploading file…', 'Your file is being sent securely for validation.'); await new Promise((resolve) => requestAnimationFrame(resolve)); setSelectedFile(file, 'validating'); setUpload('Checking your file…', `Checking file structure, columns, and the ${uploadLimits.maxSourceRows.toLocaleString('en-US')}-row limit.`); validationLoading(); try { const response = await fetch('/api/uploads/validate', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': file.name, 'x-template-type': state.selectedReportType, 'x-report-request-id': crypto.randomUUID() }, body: file }); const result = await response.json().catch(() => ({})); if (!response.ok) { if (result.code === 'ACTIVE_REPORT_PROCESS') { if (result.process.status === 'review_required') { if (!hasReviewSnapshot(result.process)) return restorationFailed("Couldn't restore your report."); if (!state.configLoaded) { try { await refreshConfig(); } catch (error) { return restorationFailed("Couldn't restore your report."); } } } applyProcess(result.process); setUploadLocked(result.process); return result.process.status === 'review_required' ? renderReview(result.process) : renderProcessing(result.process); } setSelectedFile(file); return validationFailure(result); } applyProcess(result.process); setSelectedFile(file, 'success'); setUpload('File validated successfully', `${file.name} is valid. Preparing the report review workflow.`); renderValidation(); } catch (error) { setSelectedFile(file); validationFailure({ code: 'SERVER_ERROR', message: 'We could not validate the file because the server did not respond. Please try again.' }); } finally { state.validating = false; if (!state.processId) setUploadLocked(null); } }
function renderProcessing(process) { const stages = [['preparing_data', 'Preparing your file'], ['checking_status_mappings', 'Checking status mappings'], ['mapping_statuses', 'Mapping statuses'], ['checking_products', 'Checking products'], ['ai_product_classification', 'Classifying unknown products'], ['preparing_review', 'Reviewing suggestions'], ['finalizing_report', 'Finalizing report']]; const active = Math.max(0, stages.findIndex(([key]) => key === process.stage)); const current = stages[active][1]; const target = notice(current, `${current}. You can safely refresh this page while the server continues processing.`); const progress = el('section', undefined, 'current-process-status'); progress.setAttribute('aria-live', 'polite'); progress.append(el('span', `Step ${active + 1} of ${stages.length}`, 'current-process-count'), el('strong', current), el('p', `${active} completed · ${stages.length - active - 1} upcoming`)); const meter = el('div', undefined, 'current-process-meter'); meter.setAttribute('role', 'progressbar'); meter.setAttribute('aria-label', `Report processing: ${current}`); meter.setAttribute('aria-valuemin', '1'); meter.setAttribute('aria-valuemax', String(stages.length)); meter.setAttribute('aria-valuenow', String(active + 1)); meter.append(el('i')); meter.lastChild.style.width = `${((active + 1) / stages.length) * 100}%`; progress.append(meter); const stageList = el('ol', undefined, 'processing-stage-list'); stages.forEach(([, label], index) => { const item = el('li', undefined, index < active ? 'is-complete' : index === active ? 'is-active' : ''); item.append(el('span', index < active ? '✓' : index === active ? '→' : '○', 'processing-stage-icon'), el('span', label)); stageList.append(item); }); const summary = process.summary || {}; target.append(progress, stageList, el('p', `Rows: ${(summary.sourceRows || 0).toLocaleString()} / ${uploadLimits.maxSourceRows.toLocaleString()} · Orders: ${(summary.uniqueOrders || 0).toLocaleString()} · Products: ${(summary.detectedProducts || 0).toLocaleString()}`)); const cancel = el('button', state.cancelling ? 'Cancelling job…' : 'Cancel Job', 'button button-danger'); cancel.type = 'button'; cancel.disabled = Boolean(state.cancelling); cancel.addEventListener('click', openCancelProcessModal); target.append(cancel); if (process.stage === 'ai_product_classification') { const ai = process.productClassificationProgress; target.append(classificationSkeleton(ai ? `AI classification: ${ai.completed} of ${ai.total} unknown products processed · ${ai.failed} failed. Batches of up to ${ai.batchSize}.` : 'Checking unknown products against your existing categories…')); } }
function resetCancelledProcess() { state.cancelling = false; sessionStorage.removeItem('deliveryiq-process-id'); state.processId = null; state.result = null; state.upload = null; state.selectedStatuses.clear(); state.selectedProducts.clear(); state.productErrors.clear(); $('#file-upload').value = ''; setSelectedFile(null); state.selectedReportType = null; renderReportTypeSelection(); setUploadLocked(null); clearNotice(); }
function openCancelProcessModal() { const content = el('div', undefined, 'app-modal-fields'); const progress = el('p', '', 'app-modal-description'); progress.hidden = true; content.append(el('p', 'The current processing job will be stopped.'), progress); modal({ title: 'Cancel this report?', description: 'The current processing job will be stopped.', destructive: true, content, submitText: 'Cancel Job', cancelText: 'Keep Processing', onSubmit: async ({ setError, submit }) => { state.cancelling = true; renderProcessing({ status: 'processing', stage: state.result?.stage || 'processing_orders', summary: state.result?.summary || {} }); progress.textContent = 'Cancelling report...'; progress.hidden = false; submit.textContent = 'Cancelling report...'; const response = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}`, { method: 'DELETE' }); const payload = await response.json().catch(() => ({})); if (!response.ok) { state.cancelling = false; setError(payload.message || 'The report could not be cancelled. Please try again.'); submit.textContent = 'Cancel Job'; return true; } resetCancelledProcess(); await restoreActiveProcess(); notice('Report cancelled', 'The server stopped this report. Choose a report type to upload another file.'); return false; } }); }
function applyProcess(process) { if (state.processId !== process.processId) { state.approvedProductsOpen = false; state.openSuggestionHistories.clear(); } $('#clear-current-result').hidden = false; state.selectedReportType = process.templateType; renderReportTypeSelection(); state.result = { summary: process.summary, templateType: process.templateType, classifications: process.classifications, status: process.status, stage: process.stage, productRetry: process.productRetry }; state.processId = process.processId; sessionStorage.setItem('deliveryiq-process-id', state.processId); }
async function pollProcess() { if (!state.processId) return; try { const response = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}`); const payload = await response.json(); if (!response.ok || !payload.success) throw new Error(payload.message || 'Process unavailable.'); const process = payload.process; setUploadLocked(ACTIVE_PROCESS_STATUSES.has(process.status) ? process : null); if (process.status === 'review_required') { if (!hasReviewSnapshot(process)) return restorationFailed("Couldn't restore your report."); applyProcess(process); renderReview(); scheduleProductRetryPoll(); return; } if (process.status === 'cancelled') { resetCancelledProcess(); return notice('Report cancelled', 'The server stopped this report. Choose a report type to upload another file.'); } if (process.status === 'completed') { sessionStorage.removeItem('deliveryiq-process-id'); state.processId = null; return renderCompletion(process.report); } if (process.status === 'failed') { const target = notice(process.error || 'Report generation could not be completed.', 'Please retry this report process.', true); const retry = el('button', 'Retry', 'button button-primary'); retry.addEventListener('click', startProcessing); return target.append(retry); } renderProcessing(process); setTimeout(pollProcess, process.stage === 'ai_product_classification' ? 5000 : 750); } catch (error) { restorationFailed("Couldn't restore your report."); } }
function restoreActiveProcess() { if (state.restorePromise) return state.restorePromise; const restore = (async () => { state.restoring = true; showRestoring(); try { const response = await fetch('/api/report-processes/active'); const payload = await response.json(); if (!response.ok || !payload.success) throw new Error(payload.message || 'Active process lookup failed.'); const process = payload.process; if (process?.status === 'review_required' && !hasReviewSnapshot(process)) throw new Error('REVIEW_RESTORE_FAILED'); if (process?.status === 'review_required' && !state.configLoaded) { try { await refreshConfig(); } catch (error) { throw new Error('REVIEW_RESTORE_FAILED'); } } state.restoring = false; document.body.classList.remove('upload-restoring'); hideRestoreModal(); if (!process) { state.processId = null; state.result = null; state.selectedReportType = null; sessionStorage.removeItem('deliveryiq-process-id'); renderReportTypeSelection(); setUploadLocked(null); clearNotice(); return; } applyProcess(process); setUploadLocked(process); if (process.status === 'review_required') { renderReview(); scheduleProductRetryPoll(); return; } if (process.status === 'failed') { const target = notice(process.error || 'Report generation could not be completed.', 'Please retry this report process.', true); const retry = el('button', 'Retry', 'button button-primary'); retry.type = 'button'; retry.addEventListener('click', startProcessing); return target.append(retry); } if (process.status === 'queued' || process.status === 'processing' || process.status === 'finalizing') { renderProcessing(process); return pollProcess(); } } catch (error) { state.restoring = false; document.body.classList.remove('upload-restoring'); hideRestoreModal(); setUploadLocked(null); restorationFailed(error.message === 'REVIEW_RESTORE_FAILED' ? "Couldn't restore your report." : "Couldn't check your current report."); } })(); state.restorePromise = restore; return restore.finally(() => { if (state.restorePromise === restore) state.restorePromise = null; }); }
async function startProcessing() { const target = notice('Starting report generation', 'Preparing your server-side processing workflow.'); const response = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}/start`, { method: 'POST' }); const payload = await response.json(); if (!response.ok) return notice('Report generation could not be completed.', payload.message || 'Please retry.', true); renderProcessing(payload.process); setTimeout(pollProcess, 100); }
async function ensureTaxonomy(masterCategory, productCategory) { let master = state.config.masterCategories.find((x) => x.name === masterCategory); if (!master) { const r = await fetch('/api/master-categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: masterCategory }) }); const p = await r.json(); if (!r.ok) throw new Error(p.message); master = p.category; state.config.masterCategories.push(master); } let product = state.config.productCategories.find((x) => x.name === productCategory && x.masterCategory === master.name); if (!product) { const r = await fetch('/api/product-categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: productCategory, masterCategoryId: master._id }) }); const p = await r.json(); if (!r.ok) throw new Error(p.message); product = p.category; state.config.productCategories.push(product); } return { masterCategory: master.name, productCategory: product.name }; }
async function saveReviewDecision(kind, item, body) { const response = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}/review/${kind}/${encodeURIComponent(item.value)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.message || 'The review decision could not be saved.'); applyProcess(payload.process); return payload.process; }
async function saveBulkReviewDecision(kind, items, body) { if (items.length > 200) throw new Error('Select at most 200 items for one bulk update.'); const response = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}/review/${kind}/bulk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, values: items.map((item) => item.value) }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.message || 'The bulk review update could not be saved.'); applyProcess(payload.process); return payload; }
async function saveProductDecision(item, masterCategory, productCategory, source) { const taxonomy = source === 'AI Approved' ? { masterCategory, productCategory } : await ensureTaxonomy(masterCategory, productCategory); return saveReviewDecision('product', item, { action: source === 'AI Approved' ? 'approve' : source === 'Client Modified' ? 'change' : 'manual', ...taxonomy }); }
function taxonomySelects(item) { const master = document.createElement('select'); master.append(new Option('Select master category', '')); state.config.masterCategories.filter((x) => x.active).forEach((x) => master.append(new Option(x.name, x.name))); const product = document.createElement('select'); const fill = () => { clear(product); product.append(new Option('Select product category', '')); state.config.productCategories.filter((x) => x.active && x.masterCategory === master.value).forEach((x) => product.append(new Option(x.name, x.name))); }; master.addEventListener('change', fill); master.value = item.suggestedMasterCategory || item.masterCategory || ''; fill(); product.value = item.suggestedProductCategory || item.productCategory || ''; return { master, product }; }
function cardError(row, message) { const error = el('p', `⚠ ${message}`, 'mapping-card-error'); error.setAttribute('role', 'alert'); row.append(error); }
function modal({ title, description, destructive = false, content, submitText, cancelText = 'Cancel', onSubmit }) {
  const previousFocus = document.activeElement; const backdrop = el('div', undefined, 'app-modal-backdrop'); const dialog = el('section', undefined, 'app-modal');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); const titleId = `modal-title-${Date.now()}`; dialog.setAttribute('aria-labelledby', titleId);
  const heading = el('div', undefined, 'app-modal-heading'); const titleNode = el('h2', title); titleNode.id = titleId; const close = el('button', '×', 'app-modal-close'); close.type = 'button'; close.setAttribute('aria-label', `Close ${title}`); heading.append(titleNode, close);
  const descriptionNode = el('p', description, 'app-modal-description'); const error = el('p', '', 'app-modal-error'); error.hidden = true; error.setAttribute('role', 'alert'); const actions = el('div', undefined, 'app-modal-actions'); const cancel = el('button', cancelText, 'button button-secondary'); cancel.type = 'button'; const submit = el('button', submitText, `button ${destructive ? 'button-danger' : 'button-primary'}`); submit.type = 'button'; actions.append(cancel, submit); dialog.append(heading, descriptionNode, content, error, actions); backdrop.append(dialog); document.body.append(backdrop); document.body.classList.add('modal-open');
  const closeModal = () => { document.removeEventListener('keydown', keydown); backdrop.remove(); document.body.classList.remove('modal-open'); previousFocus?.focus?.(); }; const setError = (message) => { error.textContent = message; error.hidden = !message; };
  const keydown = (event) => { if (event.key === 'Escape' && !submit.disabled) { event.preventDefault(); closeModal(); } if (event.key === 'Enter' && document.activeElement?.matches('input')) { event.preventDefault(); submit.click(); } if (event.key !== 'Tab') return; const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]; const first = focusable[0]; const last = focusable.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } };
  document.addEventListener('keydown', keydown); close.addEventListener('click', closeModal); cancel.addEventListener('click', closeModal); backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop && !submit.disabled) closeModal(); }); submit.addEventListener('click', async () => { if (submit.disabled) return; setError(''); submit.disabled = true; close.disabled = true; cancel.disabled = true; try { const keepOpen = await onSubmit({ setError, submit }); if (!keepOpen) closeModal(); } catch (err) { setError(err.message || 'Please try again.'); } finally { if (backdrop.isConnected) { submit.disabled = false; close.disabled = false; cancel.disabled = false; } } }); setTimeout(() => (content.querySelector('input,select,button') || close).focus(), 0);
}
function openCategoryModal(onCreated) {
  const content = el('div', undefined, 'app-modal-fields'); const nameLabel = el('label', 'Product category'); const name = document.createElement('input'); name.type = 'text'; name.maxLength = 80; name.autocomplete = 'off'; name.placeholder = 'Enter category name'; nameLabel.append(name);
  const masterLabel = el('label', 'Master category'); const master = document.createElement('select'); master.append(new Option('Select master category', '')); state.config.masterCategories.filter((item) => item.active).forEach((item) => master.append(new Option(item.name, item._id))); master.append(new Option('Create a new master category…', '__new__')); masterLabel.append(master);
  const newMasterLabel = el('label', 'New master category'); const newMaster = document.createElement('input'); newMaster.type = 'text'; newMaster.maxLength = 80; newMaster.autocomplete = 'off'; newMaster.placeholder = 'Enter master category name'; newMasterLabel.append(newMaster); newMasterLabel.hidden = true; master.addEventListener('change', () => { newMasterLabel.hidden = master.value !== '__new__'; if (master.value === '__new__') newMaster.focus(); }); content.append(nameLabel, masterLabel, newMasterLabel);
  modal({ title: 'Create product category', description: 'Add a product category, or create a new master category and assign this product to it.', content, submitText: 'Create and assign', onSubmit: async ({ setError, submit }) => { const categoryName = name.value.trim(); const newMasterName = newMaster.value.trim(); if (!categoryName) { setError('Enter a product category name.'); name.focus(); return true; } if (!master.value) { setError('Choose a master category or create a new one.'); master.focus(); return true; } if (master.value === '__new__' && !newMasterName) { setError('Enter a new master category name.'); newMaster.focus(); return true; } submit.textContent = 'Creating…'; try { let masterCategoryId = master.value; if (master.value === '__new__') { const createdMaster = await fetch('/api/master-categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: newMasterName }) }); const masterPayload = await createdMaster.json(); if (!createdMaster.ok) throw new Error(masterPayload.message || 'The master category could not be created.'); masterCategoryId = masterPayload.category._id; } const response = await fetch('/api/product-categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: categoryName, masterCategoryId }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.message || 'Try another category name.'); await refreshConfig(); if (onCreated) onCreated(payload.category); return false; } catch (error) { setError(error.message || 'The category could not be created.'); submit.textContent = 'Create and assign'; return true; } } });
}
function clearProductSelection() { state.selectedProducts.clear(); state.bulkError = ''; renderReview(); }
function productCheckbox(item) { const label = el('label', undefined, 'product-select'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.selectedProducts.has(item.value); input.setAttribute('aria-label', `Select ${item.value}`); input.addEventListener('change', () => { input.checked ? state.selectedProducts.add(item.value) : state.selectedProducts.delete(item.value); state.bulkError = ''; renderReview(); }); label.append(input, el('span', 'Select')); return label; }
function statusCheckbox(item) { const label = el('label', undefined, 'product-select'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.selectedStatuses.has(item.value); input.setAttribute('aria-label', `Select ${item.value}`); input.addEventListener('change', () => { input.checked ? state.selectedStatuses.add(item.value) : state.selectedStatuses.delete(item.value); state.statusBulkError = ''; renderReview(); }); label.append(input, el('span', 'Select')); return label; }
async function saveStatusDecision(item, category) { if (state.statusSaving.has(item.value) || state.statusBulkSaving) return; state.statusSaving.add(item.value); state.statusErrors.delete(item.value); renderReview(); try { await saveReviewDecision('status', item, { category }); reviewFeedback('Status mapping saved'); } catch (error) { state.statusErrors.set(item.value, error.message || 'Status mapping could not be saved.'); } finally { state.statusSaving.delete(item.value); renderReview(); } }
async function bulkStatusAction(items, category) { if (state.statusBulkSaving || !category) return; state.statusBulkSaving = true; state.statusBulkError = ''; items.forEach((item) => state.statusErrors.delete(item.value)); renderReview(); try { await saveBulkReviewDecision('status', items, { category }); items.forEach((item) => state.selectedStatuses.delete(item.value)); reviewFeedback(`${items.length} status mapping${items.length === 1 ? '' : 's'} updated`); } catch (error) { state.statusBulkError = error.message || 'Status mappings could not be updated. Please try again.'; } finally { state.statusBulkSaving = false; renderReview(); } }
function productDecisionSource(item, masterCategory, productCategory) {
  if (!item.suggestedProductCategory) return 'Manual';
  return item.suggestionStatus === 'AI Suggested' && masterCategory === item.suggestedMasterCategory && productCategory === item.suggestedProductCategory ? 'AI Approved' : 'Client Modified';
}
let productRetryPollTimer = null;
function productRetryRunning() { return Boolean(state.bulkRetry || state.retryingProduct) || new Date(state.result?.productRetry?.expiresAt || 0) > new Date(); }
function scheduleProductRetryPoll() {
  if (state.bulkRetry || productRetryPollTimer !== null || !productRetryRunning()) return;
  productRetryPollTimer = setTimeout(async () => {
    try { if (!state.bulkRetry && productRetryRunning()) await pollProcess(); }
    finally { productRetryPollTimer = null; scheduleProductRetryPoll(); }
  }, 2500);
}
function classificationSkeleton(label) {
  const box = el('div', undefined, 'classification-loading'); box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
  box.append(el('span', label));
  for (let i = 0; i < 3; i++) { const bar = el('span', undefined, 'mapping-skeleton-bar'); bar.setAttribute('aria-hidden', 'true'); box.append(bar); }
  return box;
}
async function retryProduct(item) {
  if (productRetryRunning() || state.bulkSaving || state.productSaving.size) return;
  state.retryingProduct = item.value; state.productErrors.delete(item.value); renderReview();
  try {
    const response = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}/products/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: item.value }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Reclassification could not be completed. Please retry.');
    applyProcess(payload.process);
    reviewFeedback('Product reclassification complete. Review the result before approving.');
  } catch (error) {
    state.productErrors.set(item.value, error.message || 'The server did not respond. Reload the review or retry.');
    // A lost response does not mean the server stopped. Restore its lease/result.
    try { const r = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}`); const p = await r.json(); if (r.ok && p.process?.status === 'review_required') applyProcess(p.process); } catch { /* The row error remains visible. */ }
  } finally { state.retryingProduct = null; renderReview(); scheduleProductRetryPoll(); }
}
async function retrySelectedProducts() {
  if (productRetryRunning() || state.bulkSaving || state.productSaving.size) return;
  const processId = state.processId;
  const failedSelected = () => (state.result?.classifications?.products || []).filter((item) => state.selectedProducts.has(item.value) && item.classificationRequired && item.suggestionStatus === 'Failed' && !item.manualOnly);
  const values = failedSelected().map((item) => item.value);
  if (!values.length) return;
  state.bulkRetry = { total: values.length, processed: 0 }; state.bulkError = ''; renderReview();
  try {
    // Each request uses the existing retry endpoint and its provider, capped at 25.
    for (let start = 0; start < values.length; start += 25) {
      if (state.processId !== processId) return;
      const current = new Set(failedSelected().map((item) => item.value));
      const batch = values.slice(start, start + 25).filter((value) => current.has(value));
      if (batch.length) {
        const response = await fetch(`/api/report-processes/${encodeURIComponent(processId)}/products/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: batch }) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || 'Bulk retry could not be completed. Please retry.');
        if (state.processId !== processId) return;
        applyProcess(payload.process);
        for (const item of state.result.classifications.products) {
          if (batch.includes(item.value) && item.suggestionStatus !== 'Failed') state.selectedProducts.delete(item.value);
          if (batch.includes(item.value)) state.productErrors.delete(item.value);
        }
      }
      state.bulkRetry.processed = Math.min(start + 25, values.length); renderReview();
    }
    const retried = state.result.classifications.products.filter((item) => values.includes(item.value));
    const suggested = retried.filter((item) => item.suggestionStatus === 'AI Suggested').length;
    const failed = retried.filter((item) => item.suggestionStatus === 'Failed').length;
    const other = retried.length - suggested - failed;
    reviewFeedback(`Retry complete: ${suggested} AI suggested, ${failed} failed${other ? `, ${other} other results` : ''}. Review suggestions before approving.`);
  } catch (error) {
    if (state.processId !== processId) return;
    state.bulkError = error.message || 'The server did not respond. Please retry.';
    // Stop on an uncertain HTTP result and restore any lease still running.
    try {
      const response = await fetch(`/api/report-processes/${encodeURIComponent(processId)}`); const payload = await response.json();
      if (state.processId === processId && response.ok && payload.process?.status === 'review_required') {
        applyProcess(payload.process);
        payload.process.classifications.products.forEach((item) => { if (values.includes(item.value) && item.suggestionStatus !== 'Failed') state.selectedProducts.delete(item.value); });
      }
    } catch { /* Keep the bulk error visible for recovery. */ }
  } finally {
    state.bulkRetry = null;
    if (state.processId === processId && state.result) { renderReview(); scheduleProductRetryPoll(); }
  }
}
function preserveSuggestionHistory(history, value) {
  const key = JSON.stringify([state.processId, value]);
  history.open = state.openSuggestionHistories.has(key);
  history.addEventListener('toggle', () => {
    if (!history.isConnected) return;
    if (history.open) state.openSuggestionHistories.add(key);
    else state.openSuggestionHistories.delete(key);
  });
}
function reviewItem(item, kind) {
  const row = el('article', undefined, `mapping-card ${kind === 'status' ? 'status-review-card' : 'product-review-card'}`);
  if (kind === 'status') return statusReviewItem(row, item);
  if (item.classificationRequired) row.append(productCheckbox(item));
  const identity = el('div', undefined, 'mapping-identity');
  identity.append(el('strong', item.originalProductName || item.value), el('span', `${item.count} occurrence${item.count === 1 ? '' : 's'}`)); row.append(identity);
  const busy = productRetryRunning();
  const retrying = state.retryingProduct === item.value || busy && state.result?.productRetry?.value === item.value;
  const saving = state.productSaving.has(item.value) || busy;
  const details = el('div', undefined, 'product-review-details');
  const status = retrying ? 'Processing' : !item.classificationRequired ? 'Approved' : item.suggestionStatus === 'Client Rejected' ? 'Rejected' : item.suggestionStatus || 'Needs Review';
  details.append(el('strong', status, `classification-state ${status === 'Failed' ? 'is-failed' : ''}`));
  if (retrying) { row.setAttribute('aria-busy', 'true'); details.append(classificationSkeleton('Checking your existing categories…')); }
  else if (!item.classificationRequired) details.append(el('span', `Master Category: ${item.masterCategory || '—'}`), el('span', `Product Category: ${item.productCategory || item.category || '—'}`));
  else if (status === 'AI Suggested') {
    details.append(el('span', 'Suggested from your existing categories', 'taxonomy-hint'), el('span', `AI suggested Master Category: ${item.suggestedMasterCategory}`), el('span', `AI suggested Product Category: ${item.suggestedProductCategory}`));
    if (typeof item.confidence === 'number') details.append(el('span', `Confidence: ${Math.round(item.confidence * 100)}%`));
    if (item.suggestionReason) details.append(el('span', item.suggestionReason));
  } else details.append(el('span', item.manualReason || (status === 'No Match' ? 'No suitable existing category was found. Select categories manually.' : status === 'Rejected' ? 'You rejected the previous suggestion. Select categories or reclassify when ready.' : status === 'Failed' ? 'AI classification failed. Retry or select categories manually.' : 'Select master and product categories to resolve this product.')));
  if (item.suggestionHistory?.length) {
    const history = el('details', undefined, 'classification-history'); preserveSuggestionHistory(history, item.value); history.append(el('summary', `Suggestion history (${item.suggestionHistory.length})`));
    const list = el('ul'); item.suggestionHistory.forEach((entry) => list.append(el('li', `${entry.status === 'Client Rejected' ? 'Rejected' : entry.status} · ${[entry.suggestedMasterCategory, entry.suggestedProductCategory].filter(Boolean).join(' / ') || 'No category suggested'}`))); history.append(list); details.append(history);
  }
  row.append(details);
  if (!item.classificationRequired) return row;
  const selects = taxonomySelects(item); selects.master.setAttribute('aria-label', `Master category for ${item.value}`); selects.product.setAttribute('aria-label', `Product category for ${item.value}`);
  selects.master.disabled = saving; selects.product.disabled = saving;
  const fields = el('div', undefined, 'product-review-fields'); fields.append(selects.master, selects.product);
  const actions = el('div', undefined, 'product-review-actions');
  const save = el('button', state.productSaving.has(item.value) ? 'Saving…' : 'Assign Category', 'button button-primary'); save.type = 'button'; save.disabled = saving;
  save.addEventListener('click', async () => {
    if (productRetryRunning() || state.productSaving.has(item.value)) return;
    if (!selects.master.value || !selects.product.value) { state.productErrors.set(item.value, 'Select both categories before assigning.'); return renderReview(); }
    state.productSaving.add(item.value); renderReview();
    try { await saveProductDecision(item, selects.master.value, selects.product.value, productDecisionSource(item, selects.master.value, selects.product.value)); state.productErrors.delete(item.value); state.selectedProducts.delete(item.value); reviewFeedback('Product approved with your selected categories'); }
    catch (error) { state.productErrors.set(item.value, error.message); }
    finally { state.productSaving.delete(item.value); renderReview(); }
  });
  const create = el('button', 'Create new category', 'button button-secondary'); create.type = 'button'; create.disabled = saving;
  create.addEventListener('click', () => openCategoryModal((category) => { selects.master.value = category.masterCategory; selects.master.dispatchEvent(new Event('change')); selects.product.value = category.name; }));
  actions.append(save, create);
  if (status === 'AI Suggested') {
    const approve = el('button', 'Approve suggestion', 'button button-primary'); approve.type = 'button'; approve.disabled = saving;
    approve.addEventListener('click', async () => { if (productRetryRunning()) return; state.productSaving.add(item.value); renderReview(); try { await saveProductDecision(item, item.suggestedMasterCategory, item.suggestedProductCategory, 'AI Approved'); state.productErrors.delete(item.value); state.selectedProducts.delete(item.value); reviewFeedback('AI suggestion approved'); } catch (error) { state.productErrors.set(item.value, error.message); } finally { state.productSaving.delete(item.value); renderReview(); } });
    const change = el('button', 'Change', 'button button-secondary'); change.type = 'button'; change.disabled = saving; change.addEventListener('click', () => { (selects.master._premiumSelect?.trigger || selects.master).focus(); });
    const reject = el('button', 'Reject', 'button button-secondary'); reject.type = 'button'; reject.disabled = saving;
    reject.addEventListener('click', async () => { if (productRetryRunning()) return; state.productSaving.add(item.value); renderReview(); try { await saveReviewDecision('product', item, { action: 'reject' }); state.selectedProducts.delete(item.value); reviewFeedback('Suggestion rejected. You can select categories or reclassify.'); } catch (error) { state.productErrors.set(item.value, error.message); } finally { state.productSaving.delete(item.value); renderReview(); } });
    actions.prepend(approve, change, reject);
  } else if (!item.manualOnly) {
    const retry = el('button', retrying ? 'Reclassifying…' : status === 'Failed' ? 'Retry' : 'Reclassify', 'button button-secondary'); retry.type = 'button'; retry.disabled = saving; retry.addEventListener('click', () => retryProduct(item)); actions.prepend(retry);
  }
  row.append(fields, actions); if (state.productErrors.has(item.value)) cardError(row, state.productErrors.get(item.value));
  return row;
}
function statusReviewItem(row, item) { const identity = el('div', undefined, 'mapping-identity'); identity.append(el('strong', item.value), el('span', `${item.count} occurrence${item.count === 1 ? '' : 's'}`)); row.append(identity, statusCheckbox(item)); const mapping = el('div', undefined, 'status-mapping-control'); mapping.append(el('span', 'DeliveryIQ category')); const select = document.createElement('select'); select.setAttribute('aria-label', `DeliveryIQ category for ${item.value}`); select.append(new Option('Select category', '')); state.config.statusCategories.forEach((category) => select.append(new Option(category, category))); const saving = state.statusSaving.has(item.value) || state.statusBulkSaving; const save = el('button', saving ? 'Saving...' : 'Save status', 'button button-secondary'); save.type = 'button'; save.disabled = saving; select.disabled = saving; save.addEventListener('click', () => { if (!select.value) return cardError(row, 'Choose a status category first.'); saveStatusDecision(item, select.value); }); mapping.append(select); row.append(mapping, save); if (state.statusErrors.has(item.value)) cardError(row, state.statusErrors.get(item.value)); return row; }
async function bulkProductAction(action, products) { if (state.bulkSaving || productRetryRunning()) return; const eligible = products.filter((item) => item.classificationRequired && item.suggestedProductCategory); const ineligible = products.filter((item) => !eligible.includes(item)); if (!eligible.length) { state.bulkError = `No selected products have an AI suggestion to ${action}.`; renderReview(); return; } state.bulkSaving = true; state.bulkAction = action === 'approve' ? 'Approving' : 'Rejecting'; state.bulkError = ''; renderReview(); try { const decisions = action === 'approve' ? eligible.map((item) => ({ value: item.value, action: 'approve', masterCategory: item.suggestedMasterCategory, productCategory: item.suggestedProductCategory })) : eligible.map((item) => ({ value: item.value, action: 'reject' })); const payload = await saveBulkReviewDecision('product', eligible, { decisions }); eligible.forEach((item) => state.selectedProducts.delete(item.value)); const notes = []; if (ineligible.length) notes.push(`${ineligible.length} selected product${ineligible.length === 1 ? ' does' : 's do'} not have an AI suggestion and ${ineligible.length === 1 ? 'was' : 'were'} left unchanged.`); if (payload.failed?.length) notes.push(`${payload.failed.length} product${payload.failed.length === 1 ? '' : 's'} could not be updated.`); state.bulkError = notes.join(' '); reviewFeedback(`${payload.updated} product${payload.updated === 1 ? '' : 's'} ${action === 'approve' ? 'approved' : 'rejected'}`); } catch (error) { state.bulkError = error.message || 'Product suggestions could not be updated. Please try again.'; } finally { state.bulkSaving = false; state.bulkAction = ''; renderReview(); } }
async function bulkProductMapping(products, masterCategory, productCategory) { if (state.bulkSaving || productRetryRunning() || !masterCategory || !productCategory) return; if (products.length > 200) { state.bulkError = 'Select at most 200 products for one bulk update.'; renderReview(); return; } state.bulkSaving = true; state.bulkAction = 'Applying category to'; state.bulkError = ''; renderReview(); try { const taxonomy = await ensureTaxonomy(masterCategory, productCategory); await saveBulkReviewDecision('product', products, { action: 'manual', ...taxonomy }); products.forEach((item) => state.selectedProducts.delete(item.value)); reviewFeedback(`${products.length} product mapping${products.length === 1 ? '' : 's'} updated`); } catch (error) { state.bulkError = error.message || 'Product mappings could not be updated. Please try again.'; } finally { state.bulkSaving = false; state.bulkAction = ''; renderReview(); } }
function reviewToolbar(products) { const selected = products.filter((item) => state.selectedProducts.has(item.value)); const toolbar = el('section', undefined, 'product-selection-toolbar'); toolbar.setAttribute('aria-live', 'polite'); const selectAllLabel = el('label', undefined, 'select-all-control'); const selectAll = document.createElement('input'); selectAll.type = 'checkbox'; selectAll.checked = products.length > 0 && selected.length === products.length; selectAll.indeterminate = selected.length > 0 && selected.length < products.length; selectAll.setAttribute('aria-label', 'Select all products requiring review'); selectAll.addEventListener('change', () => { if (selectAll.checked) products.forEach((item) => state.selectedProducts.add(item.value)); else products.forEach((item) => state.selectedProducts.delete(item.value)); state.bulkError = ''; renderReview(); }); selectAllLabel.append(selectAll, el('span', 'Select all')); toolbar.append(selectAllLabel);
  if (state.bulkRetry) toolbar.append(el('strong', `Retrying ${state.bulkRetry.total} products… ${state.bulkRetry.processed} / ${state.bulkRetry.total} processed`, 'product-selection-count'));
  if (selected.some((item) => item.suggestionStatus === 'Failed')) {
    const retry = el('button', 'Retry selected', 'button button-secondary'); retry.type = 'button';
    retry.disabled = productRetryRunning() || state.bulkSaving || Boolean(state.productSaving.size);
    retry.addEventListener('click', retrySelectedProducts); toolbar.append(retry);
  }
  if (!selected.length) return toolbar; const selectedCount = el('strong', state.bulkSaving ? `${state.bulkAction || 'Updating'} ${selected.length} product${selected.length === 1 ? '' : 's'}...` : `${selected.length} selected`, 'product-selection-count'); const master = document.createElement('select'); master.setAttribute('aria-label', 'Master category for selected products'); master.append(new Option('Choose master category', '')); state.config.masterCategories.filter((item) => item.active).forEach((item) => master.append(new Option(item.name, item.name))); let product = taxonomyOptions(master); master.addEventListener('change', () => { const replacement = taxonomyOptions(master); replacement.setAttribute('aria-label', 'Product category for selected products'); replacement.disabled = state.bulkSaving; product = replacePremiumSelect(product, replacement); }); product.setAttribute('aria-label', 'Product category for selected products'); const apply = el('button', state.bulkSaving ? 'Updating…' : 'Apply category', 'button button-primary'); apply.type = 'button'; apply.disabled = state.bulkSaving; master.disabled = state.bulkSaving; product.disabled = state.bulkSaving; apply.addEventListener('click', () => { if (!master.value || !product.value) { state.bulkError = 'Choose both a master category and a product category to apply.'; return renderReview(); } bulkProductMapping(selected, master.value, product.value); }); const approve = el('button', state.bulkSaving ? 'Working…' : 'Approve suggestions', 'button button-secondary'); approve.type = 'button'; approve.disabled = state.bulkSaving; approve.addEventListener('click', () => bulkProductAction('approve', selected)); const reject = el('button', 'Reject suggestions', 'button button-secondary'); reject.type = 'button'; reject.disabled = state.bulkSaving; reject.addEventListener('click', () => bulkProductAction('reject', selected)); const clearSelection = el('button', 'Clear selection', 'button button-secondary'); clearSelection.type = 'button'; clearSelection.disabled = state.bulkSaving; clearSelection.addEventListener('click', clearProductSelection); toolbar.append(selectedCount, master, product, apply, approve, reject, clearSelection); return toolbar; }
function resetCurrentResult() { state.approvedProductsOpen = false; state.cancelling = false; state.validating = false; state.generating = false; state.processId = null; state.reportId = null; state.result = null; state.upload = null; state.selectedReportType = null; state.selectedProducts.clear(); state.selectedStatuses.clear(); state.productErrors.clear(); state.statusErrors.clear(); state.productSaving.clear(); state.statusSaving.clear(); state.bulkSaving = false; state.statusBulkSaving = false; state.bulkError = ''; state.statusBulkError = ''; state.reviewFeedback = ''; sessionStorage.removeItem('deliveryiq-process-id'); $('#file-upload').value = ''; setSelectedFile(null); ['#status-review', '#product-review', '#final-review', '#review-summary'].forEach((selector) => { $(selector).hidden = true; }); $('#clear-current-result').hidden = true; renderReportTypeSelection(); setUploadLocked(null); clearNotice(); }
function removeReportModal() { const content = el('div', undefined, 'app-modal-fields'); content.append(el('p', 'This will remove the current upload analysis, product review state, status review state, and generated result. Your saved product and status mappings will not be deleted.')); modal({ title: 'Clear current result?', description: 'Discard this upload analysis and start again.', destructive: true, content, submitText: 'Clear Result', onSubmit: async ({ setError, submit }) => { submit.textContent = 'Clearing…'; const response = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}`, { method: 'DELETE' }); const payload = await response.json().catch(() => ({})); if (!response.ok) { setError(payload.message || 'The result could not be cleared. Please try again.'); submit.textContent = 'Clear Result'; return true; } resetCurrentResult(); return false; } }); }
function reviewFeedback(message) { state.reviewFeedback = message; setTimeout(() => { if (state.reviewFeedback === message) { state.reviewFeedback = ''; const node = $('#review-feedback'); if (node) node.remove(); } }, 4500); }
function reviewMetric(label, value, warning = false) { const card = el('div', undefined, warning ? 'review-metric is-warning' : 'review-metric'); card.append(el('span', label), el('strong', String(value))); return card; }
function renderReview() {
  const result = state.result; const statuses = result.classifications.statuses || []; const products = result.classifications.products || [];
  const unresolvedStatuses = statuses.filter((item) => item.classificationRequired); const unresolvedProducts = products.filter((item) => item.classificationRequired);
  const unresolved = unresolvedStatuses.length + unresolvedProducts.length; const known = products.filter((item) => item.mappingSource === 'client').length;
  const suggested = products.filter((item) => item.classificationRequired && item.suggestedProductCategory).length; const resolved = products.length + statuses.length - unresolved;
  const visibleValues = new Set(unresolvedProducts.map((item) => item.value)); state.selectedProducts.forEach((value) => { if (!visibleValues.has(value)) state.selectedProducts.delete(value); });
  clearNotice(); ['#status-review', '#product-review', '#final-review'].forEach((selector) => { $(selector).hidden = false; });
  setWorkflowStep(2, [0, 1]);
  const header = $('#review-summary'); clear(header); header.hidden = false;
  header.append(el('p', 'POST-VALIDATION REVIEW', 'eyebrow'), el('h2', 'Report Review'), el('p', `${result.templateType === 'full' ? 'Full' : 'Simple'} Report · ${state.upload?.name || result.file?.name || 'Uploaded file'}`, 'review-file'));
  const overview = el('div', undefined, 'review-overview'); overview.append(reviewMetric('Orders', result.summary.uniqueOrders), reviewMetric('Products', products.length), reviewMetric('Resolved', resolved), reviewMetric('Needs review', unresolved, Boolean(unresolved))); header.append(overview);
  if (state.reviewFeedback) { const feedback = el('p', `✓ ${state.reviewFeedback}`, 'review-feedback'); feedback.id = 'review-feedback'; feedback.setAttribute('role', 'status'); header.append(feedback); }

  const statusSummary = $('#status-summary'); clear(statusSummary); statusSummary.append(reviewMetric('Total statuses', statuses.length), reviewMetric('Mapped', statuses.length - unresolvedStatuses.length), reviewMetric('Unmapped', unresolvedStatuses.length, Boolean(unresolvedStatuses.length)), reviewMetric('Needs attention', unresolvedStatuses.length, Boolean(unresolvedStatuses.length)));
  const statusCards = $('#status-cards'); clear(statusCards);
  const visibleStatuses = new Set(unresolvedStatuses.map((item) => item.value)); state.selectedStatuses.forEach((value) => { if (!visibleStatuses.has(value)) state.selectedStatuses.delete(value); });
  if (unresolvedStatuses.length) { const heading = el('div', undefined, 'products-heading'); heading.append(el('h3', 'Statuses requiring review')); const selectAllLabel = el('label', undefined, 'select-all-control'); const selectAll = document.createElement('input'); selectAll.type = 'checkbox'; const selectedCount = unresolvedStatuses.filter((item) => state.selectedStatuses.has(item.value)).length; selectAll.checked = selectedCount === unresolvedStatuses.length; selectAll.indeterminate = selectedCount > 0 && selectedCount < unresolvedStatuses.length; selectAll.setAttribute('aria-label', 'Select all unresolved statuses'); selectAll.addEventListener('change', () => { if (selectAll.checked) unresolvedStatuses.forEach((item) => state.selectedStatuses.add(item.value)); else state.selectedStatuses.clear(); state.statusBulkError = ''; renderReview(); }); selectAllLabel.append(selectAll, el('span', 'Select All')); heading.append(selectAllLabel); statusCards.append(heading); const selected = unresolvedStatuses.filter((item) => state.selectedStatuses.has(item.value)); if (selected.length) { const toolbar = el('section', undefined, 'bulk-action-toolbar'); toolbar.setAttribute('aria-live', 'polite'); toolbar.append(el('strong', state.statusBulkSaving ? `Updating ${selected.length} status mappings...` : `${selected.length} selected`)); const category = document.createElement('select'); category.setAttribute('aria-label', 'DeliveryIQ category for selected statuses'); category.append(new Option('Apply category', '')); state.config.statusCategories.forEach((name) => category.append(new Option(name, name))); category.disabled = state.statusBulkSaving; const apply = el('button', 'Apply to Selected', 'button button-primary'); apply.type = 'button'; apply.disabled = state.statusBulkSaving; apply.addEventListener('click', () => { if (!category.value) { state.statusBulkError = 'Choose a DeliveryIQ category to apply.'; return renderReview(); } bulkStatusAction(selected, category.value); }); toolbar.append(category, apply); statusCards.append(toolbar); } if (state.statusBulkError) { const error = el('p', `⚠ ${state.statusBulkError}`, 'mapping-card-error'); error.setAttribute('role', 'alert'); statusCards.append(error); } unresolvedStatuses.forEach((item) => statusCards.append(reviewItem(item, 'status'))); }
  else statusCards.append(el('p', '✓ All delivery statuses are resolved.', 'all-mapped'));
  $('#status-drop-categories').hidden = true;
  $('#continue-products').textContent = unresolvedStatuses.length ? 'Review products' : 'Continue to products';
  $('#continue-products').onclick = () => $('#product-review').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const productSummary = $('#product-summary'); clear(productSummary); productSummary.append(reviewMetric('Total products', products.length), reviewMetric('Known', known), reviewMetric('AI suggested', suggested), reviewMetric('Approved', products.length - unresolvedProducts.length), reviewMetric('Needs attention', unresolvedProducts.length, Boolean(unresolvedProducts.length)));
  const productCards = $('#product-cards'); clear(productCards);
  const heading = el('div', undefined, 'products-review-header'); heading.append(el('h3', 'Products requiring review')); productCards.append(heading);
  if (unresolvedProducts.length) { const toolbar = reviewToolbar(unresolvedProducts); if (productRetryRunning()) toolbar.querySelectorAll('button,select,input').forEach((x) => { x.disabled = true; }); productCards.append(toolbar); }
  if (state.bulkError) { const error = el('p', `⚠ ${state.bulkError}`, 'mapping-card-error'); error.setAttribute('role', 'alert'); productCards.append(error); }
  if (!unresolvedProducts.length) productCards.append(el('p', '✓ All product categories are resolved.', 'all-mapped'));
  else unresolvedProducts.forEach((item) => productCards.append(reviewItem(item, 'product')));
  const approved = products.filter((item) => !item.classificationRequired);
  if (approved.length) { const section = el('details', undefined, 'approved-product-review'); section.append(el('summary', `Approved products (${approved.length})`)); section.open = state.approvedProductsOpen; const populate = () => { if (section.open && section.children.length === 1) approved.forEach((item) => section.append(reviewItem(item, 'product'))); }; section.addEventListener('toggle', () => { if (!section.isConnected) return; state.approvedProductsOpen = section.open; populate(); }); populate(); productCards.append(section); }
  $('#clear-current-result').hidden = false; $('#continue-final-review').textContent = 'Continue to final review'; $('#continue-final-review').onclick = () => $('#final-review').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const final = $('#final-review-content'); clear(final); const finalState = el('div', undefined, unresolved ? 'final-review-state is-warning' : 'final-review-state'); finalState.append(el('h3', unresolved ? 'Needs attention' : 'Ready to generate your report'), el('p', unresolved ? `${unresolved} item${unresolved === 1 ? '' : 's'} still need review before the report can be generated.` : '✓ File validated · ✓ Delivery statuses resolved · ✓ Product categories resolved'));
  if (unresolvedStatuses.length) { const button = el('button', `Review ${unresolvedStatuses.length} status${unresolvedStatuses.length === 1 ? '' : 'es'}`, 'button button-secondary'); button.type = 'button'; button.addEventListener('click', () => $('#status-review').scrollIntoView({ behavior: 'smooth', block: 'start' })); finalState.append(button); }
  if (unresolvedProducts.length) { const button = el('button', `Review ${unresolvedProducts.length} product${unresolvedProducts.length === 1 ? '' : 's'}`, 'button button-secondary'); button.type = 'button'; button.addEventListener('click', () => $('#product-review').scrollIntoView({ behavior: 'smooth', block: 'start' })); finalState.append(button); } final.append(finalState);
  const generate = $('#generate-report'); generate.disabled = Boolean(unresolved) || state.generating; generate.textContent = state.generating ? 'Generating your report…' : 'Generate report'; generate.onclick = generateReport;
}
function renderCompletion(report) { setWorkflowStep(4, [0, 1, 2, 3]); ['#status-review', '#product-review', '#final-review', '#review-summary'].forEach((selector) => { $(selector).hidden = true; }); const target = notice('✓ Report generated successfully', 'Your completed report is ready. Updated records are also available in Universal Report.'); target.classList.remove('is-error'); const actions = el('div', undefined, 'validation-actions'); const view = el('button', 'View Report', 'button button-primary'); view.type = 'button'; view.addEventListener('click', async () => { history.pushState({}, '', '/reports'); if (await page('reports') && report?.reportId) await viewReport(report.reportId); }); const universal = el('button', 'Open Universal Report', 'button button-secondary'); universal.type = 'button'; universal.addEventListener('click', () => { history.pushState({}, '', '/universal'); page('universal'); }); actions.append(view, universal); target.append(actions); }
async function generateReport() { if (state.generating || !state.processId) return; state.generating = true; renderReview(); try { const response = await fetch(`/api/report-processes/${encodeURIComponent(state.processId)}/finalize`, { method: 'POST' }); const result = await response.json(); if (!response.ok) { reviewFeedback(result.message || 'Report could not be generated. Please try again.'); return renderReview(); } sessionStorage.removeItem('deliveryiq-process-id'); state.processId = null; state.result = null; setUploadLocked(null); setUpload('Report generated successfully', 'Your report is ready to view or check in Universal Report.'); renderCompletion(result.report); } catch (error) { reviewFeedback('Report could not be generated. Please try again.'); renderReview(); } finally { state.generating = false; } }

function reportCard(report) { const card = el('article', undefined, 'report-card'); const text = el('div'); text.append(el('h2', report.reportName), el('p', `${report.templateType === 'full' ? 'Full' : 'Simple'} · ${report.uniqueOrderCount} unique orders · ${report.dateRange.from || 'No date'} to ${report.dateRange.to || 'No date'}`), el('p', `Status: ${report.reportStatus || 'completed'} · Delivered ${report.analytics.statusDistribution.percentages.Delivered}% · NDR ${report.analytics.statusDistribution.percentages.NDR}% · RTO ${report.analytics.statusDistribution.percentages.RTO}%`)); const actions = el('div'); const view = el('button', 'View', 'button button-secondary'); view.addEventListener('click', () => viewReport(report.reportId)); const download = el('a', 'Download CSV', 'button button-secondary'); download.href = `/api/reports/${encodeURIComponent(report.reportId)}?export=csv`; actions.append(view, download); card.append(text, actions); return card; }
async function loadReports() {
  try {
    const response = await fetch('/api/reports'); const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.message || 'Reports could not be loaded. Please try again.');
    for (const selector of ['#reports-list', '#history-list']) {
      const target = $(selector); if (!target) continue; clear(target);
      if (!payload.reports.length) target.append(el('p', 'No reports yet. Upload your first report to see delivery intelligence.'));
      else payload.reports.forEach((report) => target.append(reportCard(report)));
    }
    return true;
  } catch (error) { mappingToast(error.message || 'Reports could not be loaded. Please try again.', true); return false; }
}
function table(title, rows, full) { const section = el('section'); section.append(el('h2', title)); if (!rows?.length) { section.append(el('p', 'No matching data. Try changing or clearing your filters.')); return section; } const wrap = el('div', undefined, 'report-table-wrap'); const table = document.createElement('table'); table.className = 'report-table'; const headers = ['Name', 'Orders', 'Delivered', 'In Transit', 'NDR', 'RTO', 'Delivery %', ...(full ? ['Quantity', 'Revenue'] : [])]; const head = document.createElement('tr'); headers.forEach((name) => head.append(el('th', name))); const body = document.createElement('tbody'); rows.forEach((row) => { const tr = document.createElement('tr'); [row.name, row.orders, row.Delivered, row['In Transit'], row.NDR, row.RTO, `${row.deliveryPercent}%`, ...(full ? [row.quantity, row.revenue] : [])].forEach((value) => tr.append(el('td', String(value ?? 0)))); body.append(tr); }); table.append(document.createElement('thead').appendChild(head).parentElement, body); wrap.append(table); section.append(wrap); return section; }
function fillFilters(report) { const form = $('#report-filters'); const data = report.analytics; choices(form.elements.category, state.config.statusCategories, 'All statuses'); choices(form.elements.masterCategory, data.masterCategory.map((item) => item.name), 'All master categories'); choices(form.elements.product, data.product.map((item) => item.name), 'All products'); choices(form.elements.productCategory, data.productCategory.map((item) => item.name), 'All categories'); choices(form.elements.paymentMode, data.paymentMode.map((item) => item.name), 'All payment modes'); form.querySelectorAll('.full-filter').forEach((node) => { node.hidden = report.templateType !== 'full'; }); if (report.templateType === 'full') { choices(form.elements.courier, data.courier.map((item) => item.name), 'All couriers'); choices(form.elements.orderSource, data.orderSource.map((item) => item.name), 'All sources'); } }
async function viewReport(id) { try { state.reportId = id; const form = $('#report-filters'); const query = new URLSearchParams([...new FormData(form)].filter(([, value]) => value)); const response = await fetch(`/api/reports/${encodeURIComponent(id)}?${query}`); const payload = await response.json(); if (!response.ok || !payload.success) throw new Error(payload.message || 'This report could not be loaded. Please try again.'); const report = payload.report; $('#report-detail').hidden = false; fillFilters(report); const output = $('#report-output'); clear(output); const status = report.filtered.analytics.statusDistribution; output.append(el('h2', report.reportName), el('p', `${status.totalOrders} filtered distinct orders. Percentages use the filtered total.`)); const metrics = el('div', undefined, 'metric-grid'); [['Total Orders', status.totalOrders], ...state.config.statusCategories.map((category) => [category, `${status[category]} (${status.percentages[category]}%)`])].forEach(([name, value]) => { const card = el('article'); card.append(el('span', name), el('strong', String(value))); metrics.append(card); }); output.append(metrics, table('Status distribution by date', report.filtered.analytics.date, report.templateType === 'full'), table('Master Category Performance', report.filtered.analytics.masterCategory, report.templateType === 'full'), table('Product performance (distinct order metrics)', report.filtered.analytics.product, report.templateType === 'full'), table('Product Category Performance', report.filtered.analytics.productCategory, report.templateType === 'full'), table('Payment Mode Performance', report.filtered.analytics.paymentMode, report.templateType === 'full')); if (report.templateType === 'full') output.append(table('Courier Performance', report.filtered.analytics.courier, true), table('Source / Store Performance', report.filtered.analytics.orderSource, true)); } catch (error) { mappingToast(error.message || 'This report could not be loaded. Please try again.', true); } }
// Mapping administration only presents and saves existing mapping API records.
function mappingBadgeInfo(mapping, kind) {
  if (kind === 'status') return mapping.updatedBy === 'system' || mapping.source === 'System Default'
    ? { label: 'System Default', tone: 'neutral' } : { label: 'Client Override', tone: 'blue' };
  const source = mapping.source || 'Client Mapping';
  const label = source === 'Manual' ? 'Manually Approved' : source === 'ai-suggested' ? 'AI Suggested' : source === 'needs-review' ? 'Needs Review' : source;
  const tone = label === 'AI Approved' ? 'green' : label === 'Needs Review' ? 'amber' : label === 'AI Suggested' ? 'violet' : 'blue';
  return { label, tone };
}
function mappingBadge(mapping, kind) {
  const { label, tone } = mappingBadgeInfo(mapping, kind);
  return el('span', label, `mapping-badge mapping-badge-${tone}`);
}
function mappingDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date) : '—';
}
function mappingLookupKey(value) {
  return String(value).normalize('NFKC').trim().toLowerCase().replace(/[‐‑‒–—―_-]+/g, ' ').replace(/[\\/]+/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
let mappingToastTimer;
function mappingToast(message, error = false) {
  const target = $('#mapping-toast');
  target.textContent = message; target.hidden = false;
  target.classList.toggle('is-error', error);
  target.setAttribute('role', error ? 'alert' : 'status');
  clearTimeout(mappingToastTimer);
  mappingToastTimer = setTimeout(() => { target.hidden = true; }, 4500);
}
function mappingState(target, title, copy, retry, actionLabel = 'Retry') {
  const box = el('div', undefined, 'mapping-state');
  const icon = el('span', '◇', 'mapping-state-icon'); icon.setAttribute('aria-hidden', 'true');
  box.append(icon, el('h3', title), el('p', copy));
  if (retry) { const button = el('button', actionLabel, 'button button-secondary'); button.type = 'button'; button.addEventListener('click', retry); box.append(button); }
  clear(target); target.append(box);
}
function mappingSkeleton(target, kind) {
  target.setAttribute('aria-busy', 'true');
  const headers = kind === 'product' ? ['Product', 'Master Category', 'Product Category', 'Source / Status', 'Last Updated', 'Actions'] : ['Raw Status', 'Final Category', 'Source', 'Last Updated', 'Actions'];
  const table = el('table', undefined, 'mapping-table mapping-table-skeleton');
  const head = el('thead'); const header = el('tr');
  headers.forEach((label) => header.append(el('th', label)));
  head.append(header); const body = el('tbody');
  for (let index = 0; index < 4; index += 1) {
    const row = el('tr');
    headers.forEach((label, column) => { const cell = el('td'); cell.dataset.label = label; cell.append(el('span', '', `mapping-skeleton-bar ${column === 0 ? 'is-name' : column === headers.length - 1 ? 'is-action' : ''}`)); row.append(cell); });
    body.append(row);
  }
  table.append(head, body); clear(target); target.append(table);
}
function categorySkeleton() {
  for (const selector of ['#master-category-list', '#product-category-list']) {
    const target = $(selector); clear(target); target.setAttribute('aria-busy', 'true');
    for (let index = 0; index < 5; index += 1) target.append(el('span', '', 'category-chip category-chip-skeleton'));
  }
}
function renderCategoryLists() {
  const { masters, categories } = state.mappingAdmin;
  const masterList = $('#master-category-list'); const productList = $('#product-category-list');
  masterList.removeAttribute('aria-busy'); productList.removeAttribute('aria-busy');
  clear(masterList); clear(productList);
  $('#master-category-count').textContent = `${masters.length} total`;
  $('#product-category-count').textContent = `${categories.length} total`;
  masters.forEach((master) => { const chip = el('span', undefined, `category-chip${master.active ? '' : ' is-inactive'}`); chip.append(el('span', master.name)); if (!master.active) chip.append(el('small', 'Inactive')); masterList.append(chip); });
  categories.forEach((category) => { const chip = el('span', undefined, `category-chip${category.active ? '' : ' is-inactive'}`); chip.append(el('span', category.name), el('small', category.masterCategory || 'Legacy')); if (!category.active) chip.append(el('small', 'Inactive')); productList.append(chip); });
  if (!masters.length) mappingState(masterList, 'No master categories yet', 'Create a category above to begin organizing products.');
  if (!categories.length) mappingState(productList, 'No product categories yet', 'Product categories will appear here after you create one.');
}
function taxonomyOptions(master, selected, productName) {
  const select = document.createElement('select');
  select.setAttribute('aria-label', `Product category for ${productName}`);
  select.append(new Option('Select product category', ''));
  state.config.productCategories.filter((item) => item.active && item.masterCategory === master.value).forEach((item) => select.append(new Option(item.name, item.name)));
  if (selected && ![...select.options].some((option) => option.value === selected)) select.append(new Option(`${selected} (current)`, selected, true, true));
  select.value = selected || '';
  return select;
}
async function saveMappingRow(kind, mapping, controls, row, save, errorText) {
  if (row.classList.contains('is-saving')) return;
  const body = kind === 'status'
    ? { status: mapping.originalExample, category: controls.category.value }
    : { product: mapping.originalExample, masterCategory: controls.master.value, productCategory: controls.product().value, source: 'Client Modified' };
  if (kind === 'product' && (!body.masterCategory || !body.productCategory)) {
    errorText.textContent = 'Choose a master category and product category before saving.'; errorText.hidden = false; return;
  }
  const admin = state.mappingAdmin; const prefix = kind === 'product' ? 'product' : 'status';
  admin[`${prefix}SaveGeneration`] += 1; admin[`${prefix}SavingCount`] += 1;
  errorText.hidden = true; row.classList.add('is-saving'); save.disabled = true; save.textContent = 'Saving…';
  Object.values(controls).forEach((control) => { const select = typeof control === 'function' ? control() : control; select.disabled = true; });
  try {
    const response = await fetch(`/api/mappings/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) throw new Error(payload.message || 'This mapping could not be saved.');
    const items = kind === 'product' ? admin.products : admin.statuses;
    const current = items?.find((item) => item.normalizedValue === mapping.normalizedValue || item.originalExample === mapping.originalExample);
    Object.assign(mapping, payload.mapping);
    if (current && current !== mapping) Object.assign(current, payload.mapping);
    mappingToast(`${kind === 'product' ? 'Product' : 'Status'} mapping updated.`);
    if (kind === 'product') updateProductSourceChoices();
    if (admin[`${prefix}SavingCount`] > 1) updateMappingRowPresentation(row, mapping, kind);
    else if (kind === 'product') renderProductMappings();
    else renderStatusMappings();
  } catch (error) {
    errorText.textContent = error.message || 'This mapping could not be saved. Please retry.'; errorText.hidden = false;
    mappingToast(errorText.textContent, true);
  } finally {
    row.classList.remove('is-saving'); save.textContent = 'Save changes';
    Object.values(controls).forEach((control) => { const select = typeof control === 'function' ? control() : control; select.disabled = false; });
    admin[`${prefix}SaveGeneration`] += 1; admin[`${prefix}SavingCount`] -= 1;
    if (admin[`${prefix}SavingCount`] === 0 && admin[`${prefix}Loading`]) {
      admin[`${prefix}Request`] += 1;
      admin[`${prefix}Loading`] = false;
      if (kind === 'product') loadProducts(); else loadStatuses();
    }
  }
}
function mappingCell(label, child, className) {
  const cell = el('td', undefined, className);
  cell.dataset.label = label; if (child) cell.append(child); return cell;
}
function updateMappingRowPresentation(row, mapping, kind) {
  row.querySelector('.mapping-badge-cell').replaceChildren(mappingBadge(mapping, kind));
  row.querySelector('.mapping-date-cell time').textContent = mappingDate(mapping.updatedAt);
}
function mappingRow(mapping, kind) {
  const row = el('tr', undefined, 'mapping-data-row');
  const name = el('strong', mapping.originalExample, 'mapping-row-name');
  row.append(mappingCell(kind === 'product' ? 'Product' : 'Raw Status', name, 'mapping-name-cell'));
  const save = el('button', 'Save changes', 'button button-secondary mapping-save'); save.type = 'button'; save.disabled = true;
  const errorText = el('p', '', 'mapping-row-error'); errorText.setAttribute('role', 'alert'); errorText.hidden = true;
  let controls;
  let updateDirty;
  if (kind === 'status') {
    const categoryCell = mappingCell('Final Category', null, 'mapping-select-cell');
    const category = document.createElement('select');
    category.setAttribute('aria-label', `Final category for ${mapping.originalExample}`);
    state.config.statusCategories.forEach((value) => category.append(new Option(value, value)));
    category.value = mapping.category || '';
    controls = { category };
    updateDirty = () => { save.disabled = category.value === mapping.category; errorText.hidden = true; };
    category.addEventListener('change', updateDirty);
    if (mapping.editable) categoryCell.append(category);
    else categoryCell.append(el('span', mapping.category, 'mapping-readonly-category'));
    row.append(categoryCell);
  } else {
    const master = document.createElement('select');
    master.setAttribute('aria-label', `Master category for ${mapping.originalExample}`);
    master.append(new Option('Legacy / no master', ''));
    state.config.masterCategories.forEach((item) => master.append(new Option(item.name, item.name)));
    master.value = mapping.masterCategory || '';
    let product = taxonomyOptions(master, mapping.productCategory || mapping.category, mapping.originalExample);
    updateDirty = () => { save.disabled = !master.value || !product.value || master.value === (mapping.masterCategory || '') && product.value === (mapping.productCategory || mapping.category || ''); errorText.hidden = true; };
    master.addEventListener('change', () => { product = replacePremiumSelect(product, taxonomyOptions(master, '', mapping.originalExample)); product.addEventListener('change', updateDirty); updateDirty(); });
    product.addEventListener('change', updateDirty);
    row.append(mappingCell('Master Category', master, 'mapping-select-cell'), mappingCell('Product Category', product, 'mapping-select-cell'));
    controls = { master, product: () => product };
  }
  row.append(mappingCell(kind === 'product' ? 'Source / Status' : 'Source', mappingBadge(mapping, kind), 'mapping-badge-cell'));
  row.append(mappingCell('Last Updated', el('time', mappingDate(mapping.updatedAt), 'mapping-date'), 'mapping-date-cell'));
  const action = el('div', undefined, 'mapping-row-actions');
  if (kind === 'status' && !mapping.editable) {
    const override = el('button', 'Override category', 'button button-secondary mapping-save'); override.type = 'button';
    override.addEventListener('click', () => { row.querySelector('.mapping-select-cell').replaceChildren(controls.category); mapping.editable = true; save.disabled = true; action.replaceChildren(save, errorText); });
    action.append(override);
  } else {
    action.append(save);
    if (kind === 'status') {
      const remove = el('button', 'Delete override', 'button button-secondary mapping-delete'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          const response = await fetch(`/api/mappings/status/${encodeURIComponent(mapping.originalExample)}`, { method: 'DELETE' }); const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.success) throw new Error(payload.message || 'This override could not be deleted.');
          mappingToast('Client override deleted. System default restored.'); await loadStatuses();
        } catch (error) { mappingToast(error.message || 'This override could not be deleted.', true); remove.disabled = false; }
      });
      action.append(remove);
    }
    action.append(errorText);
  }
  row.append(mappingCell('Actions', action, 'mapping-action-cell'));
  save.addEventListener('click', () => saveMappingRow(kind, mapping, controls, row, save, errorText));
  return row;
}
function renderMappingTable(target, rows, kind) {
  const headers = kind === 'product' ? ['Product', 'Master Category', 'Product Category', 'Source / Status', 'Last Updated', 'Actions'] : ['Raw Status', 'Final Category', 'Source', 'Last Updated', 'Actions'];
  const table = el('table', undefined, `mapping-table mapping-table-${kind}`);
  const head = el('thead'); const header = el('tr');
  headers.forEach((label) => { const th = el('th', label); th.scope = 'col'; header.append(th); });
  head.append(header); const body = el('tbody'); rows.forEach((item) => body.append(mappingRow(item, kind)));
  table.append(head, body); clear(target); target.append(table);
}
function updateProductSourceChoices() {
  const labels = [...new Set((state.mappingAdmin.products || []).map((item) => mappingBadgeInfo(item, 'product').label))];
  choices($('#product-source-filter'), labels, 'All sources');
}
function renderProductMappings() {
  if (state.mappingAdmin.products === null) return;
  const target = $('#product-mappings'); target.removeAttribute('aria-busy');
  const all = state.mappingAdmin.products || [];
  const search = $('#product-search').value.trim().toLocaleLowerCase();
  const category = $('#product-category-filter').value;
  const source = $('#product-source-filter').value;
  const filtered = all.filter((item) => item.originalExample.toLocaleLowerCase().includes(search) && (!category || (item.productCategory || item.category) === category) && (!source || mappingBadgeInfo(item, 'product').label === source));
  $('#product-mapping-count').textContent = `${filtered.length} of ${all.length} mappings`;
  if (!filtered.length) {
    if (!all.length) mappingState(target, 'No product mappings yet', 'Mappings appear here after products are approved during report review.');
    else mappingState(target, 'No matching products', 'Try a different search or clear the filters.', () => { $('#product-search').value = ''; $('#product-category-filter').value = ''; $('#product-source-filter').value = ''; renderProductMappings(); $('#product-search').focus(); }, 'Clear filters');
    return;
  }
  renderMappingTable(target, filtered, 'product');
}
function renderStatusMappings() {
  if (state.mappingAdmin.statuses === null) return;
  const target = $('#status-mappings'); target.removeAttribute('aria-busy');
  const all = state.mappingAdmin.statuses || [];
  const search = $('#status-search').value.trim().toLocaleLowerCase();
  const category = $('#status-category-filter').value;
  const source = $('#status-source-filter').value;
  const filtered = all.filter((item) => item.originalExample.toLocaleLowerCase().includes(search) && (!category || item.category === category) && (!source || mappingBadgeInfo(item, 'status').label === source));
  $('#status-mapping-count').textContent = `${filtered.length} of ${all.length} mappings`;
  if (!filtered.length) {
    if (!all.length) mappingState(target, 'No status mappings yet', 'Status mappings appear here after a courier status is classified.');
    else mappingState(target, 'No matching statuses', 'Try a different search or clear the filters.', () => { $('#status-search').value = ''; $('#status-category-filter').value = ''; $('#status-source-filter').value = ''; renderStatusMappings(); $('#status-search').focus(); }, 'Clear filters');
    return;
  }
  renderMappingTable(target, filtered, 'status');
}
async function mappingResponse(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) throw new Error(payload.message || 'Mappings could not be loaded.');
  return payload;
}
async function loadStatuses() {
  const admin = state.mappingAdmin; const request = ++admin.statusRequest; admin.statusLoading = true;
  const saveGeneration = admin.statusSaveGeneration;
  const target = $('#status-mappings');
  if (!admin.statuses) mappingSkeleton(target, 'status');
  choices($('#status-category-filter'), state.config.statusCategories, 'All categories');
  try {
    const payload = await mappingResponse('/api/mappings/status');
    if (request !== admin.statusRequest || saveGeneration !== admin.statusSaveGeneration || admin.statusSavingCount) return;
    admin.statuses = payload.mappings; admin.statusLoading = false;
    renderStatusMappings();
  } catch (error) {
    if (request !== admin.statusRequest || saveGeneration !== admin.statusSaveGeneration || admin.statusSavingCount) return;
    admin.statusLoading = false; target.removeAttribute('aria-busy');
    if (admin.statuses) mappingToast('Status mappings could not be refreshed.', true);
    else mappingState(target, 'Status mappings could not be loaded', error.message, loadStatuses);
  }
}
async function loadProducts() {
  const admin = state.mappingAdmin; const request = ++admin.productRequest; admin.productLoading = true;
  const saveGeneration = admin.productSaveGeneration;
  const target = $('#product-mappings');
  if (!admin.products) { categorySkeleton(); mappingSkeleton(target, 'product'); }
  try {
    const [maps, masters, categories] = await Promise.all([
      mappingResponse('/api/mappings/product'), mappingResponse('/api/master-categories'), mappingResponse('/api/product-categories')
    ]);
    if (request !== admin.productRequest || saveGeneration !== admin.productSaveGeneration || admin.productSavingCount) return;
    admin.products = maps.mappings; admin.masters = masters.categories; admin.categories = categories.categories; admin.productLoading = false;
    state.config.masterCategories = masters.categories; state.config.productCategories = categories.categories;
    choices($('#product-category-filter'), categories.categories.filter((item) => item.active).map((item) => item.name), 'All categories');
    updateProductSourceChoices(); renderCategoryLists(); renderProductMappings();
  } catch (error) {
    if (request !== admin.productRequest || saveGeneration !== admin.productSaveGeneration || admin.productSavingCount) return;
    admin.productLoading = false; target.removeAttribute('aria-busy');
    if (admin.products) mappingToast('Product mappings could not be refreshed.', true);
    else {
      for (const selector of ['#master-category-list', '#product-category-list']) { const list = $(selector); list.removeAttribute('aria-busy'); mappingState(list, 'Categories unavailable', 'Please retry loading your product categories.'); }
      mappingState(target, 'Product mappings could not be loaded', error.message, loadProducts);
    }
  }
}
async function createProductCategory(event) {
  event.preventDefault();
  const form = event.currentTarget; const admin = state.mappingAdmin;
  if (admin.categorySaving) return;
  const button = form.querySelector('button[type="submit"]'); const feedback = $('#category-form-feedback');
  const fields = [...form.querySelectorAll('input')];
  const masterName = form.elements.masterCategory.value.trim(); const productName = form.elements.name.value.trim();
  if (!masterName || !productName) {
    feedback.textContent = 'Enter both a master category and a product category.'; feedback.hidden = false;
    mappingToast(feedback.textContent, true); return;
  }
  admin.categorySaving = true; button.disabled = true; button.textContent = 'Creating…'; fields.forEach((field) => { field.disabled = true; }); feedback.hidden = true;
  try {
    try {
      let master = state.config.masterCategories.find((item) => item.normalizedName === mappingLookupKey(masterName));
      if (!master) {
        const response = await fetch('/api/master-categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: masterName }) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'Master category could not be created.');
        master = payload.category;
        state.config.masterCategories.push(master);
        if (admin.masters && admin.masters !== state.config.masterCategories) admin.masters.push(master);
        if (admin.masters && admin.categories) renderCategoryLists();
      }
      const response = await fetch('/api/product-categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: productName, masterCategoryId: master._id }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Product category could not be created.');
      form.reset(); mappingToast('Product category created.');
    } catch (error) {
      feedback.textContent = error.message || 'Category could not be created. Please retry.'; feedback.hidden = false;
      mappingToast(feedback.textContent, true); return;
    }
    try { await refreshConfig(); await loadProducts(); }
    catch { mappingToast('Category created, but the lists could not be refreshed. Reload to see the latest categories.', true); }
  } finally {
    admin.categorySaving = false; button.disabled = false; button.textContent = 'Create category'; fields.forEach((field) => { field.disabled = false; });
  }
}
$('#file-upload')?.addEventListener('change', (event) => validateFile(event.target.files[0])); $('#upload-dropzone')?.addEventListener('drop', (event) => { event.preventDefault(); $('#upload-dropzone').classList.remove('is-dragging'); if ($('#file-upload').disabled) return; validateFile(event.dataTransfer.files[0]); }); ['dragover', 'dragenter'].forEach((name) => $('#upload-dropzone')?.addEventListener(name, (event) => { event.preventDefault(); if (!$('#file-upload').disabled) $('#upload-dropzone').classList.add('is-dragging'); })); ['dragleave', 'dragend'].forEach((name) => $('#upload-dropzone')?.addEventListener(name, () => $('#upload-dropzone').classList.remove('is-dragging'))); $('#remove-selected-file')?.addEventListener('click', resetSelectedFile); document.querySelectorAll('[data-report-type]').forEach((button) => button.addEventListener('click', () => selectReportType(button.dataset.reportType))); $('#change-report-type')?.addEventListener('click', changeReportType); $('#clear-current-result')?.addEventListener('click', removeReportModal); $('#report-filters')?.addEventListener('submit', (event) => { event.preventDefault(); viewReport(state.reportId); }); $('#clear-report-filters')?.addEventListener('click', () => { $('#report-filters').reset(); viewReport(state.reportId); }); $('#category-form')?.addEventListener('submit', createProductCategory); $('#status-search')?.addEventListener('input', renderStatusMappings); $('#status-category-filter')?.addEventListener('change', renderStatusMappings); $('#status-source-filter')?.addEventListener('change', renderStatusMappings); $('#product-search')?.addEventListener('input', renderProductMappings); $('#product-category-filter')?.addEventListener('change', renderProductMappings); $('#product-source-filter')?.addEventListener('change', renderProductMappings); $('#logout-button')?.addEventListener('click', async () => { const button = $('#logout-button'); button.disabled = true; try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { location.assign('/login'); } }); const pageFromLocation = () => { const name = location.pathname.slice(1); return ['dashboard', 'upload', 'reports', 'universal', 'products', 'statuses', 'history', 'settings'].includes(name) ? name : 'dashboard'; }; window.addEventListener('popstate', () => page(pageFromLocation())); document.body.classList.add('upload-restoring'); page(pageFromLocation()); if (!state.configLoaded) refreshConfig().catch(() => {}); fetch('/api/health').then((r) => r.json()).then(() => { $('#service-status').textContent = 'Service online'; }).catch(() => { $('#service-status').textContent = 'Service unavailable'; });
function closeMobileMenu() { const menu = $('#mobile-navigation'); const backdrop = $('#mobile-menu-backdrop'); if (!menu) return; menu.hidden = true; backdrop.hidden = true; $('.menu-button').setAttribute('aria-expanded', 'false'); document.body.classList.remove('mobile-menu-open'); }
function openMobileMenu() { const menu = $('#mobile-navigation'); const backdrop = $('#mobile-menu-backdrop'); if (!menu) return; menu.hidden = false; backdrop.hidden = false; $('.menu-button').setAttribute('aria-expanded', 'true'); document.body.classList.add('mobile-menu-open'); menu.querySelector('.mobile-menu-close').focus(); }
(function setupMobileMenu() { const menu = $('#mobile-navigation'); const links = $('#mobile-navigation-links'); const button = $('.menu-button'); if (!menu || !links || !button) return; document.querySelectorAll('.sidebar .nav-link').forEach((link) => { const clone = link.cloneNode(true); clone.addEventListener('click', closeMobileMenu); links.append(clone); }); button.addEventListener('click', () => menu.hidden ? openMobileMenu() : closeMobileMenu()); $('#mobile-menu-backdrop').addEventListener('click', closeMobileMenu); menu.querySelector('.mobile-menu-close').addEventListener('click', closeMobileMenu); document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !menu.hidden) closeMobileMenu(); }); }());

// Universal Report is a server-grouped, tenant-scoped view. The browser only renders it.
function universalFormatNumber(value) { return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN') : '—'; }
function universalFormatCurrency(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value)) : '—'; }
function universalFormatDate(value) { const [year, month, day] = String(value || '').split('-').map(Number); const date = year && month && day ? new Date(year, month - 1, day) : null; return date && !Number.isNaN(date) ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(date) : '—'; }
function localDate(value = new Date()) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function universalErrorMessage(response, payload) { return response.status === 422 ? payload?.message || 'Please check the selected range.' : 'Unable to load report. Please try again.'; }
async function universalFetch(url, options = {}) { const response = await fetch(url, options); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(universalErrorMessage(response, payload)); return payload; }
function universalParams(extra = {}) { const p = new URLSearchParams(); for (const [name, value] of new FormData($('#universal-filters'))) if (value) p.set(name, value); Object.entries(extra).forEach(([name, value]) => p.set(name, value)); return p; }
function setActive(selector, value, attr) { document.querySelectorAll(selector).forEach((button) => { const active = button.dataset[attr] === value; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active)); }); }
function universalSkeleton(target, cards = false) { clear(target); if (cards) { for (let i = 0; i < 8; i += 1) target.append(el('article', undefined, 'universal-card skeleton')); return; } const wrap = el('div', undefined, 'universal-table-wrap'); const table = document.createElement('table'); table.className = 'universal-table'; const body = document.createElement('tbody'); for (let i = 0; i < 6; i += 1) { const row = document.createElement('tr'); for (let j = 0; j < 10; j += 1) row.append(el('td', '', 'skeleton-cell')); body.append(row); } table.append(body); wrap.append(table); target.append(wrap); }
function universalCards(t) { const target = $('#universal-summary'); clear(target); const metrics = [[t.orderTotalLabel, t.orderTotal || 0, 'total'], ['Delivery %', `${universalFormatNumber(t.deliveryPercentage || 0)}%`, 'delivery'], ['Delivered', t.deliveredOrders || 0, 'delivered'], ['In Transit', t.inTransitOrders || 0, 'transit'], ['NDR', t.ndrOrders || 0, 'ndr'], ['RTO', t.rtoOrders || 0, 'rto'], ['Cancelled', t.cancelledOrders || 0, 'cancelled'], ['Other', t.otherOrders || 0, 'other'], ['Total Order Value', universalFormatCurrency(t.totalValue || 0), 'value']]; metrics.forEach(([label, value, kind]) => { const card = el('article', undefined, `universal-card metric-${kind}`); card.append(el('span', label), el('strong', typeof value === 'number' ? universalFormatNumber(value) : value)); if (kind === 'delivery') card.append(el('small', t.deliveryView === 'shipped_orders' ? 'of shipped orders' : 'of all orders')); else if (!['total', 'value'].includes(kind)) card.append(el('small', t.percentages[label] === null ? 'Outside shipped basis' : `${universalFormatNumber(t.percentages[label] || 0)}% of ${t.deliveryView === 'shipped_orders' ? 'shipped' : 'total'} orders`)); target.append(card); }); }
function universalTable(report) { const target = $('#universal-orders-content'); clear(target); const rows = report.rows || []; if (!rows.length) { const box = el('section', undefined, 'universal-empty'); box.append(el('h3', 'No data matches these filters'), el('p', 'Try a different date range or payment mode.')); const reset = el('button', 'Clear filters', 'button button-secondary'); reset.type = 'button'; reset.onclick = () => { const f = $('#universal-filters'); f.elements.paymentMode.value = ''; f.elements.fromDate.value = ''; f.elements.toDate.value = ''; setActive('[data-payment]', '', 'payment'); loadUniversal(); }; box.append(reset); target.append(box); return; }
  const fields = [['Delivered', 'delivered'], ['In Transit', 'inTransit'], ['NDR', 'ndr'], ['RTO', 'rto'], ['Cancelled', 'cancelled'], ['Other', 'other'], [report.orderTotalLabel, 'orderTotal'], ['Delivery %', 'deliveryPercentage'], ['Total Order Value', 'totalOrderValue'], ['Delivered Order Value', 'deliveredOrderValue']]; const wrap = el('div', undefined, 'universal-table-wrap'); const table = document.createElement('table'); table.className = 'universal-table'; const head = document.createElement('thead'); const tr = document.createElement('tr'); tr.append(el('th', report.groupLabel)); fields.forEach(([label]) => tr.append(el('th', label, 'numeric'))); head.append(tr); const body = document.createElement('tbody'); rows.forEach((row) => { const line = document.createElement('tr'); line.append(el('th', row.name)); fields.forEach(([, field]) => { const value = field.includes('Value') ? universalFormatCurrency(row[field]) : field === 'deliveryPercentage' ? `${universalFormatNumber(row[field] || 0)}%` : universalFormatNumber(row[field] || 0); line.append(el('td', value, 'numeric')); }); body.append(line); }); table.append(head, body); wrap.append(table); target.append(wrap);
  const cards = el('div', undefined, 'universal-group-cards'); rows.forEach((row) => { const card = el('article', undefined, 'universal-group-card'); card.append(el('h3', row.name), el('p', `${universalFormatNumber(row.orderTotal)} ${report.orderTotalLabel.toLowerCase()}`)); const list = el('dl'); fields.slice(0, 8).forEach(([label, field]) => { const value = field === 'deliveryPercentage' ? `${universalFormatNumber(row[field] || 0)}%` : universalFormatNumber(row[field] || 0); list.append(el('dt', label), el('dd', value)); }); list.append(el('dt', 'Order Value'), el('dd', universalFormatCurrency(row.totalOrderValue)), el('dt', 'Delivered Value'), el('dd', universalFormatCurrency(row.deliveredOrderValue))); card.append(list); cards.append(card); }); target.append(cards); }
function rangeLabel(range) { return range?.from && range?.to ? `${universalFormatDate(range.from)} — ${universalFormatDate(range.to)}` : 'No current order data'; }
async function loadUniversal() { const target = $('#universal-orders-content'); if (!target) return; if (state.universal.controller) state.universal.controller.abort(); const controller = new AbortController(); state.universal.controller = controller; universalSkeleton(target); universalSkeleton($('#universal-summary'), true); $('#universal-result-summary').textContent = 'Updating report…'; try { const report = (await universalFetch(`/api/universal/grouped?${universalParams()}`, { signal: controller.signal })).report; if (state.universal.controller !== controller) return; state.universal.report = report; universalCards(report.totals); universalTable(report); $('#universal-orders-title').textContent = `${report.groupLabel} Wise Performance`; const selected = { from: $('#universal-filters').elements.fromDate.value || report.range.from, to: $('#universal-filters').elements.toDate.value || report.range.to }; $('#universal-range').textContent = `Currently showing data from ${rangeLabel(selected)}`; $('#universal-date-trigger span').textContent = rangeLabel(selected); $('#universal-result-summary').textContent = `${universalFormatNumber(report.totals.orderTotal)} ${report.orderTotalLabel.toLowerCase()}`; } catch (error) { if (error.name === 'AbortError') return; clear(target); const box = el('section', undefined, 'universal-empty universal-error'); box.append(el('h3', 'Report could not be loaded'), el('p', error.message)); const retry = el('button', 'Retry', 'button button-primary'); retry.type = 'button'; retry.onclick = loadUniversal; box.append(retry); target.append(box); } }
async function universalExport(kind) { const status = $('#universal-export-status'); status.textContent = 'Preparing report…'; const [exportType, format] = kind.split('-'); try { const response = await fetch(`/api/universal/export?${universalParams({ exportType, format })}`); if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.message || 'Export could not be completed.'); } const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `deliveryiq-${exportType}-report.${format}`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); status.textContent = 'Download ready.'; } catch (error) { status.textContent = error.message || 'Export could not be completed.'; } }
(function setupUniversalReport() { const form = $('#universal-filters'); if (!form) return; const pop = $('#universal-date-popover'); const trigger = $('#universal-date-trigger'); const closeDate = () => { pop.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }; const closeDownload = () => { $('#universal-export-menu').hidden = true; $('#universal-export').setAttribute('aria-expanded', 'false'); }; closeDate(); closeDownload(); document.querySelectorAll('[data-analyze]').forEach((button) => button.onclick = () => { form.elements.analyzeBy.value = button.dataset.analyze; setActive('[data-analyze]', button.dataset.analyze, 'analyze'); loadUniversal(); }); document.querySelectorAll('[data-delivery-view]').forEach((button) => button.onclick = () => { form.elements.deliveryView.value = button.dataset.deliveryView; setActive('[data-delivery-view]', button.dataset.deliveryView, 'deliveryView'); loadUniversal(); }); document.querySelectorAll('[data-payment]').forEach((button) => button.onclick = () => { form.elements.paymentMode.value = button.dataset.payment; setActive('[data-payment]', button.dataset.payment, 'payment'); loadUniversal(); }); trigger.onclick = () => { const open = pop.hidden; pop.hidden = !open; trigger.setAttribute('aria-expanded', String(open)); if (open) { $('#universal-from-date').value = form.elements.fromDate.value; $('#universal-to-date').value = form.elements.toDate.value; } }; document.querySelectorAll('[data-range]').forEach((button) => button.onclick = () => { const today = new Date(); const from = button.dataset.range === 'month' ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date(today.getFullYear(), today.getMonth(), today.getDate() - Number(button.dataset.range) + 1); $('#universal-from-date').value = localDate(from); $('#universal-to-date').value = localDate(today); }); $('#universal-date-close').onclick = closeDate; $('#universal-date-cancel').onclick = closeDate; $('#universal-date-apply').onclick = () => { const from = $('#universal-from-date').value; const to = $('#universal-to-date').value; const error = $('#universal-date-error'); if (!from || !to || from > to) { error.hidden = false; error.textContent = 'Start Date must be on or before End Date.'; return; } error.hidden = true; form.elements.fromDate.value = from; form.elements.toDate.value = to; closeDate(); loadUniversal(); }; $('#universal-export').onclick = () => { const menu = $('#universal-export-menu'); const open = menu.hidden; menu.hidden = !open; $('#universal-export').setAttribute('aria-expanded', String(open)); }; document.querySelectorAll('[data-export]').forEach((button) => button.onclick = () => { closeDownload(); universalExport(button.dataset.export); }); $('#universal-refresh').onclick = loadUniversal; document.addEventListener('pointerdown', (event) => { if (!pop.hidden && !pop.contains(event.target) && !trigger.contains(event.target)) closeDate(); const menu = $('#universal-export-menu'); if (!menu.hidden && !menu.contains(event.target) && !$('#universal-export').contains(event.target)) closeDownload(); }); document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeDate(); closeDownload(); } }); }());
