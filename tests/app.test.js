const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough';
const { MappingStore } = require('../src/mappings');
const { classifyProducts } = require('../src/product');
const { GeminiProductClassifier, validateGeminiResults, GEMINI_MODEL } = require('../src/product-classifier');
const { validateUpload, processValidatedUpload, csvTemplate, xlsxTemplate } = require('../src/upload');
const { aggregate, applyFilters, csv, ProcessingStore } = require('../src/reports');
const { classifyStatus } = require('../src/classification');
const testSessions = new Map();
async function authenticatedFetch(base, pathname, options = {}) {
  let cookie = testSessions.get(base);
  if (!cookie) { const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) }); assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';', 1)[0]; testSessions.set(base, cookie); }
  return fetch(`${base}${pathname}`, { ...options, headers: { ...options.headers, cookie } });
}
test('admin authentication protects application pages and private APIs, then creates and clears a secure session', async () => {
  const app = require('../src/app'); const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); }); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/dashboard`, { redirect: 'manual' }); assert.equal(response.status, 302); assert.match(response.headers.get('location'), /^\/login\?next=/);
    response = await fetch(`${base}/api/reports`); assert.equal(response.status, 401);
    response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'wrong', password: 'wrong' }) }); assert.equal(response.status, 401); assert.equal((await response.json()).message, 'Invalid username or password.');
    response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) }); assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Max-Age=28800/);
    response = await fetch(`${base}/dashboard`, { headers: { cookie } }); assert.equal(response.status, 200);
    response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } }); assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    response = await fetch(`${base}/api/reports`, { headers: { cookie: response.headers.get('set-cookie') } }); assert.equal(response.status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

async function taxonomy(store, client = 'a') { const master = await store.saveMaster(client, 'Beauty & Personal Care'); const product = await store.saveCategory(client, 'Nail Serum', master._id); return { master, product }; }
test('product categories require tenant master categories and remain tenant isolated', async () => { const store = new MappingStore({ mongoUri: null }); await assert.rejects(store.saveCategory('a', 'Nail Serum', null, { requireMaster: true }), { code: 'MASTER_CATEGORY_REQUIRED' }); const { master } = await taxonomy(store); assert.equal((await store.listCategories('a'))[0].masterCategory, master.name); assert.equal((await store.listMasters('b')).length, 0); });
test('known two-level and legacy flat mappings bypass Gemini', async () => { let calls = 0; const provider = { classifyProducts() { calls += 1; } }; const known = await classifyProducts(['S-Famw Nail Serum 349'], { mappings: [{ normalizedValue: 's famw nail serum 349', masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum' }], provider }); assert.equal(calls, 0); assert.equal(known.items[0].productCategory, 'Nail Serum'); const legacy = classifyProducts(['Old Product'], { mappings: [{ normalizedValue: 'old product', category: 'Legacy Category' }], provider }); assert.equal(calls, 0); assert.equal(legacy.items[0].masterCategory, null); });
test('unknown products send minimal taxonomy and reject invented categories', async () => { let context; const provider = { classifyProducts(products, value) { context = value; return { model: GEMINI_MODEL, results: [{ product: products[0], masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum', confidence: .95 }] }; } }; const result = await classifyProducts(['S-Famw Nail Serum 349'], { masterCategories: [{ name: 'Beauty & Personal Care' }], productCategories: [{ name: 'Face Serum', masterCategory: 'Beauty & Personal Care' }], provider }); assert.deepEqual(context, { masterCategories: ['Beauty & Personal Care'], productCategories: [{ name: 'Face Serum', masterCategory: 'Beauty & Personal Care' }] }); assert.equal(result.items[0].suggestionStatus, 'Failed');
  assert.equal(result.items[0].suggestedProductCategory, null); });
test('Gemini validation requires safe master and specific product category response', () => { const out = validateGeminiResults({ results: [{ product: 'S-Famw Nail Serum 349', masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum' }, { product: 'Bad', masterCategory: '<bad>', productCategory: 'X' }] }, ['S-Famw Nail Serum 349', 'Bad'], { masterCategories: ['Beauty & Personal Care'], productCategories: [{ name: 'Nail Serum', masterCategory: 'Beauty & Personal Care' }] }); assert.equal(out.length, 1); assert.equal(out[0].productCategory, 'Nail Serum'); });
test('approval saves taxonomy/mapping and next upload has zero Gemini calls', async () => { const store = new MappingStore({ mongoUri: null }); const { master } = await taxonomy(store); await store.saveProductMapping('a', 'S-Famw Nail Serum 349', { masterCategory: master._id, productCategory: 'Nail Serum', source: 'AI Approved' }); let calls = 0; const classified = await classifyProducts(['S-Famw Nail Serum 349'], { mappings: await store.list('product', 'a'), provider: { classifyProducts() { calls += 1; } } }); assert.equal(calls, 0); assert.equal(classified.items[0].masterCategory, 'Beauty & Personal Care'); });
test('manual fallback requires both categories and preserves status engine', async () => { const store = new MappingStore({ mongoUri: null }); await assert.rejects(store.saveProductMapping('a', 'Thing', { productCategory: 'Thing' }), { code: 'INVALID_CATEGORY' }); assert.equal(classifyStatus('Ready to Ship').category, 'In Transit'); assert.equal(classifyStatus('RTO NDR').category, 'RTO'); });
test('status mapping defaults are immutable display rows and tenant overrides take precedence', async () => {
  const store = new MappingStore({ mongoUri: null });
  const defaults = await store.listStatusMappings('client-a'); const delivered = defaults.find((item) => item.normalizedValue === 'delivered');
  assert.deepEqual({ category: delivered.category, source: delivered.source, editable: delivered.editable }, { category: 'Delivered', source: 'System Default', editable: false });
  await store.save('status', 'client-a', 'Delivered', 'Other');
  const overridden = (await store.listStatusMappings('client-a')).filter((item) => item.normalizedValue === 'delivered');
  assert.equal(overridden.length, 1); assert.deepEqual({ category: overridden[0].category, systemCategory: overridden[0].systemCategory, source: overridden[0].source, editable: overridden[0].editable }, { category: 'Other', systemCategory: 'Delivered', source: 'Client Override', editable: true });
  assert.equal(classifyStatus('Delivered', await store.list('status', 'client-a')).category, 'Other');
  assert.equal(classifyStatus('Delivered', await store.list('status', 'client-b')).category, 'Delivered');
  assert.equal(classifyStatus('Unknown courier status', await store.list('status', 'client-a')).classificationRequired, true);
  assert.equal(await store.remove('status', 'client-a', 'Delivered'), true);
  const restored = (await store.listStatusMappings('client-a')).find((item) => item.normalizedValue === 'delivered');
  assert.deepEqual({ category: restored.category, source: restored.source, editable: restored.editable }, { category: 'Delivered', source: 'System Default', editable: false });
});
test('reports snapshot, filter, and export both taxonomy levels', () => { const rows = [{ normalizedOrderId: '1', category: 'Delivered', originalProductName: 'S-Famw Nail Serum 349', masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum', quantity: 1, rowValue: 349 }]; const report = aggregate(rows, 'full'); assert.equal(report.analytics.masterCategory[0].name, 'Beauty & Personal Care'); assert.equal(applyFilters(rows, { masterCategory: 'Beauty & Personal Care' }, 'full').length, 1); assert.match(csv(rows, 'full'), /Master Category/); });
test('upload validation never calls Gemini before processing and processing calls it for unknown products', async () => { let calls = 0; const file = { originalname: 'orders.csv', buffer: Buffer.from('Order ID,Order Date,Status,Product Name,Order Quantity,Product Price,Payment Mode,Courier,Order Source\n1,2026-01-01,Delivered,S-Famw Nail Serum 349,1,10,COD,C,Store\n') }; const validated = validateUpload(file, { classify: false }); assert.equal(validated.success, true); const result = await processValidatedUpload(validated, { masterCategories: ['Beauty & Personal Care'], productCategories: [{ name: 'Nail Serum', masterCategory: 'Beauty & Personal Care' }], productClassifier: { classifyProducts(products) { calls += 1; return { results: [{ product: products[0], masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum' }] }; } } }); assert.equal(calls, 1); assert.equal(result.classifications.products[0].mappingSource, 'ai-suggested'); });
test('upload validation returns safe, structured details for supported templates and invalid files', () => {
  for (const templateType of ['simple', 'full']) for (const [extension, buffer] of [['csv', Buffer.from(csvTemplate(templateType))], ['xlsx', xlsxTemplate(templateType)]]) { const result = validateUpload({ originalname: `orders.${extension}`, buffer }, { templateType, classify: false }); assert.equal(result.success, true, `${templateType} ${extension}`); }
  const missing = validateUpload({ originalname: 'missing.csv', buffer: Buffer.from('Order ID,Status\n1,Delivered\n') }, { templateType: 'simple', classify: false }); assert.equal(missing.code, 'MISSING_REQUIRED_COLUMNS'); assert.deepEqual(missing.details.missingColumns, ['Order Date', 'Product Name', 'Payment Mode']);
  const invalid = validateUpload({ originalname: 'invalid.csv', buffer: Buffer.from('Order ID,Order Date,Order Status,Product Name,Payment Mode\n,not-a-date,Delivered,Widget,COD\n') }, { templateType: 'simple', classify: false }); assert.equal(invalid.code, 'INVALID_ROWS'); assert.equal(invalid.details.errorCount, 3); assert.ok(invalid.details.errors.every((item) => item.row === 2 && item.column && item.type));
  const wrongTemplate = validateUpload({ originalname: 'wrong-template.csv', buffer: Buffer.from(csvTemplate('full')) }, { templateType: 'simple', classify: false }); assert.equal(wrongTemplate.code, 'UNKNOWN_COLUMNS'); assert.deepEqual(wrongTemplate.details.unknownColumns, ['Product Qty', 'Product Price', 'Courier', 'Source/Website/Store']);
  assert.equal(validateUpload({ originalname: 'empty.csv', buffer: Buffer.alloc(0) }, { templateType: 'simple' }).code, 'EMPTY_FILE');
  assert.equal(validateUpload({ originalname: 'orders.pdf', buffer: Buffer.from('file') }, { templateType: 'simple' }).code, 'UNSUPPORTED_FILE_TYPE');
});
test('Gemini uses the hardcoded Flash-Lite model and GEMINI_API_KEY only', () => { const classifier = new GeminiProductClassifier({ apiKey: 'key', model: 'other' }); assert.equal(classifier.model, 'gemini-2.5-flash-lite'); });
test('report process keeps a complete review snapshot and only one active process', async () => {
  const store = new ProcessingStore({ mongoUri: null });
  const input = { summary: { detectedProducts: 2 }, templateType: 'simple', file: { name: 'orders.csv' }, normalizedRows: [] };
  const first = await store.createValidated('client-a', input, 'request-a');
  const second = await store.createValidated('client-a', input, 'request-b');
  assert.equal(second.existing, true); assert.equal(second.job.processId, first.job.processId);
  first.job.status = 'review_required'; first.job.result = { classifications: { statuses: [], products: [{ value: 'A', classificationRequired: true }, { value: 'B', classificationRequired: true }] } }; await store.save(first.job);
  await store.updateReview('client-a', first.job.processId, 'product', 'A', { status: 'AI Approved', classificationRequired: false, masterCategory: 'Beauty', productCategory: 'Serum' });
  const restored = await store.get('client-a', first.job.processId); assert.equal(restored.result.classifications.products.length, 2); assert.equal(restored.result.classifications.products[0].classificationRequired, false); assert.equal(restored.result.classifications.products[1].classificationRequired, true);
});
test('completion does not overwrite a cancelled process', async () => {
  const store = new ProcessingStore({ mongoUri: null });
  const created = await store.createValidated('client-complete-cancel', { summary: {}, templateType: 'simple', file: { name: 'orders.csv' }, normalizedRows: [] }, 'request-complete-cancel');
  await store.cancel('client-complete-cancel', created.job.processId);
  const completed = await store.complete(created.job, { reportId: 'should-not-complete' });
  assert.equal(completed.status, 'cancelled');
  assert.equal((await store.get('client-complete-cancel', created.job.processId)).status, 'cancelled');
});

test('cancelling a processing job prevents late stage updates from restoring it', async () => {
  const store = new ProcessingStore({ mongoUri: null });
  const input = { summary: { detectedProducts: 1 }, templateType: 'simple', file: { name: 'orders.csv' }, normalizedRows: [] };
  const created = await store.createValidated('client-cancel', input, 'request-cancel');
  let release; const waiting = new Promise((resolve) => { release = resolve; });
  const running = store.start('client-cancel', created.job.processId, async (job, stage) => { await stage('mapping_statuses'); await waiting; await stage('finalizing_report'); return { classifications: { statuses: [], products: [] } }; });
  await new Promise((resolve) => setImmediate(resolve));
  await store.cancel('client-cancel', created.job.processId); release();
  const finished = await running; const restored = await store.get('client-cancel', created.job.processId);
  assert.equal(finished.status, 'cancelled'); assert.equal(restored.status, 'cancelled'); assert.equal(restored.stage, 'cancelled');
});
test('CSV preserves actual courier status separately from normalized status category', () => {
  const output = csv([{ orderId: 'ORD001', orderDate: '2026-01-01', originalStatus: 'Out for Delivery', category: 'In Transit', originalProductName: 'Nail Serum', masterCategory: 'Beauty', productCategory: 'Nail Serum', paymentMode: 'COD' }], 'simple');
  assert.match(output, /Actual Status/); assert.match(output, /Status Category/); assert.match(output, /"Out for Delivery","In Transit"/);
});

const { UniversalStore, UniversalOrder, UniversalOrderOccurrence, UniversalSync, ReportStore } = require('../src/reports');
function universalReport(clientId, reportId, completedAt, orderDate = '2026-01-01') { return { clientId, reportId, reportStatus: 'completed', completedAt: new Date(completedAt), sourceFileName: 'orders.csv', templateType: 'full', orderDate }; }
function universalRow(orderId, orderDate = '2026-01-01', product = 'Widget', quantity = 1) { return { orderId, normalizedOrderId: orderId, orderDate, category: 'Delivered', originalStatus: 'Delivered', normalizedStatus: 'delivered', originalProductName: product, normalizedProductName: product.toLowerCase(), productCategory: 'Widgets', masterCategory: 'Goods', quantity, productPrice: 10, rowValue: quantity * 10, paymentMode: 'COD', courier: 'Courier', orderSource: 'Store' }; }
test('universal schemas enforce client-scoped uniqueness boundaries and expected indexes', () => {
  assert.ok(UniversalOrder.schema.indexes().some(([key, options]) => key.clientId === 1 && key.canonicalOrderId === 1 && options.unique));
  assert.ok(UniversalOrderOccurrence.schema.indexes().some(([key, options]) => key.clientId === 1 && key.reportId === 1 && key.canonicalOrderId === 1 && options.unique));
  assert.ok(UniversalSync.schema.indexes().some(([key, options]) => key.clientId === 1 && key.reportId === 1 && options.unique));
});
test('universal sync groups product rows, keeps occurrences immutable, and is idempotent', async () => {
  const store = new UniversalStore({ mongoUri: null }); const report = universalReport('a', 'R1', '2026-02-01T00:00:00Z');
  const first = await store.syncCompletedReport('a', report, [universalRow(' Order 1 ', '2020-01-01', 'One'), universalRow('Order 1', '2020-01-01', 'Two', 2)]);
  const retry = await store.syncCompletedReport('a', report, [universalRow('Order 1', '2020-01-01', 'One')]);
  assert.equal(first.counts.occurrencesCreated, 1); assert.equal(store.orders.size, 1); assert.equal([...store.orders.values()][0].products.length, 2); assert.equal(store.occurrences.size, 1); assert.equal(retry.alreadyCompleted, true); assert.equal(retry.counts.occurrencesCreated, 1);
  await store.syncCompletedReport('a', universalReport('a', 'R2', '2026-02-02T00:00:00Z'), [universalRow('Order 1')]);
  assert.equal(store.occurrences.size, 2);
});
test('concurrent completed-report synchronization creates one occurrence per canonical order', async () => {
  const store = new UniversalStore({ mongoUri: null }); const report = universalReport('a', 'R-concurrent', '2026-02-01T00:00:00Z');
  await Promise.all(Array.from({ length: 8 }, () => store.syncCompletedReport('a', report, [universalRow(' Order 1 ', '2026-01-01', 'One'), universalRow('Order 1', '2026-01-01', 'Two')])));
  assert.equal(store.orders.size, 1); assert.equal(store.occurrences.size, 1); assert.equal(store.syncs.get(store.key('a', report.reportId)).status, 'completed');
});
test('universal latest projection uses only completion time then reportId and isolates clients', async () => {
  const store = new UniversalStore({ mongoUri: null });
  await store.syncCompletedReport('a', universalReport('a', 'R9', '2026-03-02T00:00:00Z'), [universalRow('same', '2000-01-01', 'New')]);
  await store.syncCompletedReport('a', universalReport('a', 'R1', '2026-03-01T00:00:00Z'), [universalRow('same', '2099-01-01', 'Old')]);
  assert.equal(store.orders.get(store.key('a', 'same')).products[0].originalProductName, 'New');
  await store.syncCompletedReport('a', universalReport('a', 'RZ', '2026-03-02T00:00:00Z'), [universalRow('same', '1999-01-01', 'Tie winner')]);
  assert.equal(store.orders.get(store.key('a', 'same')).latestReportId, 'RZ');
  await store.syncCompletedReport('b', universalReport('b', 'R1', '2026-01-01T00:00:00Z'), [universalRow('same', '2099-01-01', 'Other client')]);
  assert.equal(store.orders.size, 2); assert.equal(store.orders.get(store.key('b', 'same')).products[0].originalProductName, 'Other client');
});
test('incomplete reports do not synchronize and a universal sync failure does not undo a completed report', async () => {
  const universal = new UniversalStore({ mongoUri: null });
  assert.equal((await universal.syncCompletedReport('a', { ...universalReport('a', 'bad', '2026-01-01'), reportStatus: 'processing' }, [universalRow('1')])).status, 'skipped');
  const reports = new ReportStore({ mongoUri: null, universalStore: universal });
  universal.syncCompletedReport = async () => { throw new Error('storage unavailable'); };
  const warn = console.warn; console.warn = () => {}; let report; try { report = await reports.create('a', { templateType: 'full', sourceFileName: 'orders.csv', rows: [universalRow('1')] }); } finally { console.warn = warn; }
  assert.equal(report.reportStatus, 'completed'); assert.equal((await reports.list('a')).length, 1); assert.equal(universal.syncs.get(universal.key('a', report.reportId)).status, 'failed');
});

test('completed report lifecycle persists canonical rows, then retries a failed universal projection without duplicates', async () => {
  const universal = new UniversalStore({ mongoUri: null }); const reports = new ReportStore({ mongoUri: null, universalStore: universal });
  const originalSync = universal.syncCompletedReport.bind(universal); let attempts = 0;
  universal.syncCompletedReport = async (...args) => { attempts += 1; if (attempts === 1) throw new Error('temporary projection failure'); return originalSync(...args); };
  const warn = console.warn; console.warn = () => {}; let report;
  try { report = await reports.create('a', { templateType: 'full', sourceFileName: 'orders.csv', rows: [universalRow(' Order 100 ', '2026-01-01', 'One'), universalRow('Order 100', '2026-01-01', 'Two', 2)] }); } finally { console.warn = warn; }
  assert.equal(report.reportStatus, 'completed'); assert.equal(reports.rows.get(report.reportId)[0].orderDate, '2026-01-01');
  assert.equal(universal.syncs.get(universal.key('a', report.reportId)).status, 'failed');
  const retried = await reports.retryUniversal('a', report.reportId);
  assert.equal(retried.status, 'completed'); assert.equal(universal.orders.size, 1); assert.equal(universal.occurrences.size, 1); assert.equal([...universal.orders.values()][0].products.length, 2);
  const duplicateRetry = await reports.retryUniversal('a', report.reportId);
  assert.equal(duplicateRetry.alreadyCompleted, true); assert.equal(universal.occurrences.size, 1);
});

test('universal read APIs paginate, validate, sort, and remain scoped to the server client', async () => {
  const app = require('../src/app'); const previousStore = app.locals.universalStore; const store = new UniversalStore({ mongoUri: null }); const client = app.locals.clientId; app.locals.universalStore = store;
  await store.syncCompletedReport(client, universalReport(client, 'R1', '2026-02-01T00:00:00Z'), [universalRow('ORD-2', '2026-01-02'), universalRow('ORD-1', '2026-01-01')]);
  await store.syncCompletedReport(client, universalReport(client, 'R2', '2026-02-02T00:00:00Z'), [universalRow('ORD-1', '2026-01-03', 'New', 2)]);
  await store.syncCompletedReport('other-client', universalReport('other-client', 'R3', '2026-02-03T00:00:00Z'), [universalRow('ORD-OTHER')]);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); }); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await authenticatedFetch(base, `/api/universal/orders?limit=1&sortBy=canonicalOrderId&sortDirection=asc&clientId=other-client`); let body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.orders[0].canonicalOrderId, 'ORD-1'); assert.deepEqual(body.pagination, { page: 1, limit: 1, total: 2, totalPages: 2 });
    response = await authenticatedFetch(base, `/api/universal/orders?search=ORD-2`); body = await response.json(); assert.equal(body.orders.length, 1); assert.equal(body.orders[0].canonicalOrderId, 'ORD-2');
    response = await authenticatedFetch(base, `/api/universal/orders?limit=101`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/orders?page=-1`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/orders?fromDate=2026-99-99`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/orders?sortBy[$ne]=createdAt`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/orders/ORD-1`); body = await response.json(); assert.equal(body.order.latestReportId, 'R2');
    response = await authenticatedFetch(base, `/api/universal/orders/ORD-OTHER`); assert.equal(response.status, 404);
    response = await authenticatedFetch(base, `/api/universal/orders/ORD-1/history?limit=1`); body = await response.json(); assert.equal(body.occurrences[0].reportId, 'R2'); assert.equal(body.pagination.total, 2);
    response = await authenticatedFetch(base, `/api/universal/summary`); body = await response.json(); assert.deepEqual(body.summary, { totalOrders: 2, totalValue: 30, totalQuantity: 3, byStatusCategory: { Delivered: 2 }, byStatus: { Delivered: 2 } });
    response = await authenticatedFetch(base, `/api/universal/grouped?analyzeBy=product&paymentMode=COD&clientId=other-client`); body = await response.json(); assert.equal(body.report.groupLabel, 'Product'); assert.equal(body.report.totals.totalOrders, 2); assert.equal(body.report.rows.reduce((total, row) => total + row.delivered, 0), 2); assert.deepEqual(body.report.paymentModes, ['COD']);
    response = await authenticatedFetch(base, `/api/universal/grouped?analyzeBy=paymentMode`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/grouped?analyzeBy=product&deliveryView=invalid`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/grouped?analyzeBy=product`); body = await response.json(); assert.equal(body.report.deliveryView, 'all_orders');
    response = await authenticatedFetch(base, `/api/universal/summary?search=ORD-2&clientId=other-client`); body = await response.json(); assert.equal(body.summary.totalOrders, 1); assert.equal(body.summary.totalQuantity, 1);
    response = await authenticatedFetch(base, `/api/universal/analytics?status=Delivered&fromDate=2026-01-02&toDate=2026-01-02&reportFromDate=2026-02-01&reportToDate=2026-02-01&clientId=other-client`); body = await response.json(); assert.equal(body.analytics.summary.totalOrders, 1); assert.equal(body.analytics.statusCategories[0].percentage, 100); assert.equal(body.analytics.trends[0].date, '2026-01-02');
    response = await authenticatedFetch(base, `/api/universal/analytics?fromDate=2026-01-02&toDate=2026-01-01`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/analytics?status[$ne]=Delivered`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/orders/does-not-exist/history`); assert.equal(response.status, 404);
  } finally { await new Promise((resolve) => server.close(resolve)); app.locals.universalStore = previousStore; }
});

test('universal CSV export streams only filtered current tenant orders and preserves product lines safely', async () => {
  const app = require('../src/app'); const previousStore = app.locals.universalStore; const store = new UniversalStore({ mongoUri: null }); const client = app.locals.clientId; app.locals.universalStore = store;
  await store.syncCompletedReport(client, universalReport(client, 'EXP-1', '2026-02-01T00:00:00Z'), [
    { ...universalRow('SAFE-1', '2026-01-01', '=Formula', 2), category: 'RTO', originalStatus: '+Returned' },
    { ...universalRow('SAFE-1', '2026-01-01', '@Other', 1), category: 'RTO', originalStatus: '+Returned' },
    universalRow('DEL-1', '2026-01-02', 'Normal', 1)
  ]);
  await store.syncCompletedReport('other-client', universalReport('other-client', 'EXP-2', '2026-02-01T00:00:00Z'), [universalRow('PRIVATE-1', '2026-01-01', 'Secret', 1)]);
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); }); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await authenticatedFetch(base, `/api/universal/export?statusCategory=RTO&fromDate=2026-01-01&toDate=2026-01-01&clientId=other-client`); const output = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/csv/); assert.match(output, /Actual Status.*Status Category/); assert.match(output, /"'\+Returned","RTO"/); assert.match(output, /"'=Formula"/); assert.match(output, /"'@Other"/); assert.equal((output.match(/SAFE-1/g) || []).length, 2); assert.doesNotMatch(output, /DEL-1|PRIVATE-1/);
    response = await authenticatedFetch(base, `/api/universal/export?statusCategory[$ne]=RTO`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/export?$where=sleep(1)`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/export?search[$regex]=SAFE`); assert.equal(response.status, 422);
    response = await authenticatedFetch(base, `/api/universal/export?statusCategory=Cancelled`); assert.equal(response.status, 200); assert.match(await response.text(), /Order ID/);
    response = await authenticatedFetch(base, `/api/universal/export?fromDate=2026-01-01&toDate=2026-01-01&exportType=full&format=xlsx`); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /spreadsheetml/); assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 2)], [80, 75]);
    response = await authenticatedFetch(base, `/api/universal/export?fromDate=2026-01-02&toDate=2026-01-02&analyzeBy=product&deliveryView=shipped_orders&exportType=summary&format=csv`); const summaryCsv = await response.text(); assert.equal(response.status, 200); assert.match(summaryCsv, /"Report Basis","Shipped Orders"/); assert.match(summaryCsv, /"Normal","1","0","0","0","0","0","1","100"/);
    response = await authenticatedFetch(base, `/api/universal/export?fromDate=2026-01-02&toDate=2026-01-02&analyzeBy=product&deliveryView=shipped_orders&exportType=summary&format=xlsx`); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /spreadsheetml/); assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 2)], [80, 75]);
  } finally { await new Promise((resolve) => server.close(resolve)); app.locals.universalStore = previousStore; }
});

test('universal export limit is checked before the current-order iterator is created', async () => {
  const store = new UniversalStore({ mongoUri: null });
  await store.syncCompletedReport('a', universalReport('a', 'L1', '2026-02-01T00:00:00Z'), [universalRow('ONE'), universalRow('TWO')]);
  const result = await store.exportCurrentOrders('a', {}, { maxOrders: 1 });
  assert.equal(result.overLimit, true); assert.equal(result.total, 2); assert.equal(result.orders, undefined);
});

test('Universal Report frontend uses the grouped business report without legacy search controls', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(html, /data-page="universal"/); assert.match(html, /data-analyze="product"/); assert.match(html, /Product Category/); assert.match(html, /Courier/); assert.match(html, /REPORT BASIS/); assert.match(html, /All Orders/); assert.match(html, /Shipped Orders/); assert.match(html, /name="deliveryView" value="all_orders"/); assert.match(html, /data-payment="COD"/); assert.match(html, /Last 30 Days/); assert.match(html, /Summary Report/);
  assert.doesNotMatch(html, /Search order ID|Latest status|Category Status|name="categoryStatus"/);
  assert.match(script, /\/api\/universal\/grouped/); assert.match(script, /data-delivery-view/); assert.match(script, /\['Delivery %', 'deliveryPercentage'\]/); assert.doesNotMatch(script, /form\.elements\.search/);
});


test('universal grouped report uses normalized dimensions, tenant scope, and payment mode filtering', async () => {
  const store = new UniversalStore({ mongoUri: null });
  await store.syncCompletedReport('a', universalReport('a', 'G1', '2026-02-01T00:00:00Z'), [
    { ...universalRow('ONE', '2026-01-01', 'Widget', 2), normalizedProductName: 'widget', courier: 'Delhivery', paymentMode: 'COD' },
    { ...universalRow('TWO', '2026-01-02', ' widget ', 1), normalizedProductName: 'widget', courier: 'delhivery', paymentMode: 'Prepaid', category: 'RTO', originalStatus: 'Returned' }
  ]);
  await store.syncCompletedReport('b', universalReport('b', 'G2', '2026-02-01T00:00:00Z'), [universalRow('PRIVATE')]);
  const products = await store.groupedReport('a', { analyzeBy: 'product' });
  assert.equal(products.groupLabel, 'Product'); assert.deepEqual(products.range, { from: '2026-01-01', to: '2026-01-02' }); assert.equal(products.rows.length, 1); assert.equal(products.rows[0].totalOrders, 2); assert.equal(products.rows[0].delivered, 1); assert.equal(products.rows[0].rto, 1); assert.equal(products.rows[0].deliveryPercentage, 50); assert.equal(products.totals.totalOrders, 2);
  const courier = await store.groupedReport('a', { analyzeBy: 'courier' });
  assert.equal(courier.rows.length, 1); assert.equal(courier.rows[0].totalOrders, 2); assert.equal(courier.rows[0].deliveryPercentage, 50);
  const filtered = await store.groupedReport('a', { analyzeBy: 'category_status', paymentMode: 'COD' });
  assert.equal(filtered.totals.totalOrders, 1); assert.equal(filtered.rows.find((row) => row.name === 'Delivered').totalOrders, 1); assert.equal(filtered.rows.find((row) => row.name === 'Delivered').deliveryPercentage, 100); assert.equal(filtered.rows.find((row) => row.name === 'RTO').totalOrders, 0); assert.equal(filtered.rows.find((row) => row.name === 'RTO').deliveryPercentage, 0);
});
test('report basis applies to summary and each group without changing counts or values', async () => {
  const store = new UniversalStore({ mongoUri: null });
  const rows = [
    ['A1', 'Alpha', 'Delivered'], ['A2', 'Alpha', 'Delivered'], ['A3', 'Alpha', 'NDR'],
    ['A4', 'Alpha', 'RTO'], ['A5', 'Alpha', 'In Transit'], ['A6', 'Alpha', 'Cancelled'],
    ['A7', 'Alpha', 'Other'], ['B1', 'Beta', 'Delivered'], ['B2', 'Beta', 'RTO'],
    ['B3', 'Beta', 'Cancelled'], ['C1', 'Gamma', 'In Transit']
  ].map(([id, product, category]) => ({ ...universalRow(id, '2026-01-01', product), category, originalStatus: category, productCategory: product, courier: product }));
  // Duplicate product lines must not multiply order counts or the shipped denominator.
  await store.syncCompletedReport('a', universalReport('a', 'BASIS', '2026-02-01T00:00:00Z'), [...rows, rows[0]]);
  for (const analyzeBy of ['product', 'product_category', 'courier', 'category_status']) {
    const all = await store.groupedReport('a', { analyzeBy });
    const shipped = await store.groupedReport('a', { analyzeBy, deliveryView: 'shipped_orders' });
    assert.equal(all.deliveryView, 'all_orders');
    assert.equal(all.orderTotalLabel, 'Total Orders');
    assert.equal(shipped.orderTotalLabel, 'Shipped Orders');
    assert.equal(all.totals.orderTotal, 11);
    assert.equal(shipped.totals.orderTotal, 8);
    assert.equal(shipped.totals.totalOrders, 11);
    assert.equal(shipped.totals.shippedOrders, 8);
    assert.equal(all.totals.deliveryPercentage, 27.27);
    assert.equal(shipped.totals.deliveryPercentage, 37.5);
    assert.deepEqual(all.totals.percentages, { Delivered: 27.27, 'In Transit': 18.18, NDR: 9.09, RTO: 18.18, Cancelled: 18.18, Other: 9.09 });
    assert.deepEqual(shipped.totals.percentages, { Delivered: 37.5, 'In Transit': 25, NDR: 12.5, RTO: 25, Cancelled: null, Other: null });
    assert.deepEqual(shipped.totals.byStatusCategory, all.totals.byStatusCategory);
    assert.equal(shipped.totals.totalValue, all.totals.totalValue);
    for (const row of shipped.rows) {
      const original = all.rows.find((item) => item.name === row.name);
      for (const field of ['totalOrders', 'delivered', 'ndr', 'rto', 'inTransit', 'cancelled', 'other', 'totalOrderValue', 'deliveredOrderValue']) assert.equal(row[field], original[field]);
      assert.equal(row.orderTotal, row.delivered + row.inTransit + row.ndr + row.rto);
      assert.equal(row.percentages['In Transit'], row.orderTotal ? Number((row.inTransit * 100 / row.orderTotal).toFixed(2)) : 0);
      assert.equal(row.percentages.Cancelled, null);
      assert.equal(row.percentages.Other, null);
    }
    if (analyzeBy !== 'category_status') {
      const alpha = shipped.rows.find((row) => row.name === 'Alpha');
      const beta = shipped.rows.find((row) => row.name === 'Beta');
      const zero = shipped.rows.find((row) => row.name === 'Gamma');
      assert.equal(all.rows.find((row) => row.name === 'Alpha').deliveryPercentage, 28.57);
      assert.equal(alpha.orderTotal, 5); assert.equal(alpha.deliveryPercentage, 40);
      assert.equal(alpha.percentages['In Transit'], 20); assert.equal(alpha.percentages.NDR, 20); assert.equal(alpha.percentages.RTO, 20);
      assert.equal(beta.orderTotal, 2); assert.equal(beta.deliveryPercentage, 50); assert.equal(beta.percentages.RTO, 50);
      assert.equal(zero.orderTotal, 1); assert.equal(zero.deliveryPercentage, 0); assert.equal(zero.percentages['In Transit'], 100); assert.equal(zero.inTransit, 1);
    }
  }
  for (const deliveryView of ['all_orders', 'shipped_orders']) {
    const empty = await store.groupedReport('a', { deliveryView, fromDate: '2026-02-01' });
    assert.equal(empty.totals.orderTotal, 0); assert.equal(empty.totals.deliveryPercentage, 0); assert.deepEqual(empty.rows, []);
    const excluded = await store.groupedReport('a', { deliveryView, statusCategory: 'Cancelled' });
    assert.equal(excluded.totals.cancelledOrders, 2);
    assert.equal(excluded.totals.orderTotal, deliveryView === 'all_orders' ? 2 : 0);
    assert.equal(excluded.totals.deliveryPercentage, 0);
  }
});

test('shipped basis matches the 821-order example and excludes cancelled and other', async () => {
  const store = new UniversalStore({ mongoUri: null });
  const counts = { Delivered: 48, 'In Transit': 445, NDR: 146, RTO: 182, Cancelled: 1, Other: 1 };
  const rows = Object.entries(counts).flatMap(([category, count]) => Array.from({ length: count }, (_, index) => ({
    ...universalRow(`${category}-${index}`, '2026-01-01', 'Example'), category, originalStatus: category
  })));
  await store.syncCompletedReport('a', universalReport('a', 'EXAMPLE', '2026-02-01T00:00:00Z'), rows);
  const all = await store.groupedReport('a', { analyzeBy: 'product' });
  const shipped = await store.groupedReport('a', { analyzeBy: 'product', deliveryView: 'shipped_orders' });
  assert.equal(all.totals.orderTotal, 823);
  assert.equal(all.totals.deliveryPercentage, 5.83);
  assert.equal(shipped.totals.orderTotal, 821);
  assert.equal(shipped.totals.deliveryPercentage, 5.85);
  assert.equal(shipped.totals.percentages['In Transit'], 54.2);
  assert.equal(shipped.rows[0].orderTotal, 821);
  assert.equal(shipped.rows[0].deliveryPercentage, 5.85);
  assert.equal(shipped.totals.cancelledOrders, 1);
  assert.equal(shipped.totals.otherOrders, 1);
});

test('summary CSV and XLSX exports use the selected basis with mixed status groups', async () => {
  const app = require('../src/app'); const previousStore = app.locals.universalStore;
  const store = new UniversalStore({ mongoUri: null }); app.locals.universalStore = store;
  await store.syncCompletedReport(app.locals.clientId, universalReport(app.locals.clientId, 'BASIS-EXPORT', '2026-02-01T00:00:00Z'),
    ['Delivered', 'NDR', 'In Transit', 'Cancelled', 'Other'].map((category, index) => ({ ...universalRow(`EXPORT-${index}`, '2026-01-01', 'Mixed'), category, originalStatus: category })));
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); }); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [basis, label, total, percentage] of [['all_orders', 'Total Orders', 5, 20], ['shipped_orders', 'Shipped Orders', 3, 33.33]]) {
      const query = `analyzeBy=product&deliveryView=${basis}&exportType=summary`;
      let response = await authenticatedFetch(base, `/api/universal/export?${query}&format=csv`);
      assert.equal(response.status, 200);
      const csv = await response.text();
      assert.ok(csv.includes(`"${label}","Delivery %"`));
      assert.ok(csv.includes(`"Mixed","1","1","1","0","1","1","${total}","${percentage}"`));
      response = await authenticatedFetch(base, `/api/universal/export?${query}&format=xlsx`);
      assert.equal(response.status, 200);
      // The workbook writer stores XML without compression. Inspect actual cells, not just the ZIP signature.
      const workbook = Buffer.from(await response.arrayBuffer()).toString();
      assert.ok(workbook.includes('<t>Report Basis</t>'));
      assert.ok(workbook.includes(`<t>${label}</t>`));
      assert.ok(workbook.includes(`<c r="H3"><v>${total}</v></c><c r="I3"><v>${percentage}</v></c>`));
    }
    const response = await authenticatedFetch(base, '/api/universal/export?analyzeBy=product&deliveryView=shipped_orders&exportType=full&format=csv&sortBy=canonicalOrderId&sortDirection=asc');
    assert.equal(response.status, 200);
    const full = await response.text();
    for (let index = 0; index < 5; index += 1) assert.ok(full.includes(`EXPORT-${index}`));
  } finally { await new Promise((resolve) => server.close(resolve)); app.locals.universalStore = previousStore; }
});

test('universal analytics are tenant-scoped, filter-aware, and preserve product-line quantities', async () => {
  const store = new UniversalStore({ mongoUri: null });
  await store.syncCompletedReport('a', universalReport('a', 'A1', '2026-02-01T00:00:00Z'), [
    { ...universalRow('A-RTO', '2026-01-01', 'Widget', 2), category: 'RTO', originalStatus: 'Returned' },
    { ...universalRow('A-RTO', '2026-01-01', 'Gadget', 1), category: 'RTO', originalStatus: 'Returned' },
    universalRow('A-DEL', '2026-01-02', 'Widget', 3)
  ]);
  await store.syncCompletedReport('b', universalReport('b', 'B1', '2026-02-01T00:00:00Z'), [universalRow('B-ONLY', '2026-01-01', 'Secret', 99)]);
  const all = await store.analytics('a');
  assert.equal(all.summary.totalOrders, 2); assert.equal(all.summary.rtoOrders, 1); assert.equal(all.summary.rtoPercentage, 50);
  assert.deepEqual(all.statusCategories.find((item) => item.name === 'RTO'), { name: 'RTO', count: 1, percentage: 50 });
  assert.equal(all.products.find((item) => item.name === 'Widget').quantity, 5);
  assert.equal(all.products.find((item) => item.name === 'Widget').orderCount, 2);
  const filtered = await store.analytics('a', { statusCategory: 'RTO', fromDate: '2026-01-01', toDate: '2026-01-01' });
  assert.equal(filtered.summary.totalOrders, 1); assert.equal(filtered.summary.totalQuantity, 3); assert.equal(filtered.trends[0].date, '2026-01-01');
  assert.equal((await store.summary('a', { search: 'A-RTO' })).totalOrders, 1);
});

test('Report Review frontend uses accessible custom dialogs and selection-based bulk actions', () => {
  const fs = require('node:fs');
  const script = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(script, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.match(script, /function openCategoryModal\(/);
  assert.match(script, /aria-modal/);
  assert.match(script, /selectAll\.indeterminate/);
  assert.match(script, /function bulkProductAction\(/);
  assert.match(script, /Reject suggestion/);
  assert.match(script, /function resetCurrentResult\(/);
  assert.match(script, /Clear current result\?/);
  assert.match(script, /selectedProducts\.clear\(\)/);
  assert.doesNotMatch(script, /Approve All AI Suggestions/);
});

test('unfinished failed processes remain active until the client explicitly removes them', async () => {
  const store = new ProcessingStore({ mongoUri: null });
  const input = { summary: { detectedProducts: 1 }, templateType: 'simple', file: { name: 'orders.csv' }, normalizedRows: [] };
  const first = await store.createValidated('client-active', input, 'request-a');
  first.job.status = 'failed';
  await store.save(first.job);
  assert.equal((await store.getActiveProcess('client-active')).processId, first.job.processId);
  const second = await store.createValidated('client-active', input, 'request-b');
  assert.equal(second.existing, true);
  await store.cancel('client-active', first.job.processId);
  assert.equal(await store.getActiveProcess('client-active'), null);
});

test('unfinished process index includes failed jobs for existing deployments', () => {
  const { ProcessingStore } = require('../src/reports');
  const index = require('mongoose').models.ReportProcess.schema.indexes().find(([, options]) => options.name === 'one_active_unfinished_report_process_per_client_v2');
  assert.deepEqual(index[1].partialFilterExpression.status.$in, ['queued', 'processing', 'review_required', 'finalizing', 'failed']);
  assert.equal(typeof ProcessingStore, 'function');
});

test('Upload Data restoration has dedicated lifecycle states and does not reuse file validation errors', () => {
  const fs = require('node:fs');
  const script = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(script, /Checking your reports\.\.\./);
  assert.match(script, /Checking for unfinished reports\./);
  assert.match(script, /Couldn't check your current report\./);
  assert.match(script, /Couldn't restore your report\./);
  assert.match(script, /Previous report needs your attention/);
  assert.match(script, /Products remaining/);
  assert.match(script, /Statuses remaining/);
  assert.match(script, /AI suggestions remaining/);
  assert.match(script, /Total unresolved items/);
  assert.match(script, /Continue Review/);
  assert.match(script, /if \(name === 'upload'\) restoreActiveProcess\(\)/);
  assert.match(script, /function hasReviewSnapshot\(/);
  assert.match(script, /function unresolvedCount\(/);
  assert.match(script, /ACTIVE_REPORT_PROCESS/);
  assert.match(script, /restorePromise/);
  assert.match(script, /state\.validating/);
  assert.match(script, /if \(state\.restoring \|\| state\.validating/);
  assert.match(script, /refreshConfig\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(script, /function resetSelectedFile\(/);
  assert.match(script, /Unsupported file type/);
  assert.match(script, /Maximum supported size: \$\{maximumSize\}/);
  assert.match(script, /Checking your file…/);
  assert.match(script, /Cancel this report\?/);
  assert.match(script, /Cancelling report\.\.\./);
  assert.match(script, /Keep Processing/);
  assert.match(script, /Needs Review/);
  assert.match(script, /Assign Category/);
  assert.match(script, /Create new category/);
  assert.match(script, /Select All/);
  assert.match(script, /Apply to Selected/);
  assert.match(script, /Updating \$\{selected\.length\} status mappings/);
  assert.match(script, /statusErrors/);
  assert.match(script, /progress\.textContent = 'Cancelling report\.\.\.'/);
  const server = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(server, /function activeProcessUploadMessage\(/);
  assert.ok(server.indexOf('const active = await processingStore.getActiveProcess(clientId);') < server.indexOf('const result = validateUpload'));
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="file-upload" type="file" accept="\.csv,\.xlsx" hidden disabled/);
  assert.match(html, /id="selected-file" hidden/);
  assert.match(html, /id="remove-selected-file"/);
});

test('Upload Data starts with report selection and scopes templates to the chosen report type', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(html, /id="report-type-selector"/);
  assert.match(html, /data-report-type="simple"/);
  assert.match(html, /data-report-type="full"/);
  assert.match(html, /id="upload-workflow" hidden/);
  assert.match(html, /id="template-actions"/);
  assert.doesNotMatch(html, /data-template-link=/);
  assert.match(html, /id="change-report-type"/);
  assert.match(html, /✓ Selected/);
  assert.match(html, /Need a template\?/);
  assert.match(script, /selectedReportType: null/);
  assert.match(script, /function renderReportTypeSelection\(/);
  assert.match(script, /const REPORT_TEMPLATES/);
  assert.match(script, /function renderSelectedTemplates\(type\)/);
  assert.match(script, /clear\(actions\)/);
  assert.match(script, /Changing the report type will clear the current selected file\. Continue\?/);
  assert.match(script, /function renderProcessing\(process\)/);
  assert.match(script, /current-process-status/);
  assert.match(script, /Create a new master category/);
  assert.match(script, /Report cancelled/);
  assert.doesNotMatch(script, /const list = el\('ol', undefined, 'workflow-stepper'\); stages\.forEach/);
});

test('Report review bulk updates are server-authoritative and completion directs users to both reports', () => {
  const fs = require('node:fs');
  const script = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const appSource = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(appSource, /review\/:kind\/bulk/);
  assert.match(appSource, /Select between 1 and 200 unique values to update/);
  assert.match(script, /function saveBulkReviewDecision/);
  assert.match(script, /function bulkProductMapping/);
  assert.match(script, /Apply category/);
  assert.match(script, /function renderCompletion/);
  assert.match(script, /Open Universal Report/);
});

test('bulk mapping writes unique product and status selections without repeated process saves', async () => {
  const store = new MappingStore({ mongoUri: null }); const { master, product } = await taxonomy(store, 'bulk-client');
  await store.saveProductMappings('bulk-client', ['Widget', 'Widget', 'Gadget'], { masterCategory: master._id, productCategory: product.name, source: 'AI Approved' });
  assert.equal((await store.list('product', 'bulk-client')).length, 2);
  await store.saveMappings('bulk-client', 'status', ['Awaiting pickup', 'Awaiting pickup', 'Packed'], 'In Transit');
  assert.equal((await store.list('status', 'bulk-client')).length, 2);
  const processes = new ProcessingStore({ mongoUri: null }); const created = await processes.createValidated('bulk-client', { summary: {}, templateType: 'simple', file: { name: 'orders.csv' }, normalizedRows: [] }, 'bulk-process');
  created.job.status = 'review_required'; created.job.result = { classifications: { statuses: [], products: [{ value: 'Widget', classificationRequired: true }, { value: 'Gadget', classificationRequired: true }] } }; await processes.save(created.job);
  const updated = await processes.updateReviews('bulk-client', created.job.processId, 'product', [{ value: 'Widget', classificationRequired: false }, { value: 'Gadget', classificationRequired: false }]);
  assert.equal(updated.result.classifications.products.filter((item) => !item.classificationRequired).length, 2);
});
