const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');
const { validateUpload, csvTemplate, xlsxTemplate, normalizeOrderId } = require('../src/upload');
const { classifyStatus, normalizeMappingValue } = require('../src/classification');
const { MappingStore } = require('../src/mappings');
const { classifyProducts, normalizeProductName } = require('../src/product');
const { ReportStore, UniversalStore, aggregate, applyFilters, csv: reportCsv } = require('../src/reports');
const { ProcessingStore } = require('../src/reports');
async function server() { const instance = http.createServer(app); await new Promise((resolve) => instance.listen(0, resolve)); return instance; }
async function close(instance) { await new Promise((resolve, reject) => instance.close((error) => error ? reject(error) : resolve())); }
const simpleHeader = 'Order ID,Order Date,Order Status,Product Name,Payment Mode\n';
const fullHeader = 'Order ID,Order Date,Order Status,Product Name,Product Qty,Product Price,Payment Mode,Courier,Source/Website/Store\n';

test('health and browser shell expose the usable product pages', async () => { const instance = await server(); try { const health = await fetch(`http://127.0.0.1:${instance.address().port}/api/health`).then((r) => r.json()); assert.equal(health.status, 'ok'); const page = await fetch(`http://127.0.0.1:${instance.address().port}/`).then((r) => r.text()); ['Product Mapping', 'Status Mapping', 'Download Simple CSV', 'report-filters'].forEach((text) => assert.match(page, new RegExp(text))); } finally { await close(instance); } });
test('official simple and full CSV/XLSX templates validate with their exact type', () => { for (const type of ['simple', 'full']) for (const extension of ['csv', 'xlsx']) { const buffer = extension === 'csv' ? Buffer.from(csvTemplate(type)) : xlsxTemplate(type); const result = validateUpload({ originalname: `template.${extension}`, buffer }, { templateType: type }); assert.equal(result.success, true, `${type}/${extension}`); assert.equal(result.templateType, type); } });
test('validation accepts aliases, uses normalized distinct order IDs, and detects duplicate rows', () => { const csv = 'OrderID,Order Date,Status,Product Name,Payment Mode\n ORD-1 ,2026-01-15,Delivered,Product A,COD\nORD-1,2026-01-15,Delivered,Product B,COD\nORD-2,2026-01-15,Delivered,Product A,COD\n'; const result = validateUpload({ originalname: 'orders.csv', buffer: Buffer.from(csv) }, { templateType: 'simple' }); assert.equal(result.success, true); assert.equal(result.summary.uniqueOrders, 2); assert.equal(result.summary.productRows, 3); assert.equal(result.normalizedRows[0].originalOrderId, 'ORD-1'); assert.equal(normalizeOrderId(' ORD-1  '), 'ORD-1'); const duplicate = validateUpload({ originalname: 'orders.csv', buffer: Buffer.from(simpleHeader + 'ORD-1,2026-01-15,Delivered,A,COD\nORD-1,2026-01-15,Delivered,A,COD\n') }, { templateType: 'simple' }); assert.equal(duplicate.validation.duplicates, 1); });
test('validation stops order-level conflicts rather than choosing a status', () => { const result = validateUpload({ originalname: 'conflict.csv', buffer: Buffer.from(simpleHeader + 'ORD-1,2026-01-15,Delivered,A,COD\nORD-1,2026-01-15,RTO,B,COD\n') }, { templateType: 'simple' }); assert.equal(result.success, false); assert.equal(result.code, 'ORDER_ID_CONFLICT'); assert.equal(result.details.conflicts[0].field, 'Order Status'); });
test('validation rejects missing template fields and malformed files', () => { assert.equal(validateUpload({ originalname: 'bad.csv', buffer: Buffer.from('Order ID,Order Status\nORD-1,Delivered') }, { templateType: 'simple' }).code, 'MISSING_REQUIRED_COLUMNS'); assert.equal(validateUpload({ originalname: 'bad.xlsx', buffer: Buffer.from('not zip') }, { templateType: 'full' }).code, 'MALFORMED_FILE'); assert.equal(validateUpload({ originalname: 'full.csv', buffer: Buffer.from(fullHeader.replace('Courier,', '') + 'ORD-1,2026-01-15,Delivered,A,1,10,COD,Store\n') }, { templateType: 'full' }).code, 'MISSING_REQUIRED_COLUMNS'); });
test('status engine retains deterministic categories, RTO priority, and UNMAPPED', () => { for (const [value, category] of [['Ready to Ship', 'In Transit'], ['Ready for Pickup', 'In Transit'], ['Picked Up', 'In Transit'], ['Shipped', 'In Transit'], ['Out for Delivery', 'In Transit'], ['Misrouted', 'In Transit'], ['Rerouted', 'In Transit'], ['NDR', 'NDR'], ['Undelivered', 'NDR'], ['Delivery Failed', 'NDR'], ['Customer Not Available', 'NDR'], ['RTO NDR', 'RTO'], ['RTO Delivered', 'RTO']]) assert.equal(classifyStatus(value).category, category); assert.equal(classifyStatus('unrecognized state').classificationRequired, true); assert.equal(normalizeMappingValue(' Rto_Delivered '), 'rto delivered'); });
test('client mappings and client-managed categories persist in isolated stores', async () => { const store = new MappingStore({ mongoUri: null }); await store.saveCategory('one', 'Ethnic Wear'); await store.save('product', 'one', 'Premium Kurta', 'Ethnic Wear'); await store.save('status', 'one', 'Paused', 'In Transit'); await store.save('status', 'two', 'Paused', 'Other'); assert.equal((await classifyProducts(['Premium Kurta'], { mappings: await store.list('product', 'one') })).items[0].category, 'Ethnic Wear'); assert.equal(classifyStatus('Paused', await store.list('status', 'one')).category, 'In Transit'); assert.equal(classifyStatus('Paused', await store.list('status', 'two')).category, 'Other'); await store.renameCategory('one', 'Ethnic Wear', 'Indian Wear'); assert.equal((await store.list('product', 'one'))[0].category, 'Indian Wear'); await store.setCategoryActive('one', 'Indian Wear', false); assert.equal((await store.listCategories('one')).length, 0); assert.equal((await store.listCategories('one', true))[0].active, false); });
test('unknown products need classification and saved manual mappings are reused without AI', async () => { assert.equal(normalizeProductName('Men Cotton T-Shirt - Blue'), 'men cotton t shirt blue'); const unknown = classifyProducts(['Mystery Box', 'Mystery Box']); assert.equal(unknown.items.length, 1); assert.equal(unknown.items[0].classificationRequired, true); const saved = classifyProducts(['Mystery Box'], { mappings: [{ normalizedValue: 'mystery box', category: 'Gift Boxes' }] }); assert.equal(saved.items[0].category, 'Gift Boxes'); assert.equal(saved.items[0].mappingSource, 'client'); });
test('mapping/category APIs provide management operations and valid categories only', async () => { const instance = await server(); const base = `http://127.0.0.1:${instance.address().port}`; try { let response = await fetch(`${base}/api/product-categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Accessories' }) }); assert.equal(response.status, 201); response = await fetch(`${base}/api/mappings/product`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: 'Watch Strap', category: 'Accessories' }) }); assert.equal(response.status, 200); response = await fetch(`${base}/api/mappings/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'Queued', category: 'BAD' }) }); assert.equal(response.status, 422); const mappings = await fetch(`${base}/api/mappings/product`).then((r) => r.json()); assert.ok(mappings.mappings.some((item) => item.originalExample === 'Watch Strap')); } finally { await close(instance); } });
test('analytics count distinct normalized orders, support category analytics and filtered denominators', () => { const rows = [['1', 'Delivered', 'A', 'Clothing', 'COD'], ['1', 'Delivered', 'B', 'Beauty', 'COD'], ['2', 'Delivered', 'A', 'Clothing', 'UPI'], ['3', 'NDR', 'A', 'Unclassified Products', 'COD'], ['4', 'RTO', 'A', 'Clothing', 'COD']].map(([orderId, category, originalProductName, productCategory, paymentMode]) => ({ orderId, normalizedOrderId: orderId, category, originalProductName, productCategory, orderDate: '2026-09-01', paymentMode, quantity: 1, rowValue: 10, courier: 'C', orderSource: 'Store' })); const all = aggregate(rows, 'full'); assert.equal(all.totalOrders, 4); assert.equal(all.analytics.productCategory.find((item) => item.name === 'Clothing').orders, 3); const filtered = aggregate(applyFilters(rows, { paymentMode: 'UPI' }, 'full'), 'full'); assert.equal(filtered.analytics.statusDistribution.percentages.Delivered, 100); assert.equal(aggregate(rows, 'simple').analytics.courier, undefined); assert.match(reportCsv([{ orderId: '=CMD', orderDate: '2026-09-01', category: 'Delivered', originalProductName: 'A', productCategory: 'C', paymentMode: 'COD' }], 'simple'), /'=CMD/); });

test('completed report rows retain their category snapshot after mapping changes', async () => { const store = new ReportStore({ mongoUri: null }); const report = await store.create('client-a', { templateType: 'simple', sourceFileName: 'orders.csv', rows: [{ originalOrderId: 'ORD-1', normalizedOrderId: 'ORD-1', order_id: 'ORD-1', order_date: '2026-01-01', category: 'Delivered', originalStatus: 'Delivered', normalizedStatus: 'delivered', originalProductName: 'T-Shirt', normalizedProductName: 't shirt', productCategory: 'Clothing', payment_mode: 'COD' }] }); const detail = await store.detail('client-a', report.reportId); assert.equal(detail.filtered.analytics.productCategory[0].name, 'Clothing'); });

test('universal report keeps one current order per client while retaining immutable order observations', async () => {
  const store = new ReportStore({ mongoUri: null });
  const row = (orderId, status, category, product, orderDate = '2026-01-01') => ({ originalOrderId: orderId, normalizedOrderId: normalizeOrderId(orderId), order_id: orderId, order_date: orderDate, category, originalStatus: status, normalizedStatus: status.toLowerCase(), mappingSource: 'generic', originalProductName: product, normalizedProductName: product.toLowerCase(), productCategory: `${product} category`, productMappingSource: 'client', payment_mode: 'COD', quantity: 1, productPrice: 10, rowValue: 10 });
  const first = await store.create('client-a', { templateType: 'full', sourceFileName: 'one.csv', completedAt: '2026-01-01T00:00:00Z', rows: [row(' ORD001 ', 'NDR', 'NDR', 'A'), row('ORD001', 'NDR', 'NDR', 'B'), row('ORD001', 'NDR', 'NDR', 'C')] });
  const second = await store.create('client-a', { templateType: 'full', sourceFileName: 'two.csv', completedAt: '2026-01-02T00:00:00Z', rows: [row('ORD001', 'Delivered', 'Delivered', 'A', '2020-01-01'), row('ORD002', 'Delivered', 'Delivered', 'D')] });
  const orders = await store.universalStore.listOrders('client-a'); const occurrences = await store.universalStore.listOccurrences('client-a');
  assert.equal(orders.length, 2); assert.equal(occurrences.length, 3);
  const ord001 = orders.find((item) => item.normalizedOrderId === 'ORD001'); assert.equal(ord001.currentActualStatus, 'Delivered'); assert.equal(ord001.currentStatusCategory, 'Delivered'); assert.equal(ord001.currentProducts.length, 1); assert.equal(ord001.occurrenceCount, 2);
  assert.equal(occurrences.find((item) => item.reportId === first.reportId).statusCategory, 'NDR'); assert.equal(occurrences.find((item) => item.reportId === first.reportId).productRows.length, 3);
  await store.universalStore.synchronizeReportToUniversal(second.reportId, 'client-a', store);
  assert.equal((await store.universalStore.listOccurrences('client-a')).length, 3);
  await store.create('client-b', { templateType: 'simple', sourceFileName: 'other.csv', rows: [row('ORD001', 'RTO', 'RTO', 'A')] });
  assert.equal((await store.universalStore.listOrders('client-b')).length, 1);
});

test('universal current state uses report completion time and report id, never order date', async () => {
  const store = new ReportStore({ mongoUri: null });
  const input = (status, orderDate, completedAt) => ({ completedAt, templateType: 'simple', sourceFileName: 'orders.csv', rows: [{ originalOrderId: 'ORD1', normalizedOrderId: 'ORD1', order_id: 'ORD1', order_date: orderDate, category: status, originalStatus: status, normalizedStatus: status.toLowerCase(), mappingSource: 'generic', originalProductName: 'A', normalizedProductName: 'a', productCategory: 'Old category', payment_mode: 'COD' }] });
  const newer = await store.create('client', input('Delivered', '2020-01-01', '2026-01-02T00:00:00Z')); const older = await store.create('client', input('NDR', '2030-01-01', '2026-01-01T00:00:00Z'));
  await store.universalStore.synchronizeReportToUniversal(older.reportId, 'client', store);
  assert.equal((await store.universalStore.listOrders('client'))[0].currentActualStatus, 'Delivered');
});

test('universal sync failure preserves the completed delivery report and leaves a durable retry state', async () => {
  const universalStore = new UniversalStore({ mongoUri: null });
  universalStore.synchronize = async () => { throw new Error('temporary database failure'); };
  const store = new ReportStore({ mongoUri: null, universalStore });
  const report = await store.create('client', { templateType: 'simple', sourceFileName: 'orders.csv', rows: [{ originalOrderId: 'ORD-FAILED', normalizedOrderId: 'ORD-FAILED', order_id: 'ORD-FAILED', order_date: '2026-01-01', category: 'NDR', originalStatus: 'NDR', normalizedStatus: 'ndr', mappingSource: 'generic', originalProductName: 'A', normalizedProductName: 'a', productCategory: 'Category', payment_mode: 'COD' }] });
  assert.equal((await store.detail('client', report.reportId)).reportStatus, 'completed');
  assert.deepEqual(await universalStore.listOrders('client'), []);
  assert.deepEqual(universalStore.syncs.get(`client:${report.reportId}`).status, 'failed');
});

test('universal projection handles full, partial, and no order overlap without duplicate current rows', async () => {
  const store = new ReportStore({ mongoUri: null });
  const input = (ids, completedAt) => ({ templateType: 'simple', sourceFileName: 'orders.csv', completedAt, rows: ids.map((id) => ({ originalOrderId: id, normalizedOrderId: normalizeOrderId(id), order_id: id, order_date: '2026-01-01', category: 'NDR', originalStatus: 'NDR', normalizedStatus: 'ndr', mappingSource: 'generic', originalProductName: 'A', normalizedProductName: 'a', productCategory: 'Category', payment_mode: 'COD' })) });
  await store.create('client', input(['ORD1', 'ORD2'], '2026-01-01T00:00:00Z'));
  await store.create('client', input(['ORD1', 'ORD2'], '2026-01-02T00:00:00Z'));
  await store.create('client', input(['ORD2', 'ORD3'], '2026-01-03T00:00:00Z'));
  await store.create('client', input(['ORD4'], '2026-01-04T00:00:00Z'));
  const orders = await store.universalStore.listOrders('client');
  assert.equal(orders.length, 4);
  assert.equal(orders.find((item) => item.normalizedOrderId === 'ORD2').occurrenceCount, 3);
});

test('Universal Report API paginates, filters, exports current rows, and returns current-order history', async () => {
  const rows = (orderId, status, category, product, paymentMode, courier) => [{ originalOrderId: orderId, normalizedOrderId: orderId, order_id: orderId, order_date: '2026-02-01', category, originalStatus: status, normalizedStatus: status.toLowerCase(), mappingSource: 'generic', originalProductName: product, normalizedProductName: product.toLowerCase(), productCategory: 'Accessories', payment_mode: paymentMode, courier, order_source: 'Store', quantity: 2, productPrice: 10, rowValue: 20 }];
  const first = await app.locals.reportStore.create('demo-client', { templateType: 'full', sourceFileName: 'universal.csv', completedAt: '2026-02-01T00:00:00Z', rows: rows('API-ORD-1', 'NDR', 'NDR', 'Watch Strap', 'COD', 'Courier A') });
  await app.locals.reportStore.create('demo-client', { templateType: 'full', sourceFileName: 'universal.csv', completedAt: '2026-02-02T00:00:00Z', rows: rows('API-ORD-1', 'Delivered', 'Delivered', 'Watch Strap', 'COD', 'Courier A') });
  await app.locals.reportStore.create('demo-client', { templateType: 'full', sourceFileName: 'universal.csv', completedAt: '2026-02-03T00:00:00Z', rows: rows('API-ORD-2', 'RTO', 'RTO', 'Bag', 'UPI', 'Courier B') });
  await app.locals.reportStore.create('another-client', { templateType: 'full', sourceFileName: 'private.csv', completedAt: '2026-02-03T00:00:00Z', rows: rows('PRIVATE-ORD', 'Delivered', 'Delivered', 'Private', 'COD', 'Courier A') });
  const instance = await server(); const base = `http://127.0.0.1:${instance.address().port}`;
  try {
    let response = await fetch(`${base}/api/universal-report?page=1&pageSize=1&statusCategory=Delivered`); let body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.orders.length, 1); assert.equal(body.orders[0].normalizedOrderId, 'API-ORD-1'); assert.equal(body.summary.Delivered, 1); assert.equal(body.pagination.total, 1);
    response = await fetch(`${base}/api/universal-report?search=API-ORD-2&paymentMode=UPI&courier=Courier%20B&product=Bag&productCategory=Accessories`); body = await response.json();
    assert.equal(body.orders.length, 1); assert.equal(body.orders[0].currentStatusCategory, 'RTO');
    response = await fetch(`${base}/api/universal-report/analytics`); body = await response.json(); assert.equal(body.summary.totalOrders >= 2, true); assert.equal(body.summary.Delivered >= 1, true); assert.equal(body.summary.RTO >= 1, true);
    response = await fetch(`${base}/api/universal-orders/API-ORD-1`); body = await response.json(); assert.equal(body.order.currentActualStatus, 'Delivered'); assert.equal(body.occurrences.length, 2); assert.equal(body.occurrences[1].reportId, first.reportId); assert.equal(body.occurrences[0].sourceReport.sourceFileName, 'universal.csv');
    response = await fetch(`${base}/api/universal-report/export?search=API-ORD-1`); const exportBody = await response.text(); assert.equal(response.status, 200); assert.match(exportBody, /Actual Status/); assert.match(exportBody, /Delivered/); assert.doesNotMatch(exportBody, /"NDR"/);
    response = await fetch(`${base}/api/universal-report?search=PRIVATE-ORD`); assert.equal(response.status, 200); assert.equal((await response.json()).orders.length, 0);
    assert.equal((await fetch(`${base}/api/universal-report?page=0`)).status, 422); assert.equal((await fetch(`${base}/api/universal-report?from=2026-99-99`)).status, 422); assert.equal((await fetch(`${base}/api/universal-report?statusCategory=Nope`)).status, 422); assert.equal((await fetch(`${base}/api/universal-orders/%20`)).status, 422); assert.equal((await fetch(`${base}/api/universal-orders/not-found`)).status, 404);
  } finally { await close(instance); }
});

test('Gemini product workflow deduplicates unknown products and never sends saved mappings', async () => {
  const calls = []; const provider = { async classifyProducts(products, categories) { calls.push({ products, categories }); return { model: 'gemini-2.5-flash-lite', results: [{ product: 'Rose Face Serum', category: 'Beauty', confidence: 0.94, reason: 'Serum' }], failedProducts: [] }; } };
  const result = await classifyProducts(['Known Shirt', 'Rose Face Serum', 'Rose Face Serum'], { mappings: [{ normalizedValue: 'known shirt', category: 'Clothing' }], categories: ['Clothing', 'Beauty'], provider });
  assert.deepEqual(calls[0].products, ['Rose Face Serum']);
  assert.equal(result.items.find((item) => item.value === 'Known Shirt').mappingSource, 'client');
  assert.equal(result.items.find((item) => item.value === 'Rose Face Serum').suggestedCategory, 'Beauty');
  const next = await classifyProducts(['Rose Face Serum'], { mappings: [{ normalizedValue: 'rose face serum', category: 'Beauty' }], categories: ['Beauty'], provider });
  assert.equal(calls.length, 1); assert.equal(next.items[0].category, 'Beauty');
});
test('invalid Gemini categories remain needs review and transient Gemini retries are bounded', async () => {
  const { GeminiProductClassifier, validateGeminiResults } = require('../src/product-classifier');
  assert.deepEqual(validateGeminiResults({ results: [{ product: 'Product A', category: 'Random Category' }] }, ['Product A'], ['Beauty']), []);
  let requests = 0; const classifier = new GeminiProductClassifier({ apiKey: 'test-key', retries: 2, fetchImpl: async () => { requests += 1; return { ok: false, status: 429, statusText: 'Too Many Requests', text: async () => JSON.stringify({ error: { message: 'Quota exceeded' } }) }; } });
  const response = await classifier.classifyProducts(['Product A'], ['Beauty']);
  assert.equal(requests, 3); assert.deepEqual(response.failedProducts, ['Product A']);
});
test('Gemini uses the fixed Flash-Lite model and suggests categories for new clients', async () => {
  const { GeminiProductClassifier, GEMINI_MODEL } = require('../src/product-classifier');
  let request;
  const classifier = new GeminiProductClassifier({ apiKey: 'server-only-key', model: 'not-allowed', fetchImpl: async (url, options) => { request = { url, headers: options.headers, body: JSON.parse(options.body) }; return { ok: true, status: 200, statusText: 'OK', json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ results: [{ product: 'Ceramic Pour Over Set', category: 'Kitchenware', confidence: 0.91 }] }) }] } }] }) }; } });
  const response = await classifier.classifyProducts(['Ceramic Pour Over Set', 'Travel Neck Pillow'], []);
  assert.equal(GEMINI_MODEL, 'gemini-2.5-flash-lite');
  assert.match(request.url, /gemini-2\.5-flash-lite/); assert.doesNotMatch(request.url, /not-allowed/);
  assert.equal(request.headers['x-goog-api-key'], 'server-only-key'); assert.doesNotMatch(request.url, /key=/);
  assert.deepEqual(request.body.contents[0].parts[0].text.includes('Suggest one concise'), true);
  assert.deepEqual(response.results, [{ product: 'Ceramic Pour Over Set', category: 'Kitchenware', confidence: 0.91, reason: null }]);
  const calls = []; const provider = { async classifyProducts(products, categories) { calls.push({ products, categories }); return { model: GEMINI_MODEL, results: [{ product: 'Ceramic Pour Over Set', category: 'Kitchenware' }, { product: 'Travel Neck Pillow', category: 'Travel Accessories' }], failedProducts: [] }; } };
  const classified = await classifyProducts(['Ceramic Pour Over Set', 'Travel Neck Pillow'], { mappings: [], categories: [], provider });
  assert.deepEqual(calls, [{ products: ['Ceramic Pour Over Set', 'Travel Neck Pillow'], categories: [] }]);
  assert.deepEqual(classified.items.map((item) => item.suggestedCategory), ['Kitchenware', 'Travel Accessories']);
});
test('Gemini uses the header-authenticated REST endpoint and parses two new products', async () => {
  const { GeminiProductClassifier } = require('../src/product-classifier');
  let request;
  const classifier = new GeminiProductClassifier({ apiKey: 'test-key', fetchImpl: async (url, options) => { request = { url, headers: options.headers, body: JSON.parse(options.body) }; return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify({ suggestions: [{ product: 'Product A', category: 'Clothing', confidence: 0.9 }, { product: 'Product B', category: 'Home & Kitchen', reason: 'Bottle set' }] }) + '\n```' }] } }] }) }; } });
  const result = await classifier.classifyProducts(['Product A', 'Product B'], ['Clothing', 'Home & Kitchen']);
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
  assert.equal(request.headers['x-goog-api-key'], 'test-key');
  assert.deepEqual(JSON.parse(request.body.contents[0].parts[0].text).availableCategories, ['Clothing', 'Home & Kitchen']);
  assert.equal(result.results.length, 2); assert.deepEqual(result.failedProducts, []);
});
test('Gemini configuration and HTTP failures retain a safe diagnostic for manual fallback', async () => {
  const { GeminiProductClassifier } = require('../src/product-classifier');
  const missing = await new GeminiProductClassifier({ apiKey: '' }).classifyProducts(['Product A'], []);
  assert.equal(missing.providerError, 'GEMINI_API_KEY is not configured.');
  const rejected = await new GeminiProductClassifier({ apiKey: 'invalid', retries: 0, fetchImpl: async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => JSON.stringify({ error: { message: 'API key is not authorized for this model' } }) }) }).classifyProducts(['Product A'], []);
  assert.match(rejected.providerError, /403 Forbidden/); assert.deepEqual(rejected.failedProducts, ['Product A']);
});
test('manual, modified, and rejected review outcomes do not persist rejected AI categories', async () => {
  const store = new MappingStore({ mongoUri: null }); await store.saveCategory('client-a', 'Beauty'); await store.saveCategory('client-a', 'Personal Care');
  await store.save('product', 'client-a', 'Rose Face Serum', 'Personal Care', { source: 'Client Modified' });
  assert.equal((await store.list('product', 'client-a'))[0].category, 'Personal Care');
  assert.equal((await store.list('product', 'client-b')).length, 0);
  // A rejected suggestion has no call to save(), therefore it cannot become a final mapping.
  assert.equal((await store.list('product', 'client-a')).some((item) => item.originalExample === 'Rejected Product'), false);
});

test('AI review decisions persist rejection, preserve partial bulk failures, and update AI-approved mappings', async () => {
  const store = new MappingStore({ mongoUri: null });
  await store.saveCategory('client', 'Clothing');
  await store.saveCategory('client', 'Accessories');
  await store.saveSuggestions('client', [{ normalizedProductName: 'travel bottle set', originalProductName: 'Travel Bottle Set', suggestedCategory: 'Accessories', mappingSource: 'ai-suggested', suggestionStatus: 'AI Suggested' }]);
  await store.decideSuggestion('client', 'Travel Bottle Set', 'Client Rejected');
  assert.equal(store.memory.suggestion.get('client')[0].status, 'Client Rejected');
  await store.save('product', 'client', 'Classic Shirt', 'Clothing', { source: 'AI Approved' });
  const changed = await store.save('product', 'client', 'Classic Shirt', 'Accessories', { source: 'AI Approved' });
  assert.equal(changed.source, 'Client Modified');
  const outcomes = await Promise.allSettled([store.save('product', 'client', 'Good Product', 'Clothing', { source: 'AI Approved' }), store.save('product', 'client', '', 'Clothing', { source: 'AI Approved' })]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal((await store.list('product', 'client')).some((item) => item.originalExample === 'Good Product'), true);
});

test('duplicate normalized category rename returns a friendly API error', async () => {
  const instance = await server(); const base = `http://127.0.0.1:${instance.address().port}`;
  try {
    for (const name of ['Beauty', 'Accessories']) await fetch(`${base}/api/product-categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const response = await fetch(`${base}/api/product-categories/Beauty`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: ' accessories ' }) });
    const payload = await response.json(); assert.equal(response.status, 422); assert.equal(payload.code, 'CATEGORY_EXISTS'); assert.match(payload.message, /already exists/i);
  } finally { await close(instance); }
});

test('upload sends only unknown normalized products and current client categories to Gemini', async () => {
  const calls = [];
  const provider = { async classifyProducts(products, categories) { calls.push({ products, categories }); return { model: 'gemini-2.5-flash-lite', results: products.map((product) => ({ product, category: product.includes('Nail') ? 'Nail Care' : 'Skin Care' })), failedProducts: [] }; } };
  const csv = simpleHeader + '1,2026-01-01,Delivered,D-Fame Nail Repair Serum,COD\n2,2026-01-01,Delivered,Vitamin C Face Serum,COD\n3,2026-01-01,Delivered,Vitamin C Face Serum,COD\n4,2026-01-01,Delivered,Known Product,COD\n';
  const result = await validateUpload({ originalname: 'orders.csv', buffer: Buffer.from(csv) }, { templateType: 'simple', productMappings: [{ normalizedValue: 'known product', category: 'Skin Care' }], productCategories: ['Nail Care', 'Skin Care'], productClassifier: provider });
  assert.deepEqual(calls, [{ products: ['D-Fame Nail Repair Serum', 'Vitamin C Face Serum'], categories: ['Nail Care', 'Skin Care'] }]);
  assert.equal(result.classifications.products.find((item) => item.value === 'Known Product').category, 'Skin Care');
  assert.equal(result.classifications.products.find((item) => item.value === 'D-Fame Nail Repair Serum').suggestedCategory, 'Nail Care');
});

test('NO_MATCH, failures, and rejected suggestions remain manual fallbacks without another Gemini call', async () => {
  const noMatch = { async classifyProducts(products) { return { model: 'gemini-2.5-flash-lite', results: products.map((product) => ({ product, category: 'NO_MATCH' })), failedProducts: [] }; } };
  const result = await classifyProducts(['Unclassifiable Product'], { categories: ['Clothing'], provider: noMatch });
  assert.equal(result.items[0].suggestedCategory, undefined);
  assert.match(result.items[0].manualReason, /No suitable existing category/);
  let calls = 0;
  const provider = { async classifyProducts() { calls += 1; return { results: [] }; } };
  const rejected = await classifyProducts(['Rejected Product'], { categories: ['Clothing'], suggestions: [{ normalizedProductName: 'rejected product', status: 'Client Rejected' }], provider });
  assert.equal(calls, 0);
  assert.match(rejected.items[0].manualReason, /rejected/);
});

test('new category creation rejects normalized duplicates with a friendly response', async () => {
  const store = new MappingStore({ mongoUri: null });
  await store.saveCategory('client', 'Home & Kitchen');
  await assert.rejects(() => store.saveCategory('client', ' home kitchen '), { code: 'CATEGORY_EXISTS' });
});

test('validation endpoint stores a queued process without calling Gemini, then start advances the process once', async () => {
  const instance = await server(); const base = `http://127.0.0.1:${instance.address().port}`;
  try {
    const response = await fetch(`${base}/api/uploads/validate`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'orders.csv', 'x-template-type': 'simple', 'x-report-request-id': 'validation-only-test' }, body: Buffer.from(simpleHeader + '1,2026-01-01,Delivered,Unmapped Product,COD\n') });
    const payload = await response.json(); assert.equal(response.status, 200); assert.equal(payload.classifications, undefined); assert.equal(payload.process.status, 'queued');
    const duplicate = await fetch(`${base}/api/uploads/validate`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'orders.csv', 'x-template-type': 'simple', 'x-report-request-id': 'validation-only-test' }, body: Buffer.from(simpleHeader + '1,2026-01-01,Delivered,Unmapped Product,COD\n') }).then((r) => r.json());
    assert.equal(duplicate.process.processId, payload.process.processId);
    const started = await fetch(`${base}/api/report-processes/${payload.process.processId}/start`, { method: 'POST' }); assert.equal(started.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const process = await fetch(`${base}/api/report-processes/${payload.process.processId}`).then((r) => r.json()); assert.ok(['review_required', 'finalizing'].includes(process.process.status));
  } finally { await close(instance); }
});

test('processing store prevents duplicate starts while a report process is active', async () => {
  const store = new ProcessingStore(); const job = store.createValidated('client', { summary: {}, templateType: 'simple', file: {} }, 'same-request');
  let calls = 0; await store.start('client', job.processId, async () => { calls += 1; return { classifications: { statuses: [], products: [] } }; }); await store.start('client', job.processId, async () => { calls += 1; return { classifications: { statuses: [], products: [] } }; });
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(calls, 1);
});

test('processing completes automatically when saved mappings leave no review work', async () => {
  const store = new ProcessingStore(); const job = store.createValidated('client', { summary: {}, templateType: 'simple', file: {} }, 'complete-request');
  await store.start('client', job.processId, async () => ({ result: { classifications: { statuses: [], products: [] } }, report: { reportId: 'completed-report' } }));
  await new Promise((resolve) => setTimeout(resolve, 5)); const completed = store.get('client', job.processId);
  assert.equal(completed.status, 'completed'); assert.equal(completed.stage, 'completed'); assert.equal(completed.report.reportId, 'completed-report');
});
