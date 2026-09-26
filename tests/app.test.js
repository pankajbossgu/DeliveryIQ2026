const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough';
const { MappingStore } = require('../src/mappings');
const { classifyProducts } = require('../src/product');
const { GeminiProductClassifier, validateGeminiResults, GEMINI_MODEL } = require('../src/product-classifier');
const { validateUpload, processValidatedUpload, csvTemplate, xlsxTemplate } = require('../src/upload');
const { aggregate, applyFilters, csv } = require('../src/reports');
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
test('unknown products send complete taxonomy and accept specific new categories', async () => { let context; const provider = { classifyProducts(products, value) { context = value; return { model: GEMINI_MODEL, results: [{ product: products[0], masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum', confidence: .95 }] }; } }; const result = await classifyProducts(['S-Famw Nail Serum 349'], { masterCategories: [{ name: 'Beauty & Personal Care' }], productCategories: [{ name: 'Face Serum', masterCategory: 'Beauty & Personal Care' }], provider }); assert.deepEqual(context, { masterCategories: ['Beauty & Personal Care'], productCategories: [{ name: 'Face Serum', masterCategory: 'Beauty & Personal Care' }] }); assert.equal(result.items[0].suggestedProductCategory, 'Nail Serum'); });
test('Gemini validation requires safe master and specific product category response', () => { const out = validateGeminiResults({ results: [{ product: 'S-Famw Nail Serum 349', masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum' }, { product: 'Bad', masterCategory: '<bad>', productCategory: 'X' }] }, ['S-Famw Nail Serum 349', 'Bad'], { masterCategories: ['Beauty & Personal Care'], productCategories: [] }); assert.equal(out.length, 1); assert.equal(out[0].productCategory, 'Nail Serum'); });
test('approval saves taxonomy/mapping and next upload has zero Gemini calls', async () => { const store = new MappingStore({ mongoUri: null }); const { master } = await taxonomy(store); await store.saveProductMapping('a', 'S-Famw Nail Serum 349', { masterCategory: master._id, productCategory: 'Nail Serum', source: 'AI Approved' }); let calls = 0; const classified = await classifyProducts(['S-Famw Nail Serum 349'], { mappings: await store.list('product', 'a'), provider: { classifyProducts() { calls += 1; } } }); assert.equal(calls, 0); assert.equal(classified.items[0].masterCategory, 'Beauty & Personal Care'); });
test('manual fallback requires both categories and preserves status engine', async () => { const store = new MappingStore({ mongoUri: null }); await assert.rejects(store.saveProductMapping('a', 'Thing', { productCategory: 'Thing' }), { code: 'INVALID_CATEGORY' }); assert.equal(classifyStatus('Ready to Ship').category, 'In Transit'); assert.equal(classifyStatus('RTO NDR').category, 'RTO'); });
test('reports snapshot, filter, and export both taxonomy levels', () => { const rows = [{ normalizedOrderId: '1', category: 'Delivered', originalProductName: 'S-Famw Nail Serum 349', masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum', quantity: 1, rowValue: 349 }]; const report = aggregate(rows, 'full'); assert.equal(report.analytics.masterCategory[0].name, 'Beauty & Personal Care'); assert.equal(applyFilters(rows, { masterCategory: 'Beauty & Personal Care' }, 'full').length, 1); assert.match(csv(rows, 'full'), /Master Category/); });
test('upload validation never calls Gemini before processing and processing calls it for unknown products', async () => { let calls = 0; const file = { originalname: 'orders.csv', buffer: Buffer.from('Order ID,Order Date,Status,Product Name,Order Quantity,Product Price,Payment Mode,Courier,Order Source\n1,2026-01-01,Delivered,S-Famw Nail Serum 349,1,10,COD,C,Store\n') }; const validated = validateUpload(file, { classify: false }); assert.equal(validated.success, true); const result = await processValidatedUpload(validated, { productClassifier: { classifyProducts(products) { calls += 1; return { results: [{ product: products[0], masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum' }] }; } } }); assert.equal(calls, 1); assert.equal(result.classifications.products[0].mappingSource, 'ai-suggested'); });
test('upload validation returns safe, structured details for supported templates and invalid files', () => {
  for (const templateType of ['simple', 'full']) for (const [extension, buffer] of [['csv', Buffer.from(csvTemplate(templateType))], ['xlsx', xlsxTemplate(templateType)]]) { const result = validateUpload({ originalname: `orders.${extension}`, buffer }, { templateType, classify: false }); assert.equal(result.success, true, `${templateType} ${extension}`); }
  const missing = validateUpload({ originalname: 'missing.csv', buffer: Buffer.from('Order ID,Status\n1,Delivered\n') }, { templateType: 'simple', classify: false }); assert.equal(missing.code, 'MISSING_REQUIRED_COLUMNS'); assert.deepEqual(missing.details.missingColumns, ['Order Date', 'Product Name', 'Payment Mode']);
  const invalid = validateUpload({ originalname: 'invalid.csv', buffer: Buffer.from('Order ID,Order Date,Order Status,Product Name,Payment Mode\n,not-a-date,Delivered,Widget,COD\n') }, { templateType: 'simple', classify: false }); assert.equal(invalid.code, 'INVALID_ROWS'); assert.equal(invalid.details.errorCount, 3); assert.ok(invalid.details.errors.every((item) => item.row === 2 && item.column && item.type));
  assert.equal(validateUpload({ originalname: 'empty.csv', buffer: Buffer.alloc(0) }, { templateType: 'simple' }).code, 'EMPTY_FILE');
  assert.equal(validateUpload({ originalname: 'orders.pdf', buffer: Buffer.from('file') }, { templateType: 'simple' }).code, 'UNSUPPORTED_FILE_TYPE');
});
test('Gemini uses the hardcoded Flash-Lite model and GEMINI_API_KEY only', () => { const classifier = new GeminiProductClassifier({ apiKey: 'key', model: 'other' }); assert.equal(classifier.model, 'gemini-2.5-flash-lite'); });
test('report process keeps a complete review snapshot and only one active process', async () => {
  const { ProcessingStore } = require('../src/reports'); const store = new ProcessingStore({ mongoUri: null });
  const input = { summary: { detectedProducts: 2 }, templateType: 'simple', file: { name: 'orders.csv' }, normalizedRows: [] };
  const first = await store.createValidated('client-a', input, 'request-a');
  const second = await store.createValidated('client-a', input, 'request-b');
  assert.equal(second.existing, true); assert.equal(second.job.processId, first.job.processId);
  first.job.status = 'review_required'; first.job.result = { classifications: { statuses: [], products: [{ value: 'A', classificationRequired: true }, { value: 'B', classificationRequired: true }] } }; await store.save(first.job);
  await store.updateReview('client-a', first.job.processId, 'product', 'A', { status: 'AI Approved', classificationRequired: false, masterCategory: 'Beauty', productCategory: 'Serum' });
  const restored = await store.get('client-a', first.job.processId); assert.equal(restored.result.classifications.products.length, 2); assert.equal(restored.result.classifications.products[0].classificationRequired, false); assert.equal(restored.result.classifications.products[1].classificationRequired, true);
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
  } finally { await new Promise((resolve) => server.close(resolve)); app.locals.universalStore = previousStore; }
});

test('universal export limit is checked before the current-order iterator is created', async () => {
  const store = new UniversalStore({ mongoUri: null });
  await store.syncCompletedReport('a', universalReport('a', 'L1', '2026-02-01T00:00:00Z'), [universalRow('ONE'), universalRow('TWO')]);
  const result = await store.exportCurrentOrders('a', {}, { maxOrders: 1 });
  assert.equal(result.overLimit, true); assert.equal(result.total, 2); assert.equal(result.orders, undefined);
});

test('Universal Report frontend consumes the read-only current-state and history APIs', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(html, /data-page="universal"/); assert.match(html, /id="universal-filters"/); assert.match(html, /CURRENT ORDER STATE/);
  assert.match(script, /\/api\/universal\/summary/); assert.match(script, /\/api\/universal\/orders\?/); assert.match(script, /\/history\?limit=25/);
  assert.match(script, /HISTORICAL OBSERVATIONS/);
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
  assert.doesNotMatch(script, /Approve All AI Suggestions/);
});

test('unfinished failed processes remain active until the client explicitly removes them', async () => {
  const { ProcessingStore } = require('../src/reports');
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
  assert.match(script, /Checking for unfinished report\.\.\./);
  assert.match(script, /Please wait while we restore your previous report\./);
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
  assert.match(script, /Maximum supported size: 10 MB/);
  assert.match(script, /Checking your file…/);
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
  assert.match(html, /data-template-link="simple"/);
  assert.match(html, /data-template-link="full"/);
  assert.match(html, /id="change-report-type"/);
  assert.match(html, /✓ Selected/);
  assert.match(html, /Need a template\?/);
  assert.match(script, /selectedReportType: null/);
  assert.match(script, /function renderReportTypeSelection\(/);
  assert.match(script, /link\.hidden = link\.dataset\.templateLink !== selected/);
  assert.match(script, /Changing the report type will clear the current selected file\. Continue\?/);
});
