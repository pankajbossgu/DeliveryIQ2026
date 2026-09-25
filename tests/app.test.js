const test = require('node:test');
const assert = require('node:assert/strict');
const { MappingStore } = require('../src/mappings');
const { classifyProducts } = require('../src/product');
const { GeminiProductClassifier, validateGeminiResults, GEMINI_MODEL } = require('../src/product-classifier');
const { validateUpload, processValidatedUpload } = require('../src/upload');
const { aggregate, applyFilters, csv } = require('../src/reports');
const { classifyStatus } = require('../src/classification');

async function taxonomy(store, client = 'a') { const master = await store.saveMaster(client, 'Beauty & Personal Care'); const product = await store.saveCategory(client, 'Nail Serum', master._id); return { master, product }; }
test('product categories require tenant master categories and remain tenant isolated', async () => { const store = new MappingStore({ mongoUri: null }); await assert.rejects(store.saveCategory('a', 'Nail Serum', null, { requireMaster: true }), { code: 'MASTER_CATEGORY_REQUIRED' }); const { master } = await taxonomy(store); assert.equal((await store.listCategories('a'))[0].masterCategory, master.name); assert.equal((await store.listMasters('b')).length, 0); });
test('known two-level and legacy flat mappings bypass Gemini', async () => { let calls = 0; const provider = { classifyProducts() { calls += 1; } }; const known = await classifyProducts(['S-Famw Nail Serum 349'], { mappings: [{ normalizedValue: 's famw nail serum 349', masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum' }], provider }); assert.equal(calls, 0); assert.equal(known.items[0].productCategory, 'Nail Serum'); const legacy = classifyProducts(['Old Product'], { mappings: [{ normalizedValue: 'old product', category: 'Legacy Category' }], provider }); assert.equal(calls, 0); assert.equal(legacy.items[0].masterCategory, null); });
test('unknown products send complete taxonomy and accept specific new categories', async () => { let context; const provider = { classifyProducts(products, value) { context = value; return { model: GEMINI_MODEL, results: [{ product: products[0], masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum', confidence: .95 }] }; } }; const result = await classifyProducts(['S-Famw Nail Serum 349'], { masterCategories: [{ name: 'Beauty & Personal Care' }], productCategories: [{ name: 'Face Serum', masterCategory: 'Beauty & Personal Care' }], provider }); assert.deepEqual(context, { masterCategories: ['Beauty & Personal Care'], productCategories: [{ name: 'Face Serum', masterCategory: 'Beauty & Personal Care' }] }); assert.equal(result.items[0].suggestedProductCategory, 'Nail Serum'); });
test('Gemini validation requires safe master and specific product category response', () => { const out = validateGeminiResults({ results: [{ product: 'S-Famw Nail Serum 349', masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum' }, { product: 'Bad', masterCategory: '<bad>', productCategory: 'X' }] }, ['S-Famw Nail Serum 349', 'Bad'], { masterCategories: ['Beauty & Personal Care'], productCategories: [] }); assert.equal(out.length, 1); assert.equal(out[0].productCategory, 'Nail Serum'); });
test('approval saves taxonomy/mapping and next upload has zero Gemini calls', async () => { const store = new MappingStore({ mongoUri: null }); const { master } = await taxonomy(store); await store.saveProductMapping('a', 'S-Famw Nail Serum 349', { masterCategory: master._id, productCategory: 'Nail Serum', source: 'AI Approved' }); let calls = 0; const classified = await classifyProducts(['S-Famw Nail Serum 349'], { mappings: await store.list('product', 'a'), provider: { classifyProducts() { calls += 1; } } }); assert.equal(calls, 0); assert.equal(classified.items[0].masterCategory, 'Beauty & Personal Care'); });
test('manual fallback requires both categories and preserves status engine', async () => { const store = new MappingStore({ mongoUri: null }); await assert.rejects(store.saveProductMapping('a', 'Thing', { productCategory: 'Thing' }), { code: 'INVALID_CATEGORY' }); assert.equal(classifyStatus('Ready to Ship').category, 'In Transit'); assert.equal(classifyStatus('RTO NDR').category, 'RTO'); });
test('reports snapshot, filter, and export both taxonomy levels', () => { const rows = [{ normalizedOrderId: '1', category: 'Delivered', originalProductName: 'S-Famw Nail Serum 349', masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum', quantity: 1, rowValue: 349 }]; const report = aggregate(rows, 'full'); assert.equal(report.analytics.masterCategory[0].name, 'Beauty & Personal Care'); assert.equal(applyFilters(rows, { masterCategory: 'Beauty & Personal Care' }, 'full').length, 1); assert.match(csv(rows, 'full'), /Master Category/); });
test('upload validation never calls Gemini before processing and processing calls it for unknown products', async () => { let calls = 0; const file = { originalname: 'orders.csv', buffer: Buffer.from('Order ID,Order Date,Status,Product Name,Order Quantity,Product Price,Payment Mode,Courier,Order Source\n1,2026-01-01,Delivered,S-Famw Nail Serum 349,1,10,COD,C,Store\n') }; const validated = validateUpload(file, { classify: false }); assert.equal(validated.success, true); const result = await processValidatedUpload(validated, { productClassifier: { classifyProducts(products) { calls += 1; return { results: [{ product: products[0], masterCategory: 'Beauty & Personal Care', productCategory: 'Nail Serum' }] }; } } }); assert.equal(calls, 1); assert.equal(result.classifications.products[0].mappingSource, 'ai-suggested'); });
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
