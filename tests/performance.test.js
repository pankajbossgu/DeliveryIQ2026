const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const mongoose = require('mongoose');
const { calculateObjectSize } = mongoose.mongo.BSON;
const { validateUpload, processValidatedUpload, MAX_SOURCE_ROWS, xlsxWorkbook } = require('../src/upload');
const { classifyStatus, createStatusClassifier, normalizeMappingValue } = require('../src/classification');
const { ProcessingStore, ReportStore, ReportPayload, ReportProcess, PAYLOAD_CHUNK_BYTES, PayloadStore } = require('../src/reports');
const { MappingStore } = require('../src/mappings');
const { GeminiProductClassifier } = require('../src/product-classifier');
const limits = require('../public/js/limits');
const fs = require('node:fs');

function fixture(count, unique = 100) {
  const header = 'Order ID,Order Date,Order Status,Product Name,Product Qty,Product Price,Payment Mode,Courier,Source/Website/Store';
  return { originalname: 'scale.csv', buffer: Buffer.from(header + '\n' + Array.from({ length: count }, (_,i) => `ORD-${i},2026-01-01,Delivered,Product ${i % unique},1,349,COD,Courier,Store`).join('\n')) };
}
function inputFor(count, unique) {
  const result = validateUpload(fixture(count, unique), { templateType: 'full', classify: false });
  assert.equal(result.success, true); return result;
}
function finalRows(job) {
  const products = new Map(job.result.classifications.products.map((item) => [item.normalizedProductName, item]));
  const statuses = new Map(job.result.classifications.statuses.map((item) => [item.value, item]));
  return job.input.normalizedRows.map((row) => ({ ...row, category: statuses.get(row.originalStatus).category, normalizedStatus: statuses.get(row.originalStatus).normalizedStatus, masterCategory: products.get(row.normalizedProductName).masterCategory, productCategory: products.get(row.normalizedProductName).productCategory }));
}

test('shared limit accepts 35,000 non-empty rows, rejects 35,001+, and matches browser help', () => {
  assert.equal(MAX_SOURCE_ROWS, 35000); assert.equal(limits.maxSourceRows, MAX_SOURCE_ROWS);
  const file = fixture(35000); file.buffer = Buffer.concat([file.buffer, Buffer.from('\n\n,,,,,,,,\n')]);
  assert.equal(validateUpload(file, { templateType: 'full', classify: false }).summary.sourceRows, 35000);
  for (const count of [35001, 36000]) {
    const rejected = validateUpload(fixture(count), { templateType: 'full', classify: false });
    assert.equal(rejected.code, 'ROW_LIMIT_EXCEEDED'); assert.equal(rejected.details.maxRows, MAX_SOURCE_ROWS);
    assert.equal(rejected.details.actualRows, count); assert.match(rejected.message, /35,000/);
  }
  const html = fs.readFileSync(require.resolve('../public/index.html'), 'utf8');
  assert.ok(html.includes(`Up to ${MAX_SOURCE_ROWS.toLocaleString('en-US')} rows`));
  assert.ok(html.indexOf('/js/limits.js') < html.indexOf('/js/app.js'));
});

test('XLSX enforces the same non-empty row limit', () => {
  // This fixture remains under the byte limit: a single populated cell is enough
  // to count a raw row, before required-column validation runs.
  for (const count of [35000, 35001]) {
    const buffer = xlsxWorkbook([['Order ID'], ...Array.from({ length: count }, (_, i) => [String(i)])]);
    const result = validateUpload({ originalname: 'limit.xlsx', buffer }, { classify: false, templateType: 'simple' });
    assert.equal(result.code, count === 35000 ? 'MISSING_REQUIRED_COLUMNS' : 'ROW_LIMIT_EXCEEDED');
  }
});

test('reused status index is equivalent to existing normalization and precedence', () => {
  const mappings = [{ normalizedValue: 'rto ndr', category: 'Delivered' }, { normalizedValue: 'delivered', category: 'Invalid' }];
  const classifier = createStatusClassifier(mappings);
  const cases = ['ＲＴＯ', 'RTO NDR', 'NDR', ' Delivered ', 'Ready_to_Ship', 'Cancelled', 'Lost', 'Unrecognized', 'RTO/NDR'];
  for (const value of cases) assert.deepEqual(classifier(value), classifyStatus(value, mappings));
  assert.equal(classifier('RTO NDR').category, 'Delivered');
  assert.equal(classifyStatus('RTO NDR').category, 'RTO');
  assert.equal(classifier('Unrecognized').classificationRequired, true);
  // Repeated row application must not revisit the mapping array.
  let reads = 0;
  const counted = [{ get normalizedValue() { reads++; return 'delivered'; }, category: 'Other' }];
  const reuse = createStatusClassifier(counted); for (let i = 0; i < 35000; i++) assert.equal(reuse('Delivered').category, 'Other');
  assert.equal(reads, 1);
});

test('Gemini receives only normalized unique unknown products after mappings and suggestions', async () => {
  const input = inputFor(35000, 4);
  input.normalizedRows[4].originalProductName = '  PRODUCT_3  ';
  input.normalizedRows[4].normalizedProductName = normalizeMappingValue('  PRODUCT_3  ');
  const calls = [];
  const provider = new GeminiProductClassifier({ apiKey: 'synthetic-test-only', fetchImpl: async (_url, options) => {
    const names = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).products; calls.push(names);
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: names.map((product) => ({ product, masterCategory: 'Beauty', productCategory: 'Serum' })) }) };
  } });
  const result = await processValidatedUpload(input, { includeRows: false, masterCategories: ['Beauty'], productCategories: [{ name: 'Serum', masterCategory: 'Beauty' }, { name: 'Prior', masterCategory: 'Beauty' }], productMappings: [{ normalizedValue: 'product 0', masterCategory: 'Beauty', productCategory: 'Saved' }], suggestions: [{ normalizedProductName: 'product 1', status: 'AI Suggested', suggestedMasterCategory: 'Beauty', suggestedProductCategory: 'Prior' }, { normalizedProductName: 'product 2', status: 'Client Rejected' }], productClassifier: provider });
  assert.deepEqual(calls, [['Product 3']]);
  assert.equal(result.classifications.products.length, 4);
  assert.equal(result.classifications.products.find((item) => item.normalizedProductName === 'product 0').productCategory, 'Saved');
  assert.equal(result.classifications.products.find((item) => item.normalizedProductName === 'product 1').suggestedProductCategory, 'Prior');
  assert.equal(result.classifications.products.find((item) => item.normalizedProductName === 'product 2').mappingSource, 'needs-review');
  assert.equal('normalizedRows' in result, false);
});

for (const count of [5, 10000, 25000, 35000]) test(`${count} rows: processing, review, finalization, reports, bounded documents and tenant isolation`, async () => {
  const started = performance.now(); const input = inputFor(count);
  const processes = new ProcessingStore({ mongoUri: null }); const reports = new ReportStore({ mongoUri: null });
  const { job } = await processes.createValidated('scale-client', input, `request-${count}`);
  const classified = await processes.start('scale-client', job.processId, async (current) => processValidatedUpload(current.input, { includeRows: false }));
  assert.equal(classified.status, 'review_required');
  assert.equal(await processes.get('other-client', job.processId), null);
  assert.equal(await processes.updateReviews('other-client', job.processId, 'product', []), null);
  const updates = classified.result.classifications.products.map((item) => ({ value: item.value, classificationRequired: false, masterCategory: 'Beauty', productCategory: 'Serum' }));
  await processes.updateReviews('scale-client', job.processId, 'product', updates);
  const metadata = processes.jobs.get(job.processId);
  assert.equal('normalizedRows' in metadata.input, false);
  assert.equal('normalizedRows' in metadata.result, false);
  assert.equal('products' in metadata.result.classifications, false);
  const restored = await processes.get('scale-client', job.processId);
  assert.equal(restored.input.normalizedRows.length, count);
  assert.ok(restored.result.classifications.products.every((item) => !item.classificationRequired));
  const rows = finalRows(restored);
  const report = await reports.create('scale-client', { templateType: 'full', sourceFileName: 'scale.csv', rows, requestId: `report-${count}` });
  const completed = await processes.complete(restored, report);
  assert.equal(completed.status, 'completed'); assert.equal(report.uniqueOrderCount, count);
  const detail = await reports.detail('scale-client', report.reportId);
  assert.equal(detail.filtered.totalOrders, count); assert.equal(detail.analytics.product.length, Math.min(count,100));
  assert.equal(detail.analytics.revenue, count * 349);
  assert.equal(await reports.detail('other-client', report.reportId), null);
  assert.equal((await reports.list('other-client')).length, 0);
  assert.equal(reports.universalStore.orders.size, count);
  const documents = [...processes.jobs.values(), ...processes.payloads.memory.values(), ...reports.memory.values(), ...reports.payloads.memory.values(), ...reports.rows.values()].flat();
  const maxBson = Math.max(...documents.map((doc) => calculateObjectSize(doc)));
  assert.ok(maxBson < 16 * 1024 * 1024);
  console.log(JSON.stringify({ rows: count, lifecycleMs: Math.round(performance.now() - started), maxDocumentBytes: maxBson, processBytes: calculateObjectSize(processes.jobs.get(job.processId)) }));
});

test('large unique review snapshots and UTF-8 values span chunks without loss', async () => {
  const store = new ProcessingStore({ mongoUri: null }); const { job } = await store.createValidated('tenant', inputFor(1));
  const name = 'Unique 😀 product ' + 'x'.repeat(200);
  job.status = 'review_required'; job.result = { classifications: { statuses: [], products: Array.from({ length: 35000 }, (_,i) => ({ value: `${name}${i}`, originalProductName: `${name}${i}`, normalizedProductName: `product ${i}`, classificationRequired: true })) } };
  assert.ok(calculateObjectSize(job.result) > 16 * 1024 * 1024);
  await store.save(job);
  const snapshot = await store.get('tenant', job.processId, { includeRows: false });
  assert.deepEqual(snapshot.result, job.result);
  assert.ok(snapshot.payloads.products.count > 1);
  for (const doc of store.payloads.memory.values()) assert.ok(calculateObjectSize(doc) < PAYLOAD_CHUNK_BYTES + 1024);
  await assert.rejects(store.payloads.read('another-tenant', job.processId, snapshot.payloads.products), /Incomplete/);
});

test('snapshot publication handles conflicting reviews and failed chunk writes', async () => {
  const store = new ProcessingStore({ mongoUri: null }); const { job } = await store.createValidated('a', inputFor(1));
  job.status = 'review_required'; job.result = { classifications: { statuses: [], products: [{ value: 'A', classificationRequired: true }, { value: 'B', classificationRequired: true }] } }; await store.save(job);
  const results = await Promise.all(['A', 'B'].map((value) => store.updateReview('a', job.processId, 'product', value, { classificationRequired: false })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.get('a', job.processId)).result.classifications.products.filter((item) => !item.classificationRequired).length, 1);
  const previous = (await store.get('a', job.processId)).payloads.products.generation;
  store.payloads.write = async () => { throw new Error('simulated chunk failure'); };
  await assert.rejects(store.updateReview('a', job.processId, 'product', 'A', {}), /simulated/);
  assert.equal((await store.get('a', job.processId)).payloads.products.generation, previous);
});

test('lost publication acknowledgements do not delete a committed review snapshot', async () => {
  const store = new ProcessingStore({ mongoUri: null }); const { job } = await store.createValidated('ack', inputFor(1));
  job.status = 'review_required'; job.result = { classifications: { statuses: [], products: [{ value: 'Product 0', classificationRequired: true }] } }; await store.save(job);
  const publish = store.publish.bind(store);
  store.publish = async (...args) => { await publish(...args); throw new Error('lost acknowledgement'); };
  await assert.rejects(store.updateReview('ack', job.processId, 'product', 'Product 0', { classificationRequired: false }), /lost acknowledgement/);
  const restored = await store.get('ack', job.processId);
  assert.equal(restored.result.classifications.products[0].classificationRequired, false);
  restored.result.classifications.products[0].productCategory = 'Serum';
  await assert.rejects(store.save(restored), /lost acknowledgement/);
  assert.equal((await store.get('ack', job.processId)).result.classifications.products[0].productCategory, 'Serum');
});

test('memory cancellation wins a stage race while preserving the latest record', async () => {
  const store = new ProcessingStore({ mongoUri: null }); const { job } = await store.createValidated('cancel', inputFor(1));
  const get = store.get.bind(store);
  store.get = async (...args) => {
    const stale = await get(...args);
    const latest = store.jobs.get(job.processId);
    store.jobs.set(job.processId, { ...latest, revision: 'newer-revision', status: 'processing', stage: 'classifying', error: 'latest metadata' });
    return stale;
  };
  const cancelled = await store.cancel('cancel', job.processId);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.error, 'latest metadata');
  assert.notEqual(cancelled.revision, 'newer-revision'); assert.deepEqual(cancelled.payloads, job.payloads);
  store.get = get;
  assert.equal(await store.cancel('other', job.processId), null);
  assert.equal(await store.cancel('cancel', job.processId), null);
});

test('concurrent starts classify a process only once', async () => {
  const store = new ProcessingStore({ mongoUri: null }); const { job } = await store.createValidated('start', inputFor(1));
  let calls = 0;
  const execute = async (current) => { calls++; return processValidatedUpload(current.input, { includeRows: false }); };
  await Promise.all([store.start('start', job.processId, execute), store.start('start', job.processId, execute)]);
  assert.equal(calls, 1);
  assert.equal((await store.get('start', job.processId)).status, 'review_required');
});

test('failed report persistence cleans only unreferenced analytics', async () => {
  for (const committed of [false, true]) {
    const reports = new ReportStore({ mongoUri: null }); const set = reports.memory.set.bind(reports.memory);
    reports.memory.set = (key, value) => { if (committed) set(key, value); throw new Error('simulated persistence failure'); };
    await assert.rejects(reports.create('cleanup', { templateType: 'full', sourceFileName: 'small.csv', rows: inputFor(1).normalizedRows }), /simulated persistence failure/);
    if (!committed) assert.equal(reports.payloads.memory.size, 0);
    else {
      const [saved] = reports.memory.values();
      assert.ok(await reports.payloads.read('cleanup', saved.reportId, saved.analyticsRef));
    }
  }
});

test('retry generations are scoped to exact content, owner and tenant', async () => {
  const store = new PayloadStore(async () => null); const value = ['😀'.repeat(600000)];
  const first = await store.write('a', 'order', value, { reuse: true });
  const again = await store.write('a', 'order', value, { reuse: true });
  assert.deepEqual(again, first); assert.equal(store.memory.size, first.count);
  const changed = await store.write('a', 'order', ['changed'], { reuse: true });
  const anotherTenant = await store.write('b', 'order', value, { reuse: true });
  const anotherOwner = await store.write('a', 'another-order', value, { reuse: true });
  assert.notEqual(changed.generation, first.generation); assert.notEqual(anotherTenant.generation, first.generation); assert.notEqual(anotherOwner.generation, first.generation);
  assert.deepEqual(await store.read('a', 'order', first), value);
  assert.deepEqual(await store.read('a', 'order', changed), ['changed']);
});

test('legacy inline processes remain readable and migrate on save', async () => {
  const store = new ProcessingStore({ mongoUri: null });
  const job = { clientId: 'legacy', processId: 'old', input: inputFor(2), result: { classifications: { statuses: [], products: [{ value: 'Product 0', classificationRequired: true }] } }, status: 'review_required', updatedAt: new Date() };
  store.jobs.set(job.processId, job);
  const read = await store.get('legacy', 'old'); assert.equal(read.input.normalizedRows.length, 2);
  await store.save(read); assert.equal(store.jobs.get('old').input.normalizedRows, undefined);
  assert.equal((await store.get('legacy', 'old')).input.normalizedRows.length, 2);
});

test('classification reads only relevant tenant mappings and preserves prior suggestions', async () => {
  const store = new MappingStore({ mongoUri: null });
  await store.save('status', 'a', 'Delivered', 'Other'); await store.save('status', 'b', 'Delivered', 'RTO');
  await store.saveSuggestions('a', [{ normalizedProductName: 'product 0', originalProductName: 'Product 0', mappingSource: 'ai-suggested', suggestedProductCategory: 'Serum', suggestedMasterCategory: 'Beauty', suggestionStatus: 'AI Suggested' }]);
  await store.decideSuggestion('a', 'Product 0', 'Client Rejected');
  await store.saveSuggestions('a', [{ normalizedProductName: 'product 0', originalProductName: 'Product 0', mappingSource: 'needs-review' }]);
  const context = await store.classificationContext('a', inputFor(1).normalizedRows);
  assert.equal(context.statusMappings[0].category, 'Other'); assert.equal(context.suggestions[0].status, 'Client Rejected');
  assert.equal((await store.classificationContext('b', inputFor(1).normalizedRows)).suggestions.length, 0);
});

test('HTTP upload, bulk review and finalize accept 35,000 rows and reject 35,001', { timeout: 60000 }, async () => {
  process.env.ADMIN_USERNAME = 'scale-test'; process.env.ADMIN_PASSWORD = 'scale-test-password'; process.env.SESSION_SECRET = 'synthetic-local-test-secret';
  const app = require('../src/app');
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = async (url, body, method = 'POST') => { const response = await fetch(base + url, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { response, payload: await response.json() }; };
    const upload = async (count) => { const file = fixture(count); const response = await fetch(`${base}/api/uploads/validate`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': file.originalname, 'x-template-type': 'full' }, body: file.buffer }); return { response, payload: await response.json() }; };
    const rejected = await upload(35001); assert.equal(rejected.response.status, 422); assert.equal(rejected.payload.code, 'ROW_LIMIT_EXCEEDED');
    const accepted = await upload(35000); assert.equal(accepted.response.status, 200);
    const processId = accepted.payload.process.processId;
    assert.equal((await api(`/api/report-processes/${processId}/start`)).response.status, 202);
    let job;
    const deadline = Date.now() + 45000;
    do { job = (await api(`/api/report-processes/${processId}`, null, 'GET')).payload.process; if (!['queued', 'processing'].includes(job.status)) break; await new Promise((resolve) => setTimeout(resolve, 25)); } while (Date.now() < deadline);
    assert.equal(job.status, 'review_required');
    const master = await api('/api/master-categories', { name: 'Beauty' }); assert.equal(master.response.status, 201);
    assert.equal((await api('/api/product-categories', { name: 'Serum', masterCategory: master.payload.category._id })).response.status, 201);
    const reviewed = await api(`/api/report-processes/${processId}/review/product/bulk`, { values: job.classifications.products.map((item) => item.value), masterCategory: 'Beauty', productCategory: 'Serum', action: 'manual' });
    assert.equal(reviewed.response.status, 200); assert.equal(reviewed.payload.updated, 100);
    const finalized = await api(`/api/report-processes/${processId}/finalize`); assert.equal(finalized.response.status, 201);
    assert.equal(finalized.payload.process.status, 'completed'); assert.equal(finalized.payload.report.uniqueOrderCount, 35000);
    const detail = await api(`/api/reports/${finalized.payload.report.reportId}`, null, 'GET');
    assert.equal(detail.payload.report.filtered.analytics.statusDistribution.totalOrders, 35000);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

// Opt in to an isolated, disposable MongoDB. This suite never uses MONGODB_URI.
test('MongoDB scale lifecycle and physical BSON sizes', { skip: !process.env.DELIVERYIQ_TEST_MONGO_URI, timeout: 240000 }, async () => {
  const uri = process.env.DELIVERYIQ_TEST_MONGO_URI;
  const databaseName = `deliveryiq_scale_${Date.now()}`;
  await mongoose.connect(uri, { dbName: databaseName });
  try {
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    const processes = new ProcessingStore({ mongoUri: uri }); const reports = new ReportStore({ mongoUri: uri });
    processes.connection = Promise.resolve(mongoose); reports.connection = Promise.resolve(mongoose); reports.universalStore.connection = Promise.resolve(mongoose);
    for (const count of [5, 10000, 25000, 35000]) {
      const clientId = `tenant-${count}`; const { job } = await processes.createValidated(clientId, inputFor(count), `request-${count}`);
      await processes.start(clientId, job.processId, async (current) => processValidatedUpload(current.input, { includeRows: false }));
      const review = await processes.get(clientId, job.processId, { includeRows: false });
      assert.equal(review.status, 'review_required');
      await processes.updateReviews(clientId, job.processId, 'product', review.result.classifications.products.map((item) => ({ value: item.value, classificationRequired: false, masterCategory: 'Beauty', productCategory: 'Serum' })));
      const restored = await processes.get(clientId, job.processId);
      const report = await reports.create(clientId, { templateType: 'full', sourceFileName: 'scale.csv', rows: finalRows(restored), requestId: `report-${count}` });
      assert.equal((await processes.complete(restored, report)).status, 'completed');
      assert.equal((await reports.detail(clientId, report.reportId)).filtered.totalOrders, count);
      assert.equal(await processes.get('other-tenant', job.processId), null);
      assert.equal(await reports.detail('other-tenant', report.reportId), null);
      assert.equal(await mongoose.models.UniversalOrder.countDocuments({ clientId }), count);
      assert.equal((await mongoose.models.UniversalSync.findOne({ clientId, reportId: report.reportId }).lean()).status, 'completed');
    }
    // A valid file can put every product line on the same order. The Universal
    // projection and occurrence must also stay below BSON's document limit.
    const concentrated = inputFor(35000, 35000);
    for (const row of concentrated.normalizedRows) {
      row.normalizedOrderId = 'ONE'; row.originalOrderId = 'ONE';
      row.originalProductName += 'x'.repeat(200); row.normalizedProductName += 'x'.repeat(200);
      row.category = 'Delivered'; row.masterCategory = 'Beauty'; row.productCategory = 'Serum';
    }
    const bigReport = await reports.create('concentrated', { templateType: 'full', sourceFileName: 'large-products.csv', rows: concentrated.normalizedRows, requestId: 'concentrated' });
    const detail = await reports.universalStore.orderDetail('concentrated', 'ONE');
    assert.equal(detail.products.length, 35000); assert.ok(detail.productsRef);
    assert.equal((await reports.universalStore.orderHistory('concentrated', 'ONE', { page: 1, limit: 25 })).occurrences[0].products.length, 35000);
    assert.equal((await reports.universalStore.analytics('concentrated')).summary.totalOrders, 1);
    assert.equal((await reports.universalStore.groupedReport('concentrated', { analyzeBy: 'product_category' })).rows[0].totalOrderValue, 35000 * 349);
    const exported = await reports.universalStore.exportCurrentOrders('concentrated', {});
    for await (const order of exported.orders) assert.equal(order.products.length, 35000);
    assert.equal(await reports.universalStore.orderDetail('other', 'ONE'), null);
    // A later small projection must clear the reference to the older large one.
    await reports.create('concentrated', { templateType: 'full', sourceFileName: 'small.csv', rows: [concentrated.normalizedRows[0]], requestId: 'small-newer' });
    const latest = await reports.universalStore.orderDetail('concentrated', 'ONE');
    assert.equal(latest.products.length, 1); assert.equal(latest.productsRef, undefined);
    assert.equal((await reports.detail('concentrated', bigReport.reportId)).analytics.product.length, 35000);

    // Mixed storage keeps database summary/trend calculations and merges products
    // before ranking, including a product outside the inline top ten.
    const mixed = Array.from({ length: 12 }, (_, i) => ({
      clientId: 'mixed-analytics', canonicalOrderId: `order-${i}`, latestReportId: 'mixed', latestReportCompletedAt: new Date('2026-01-01'),
      orderDate: '2026-01-01', statusCategory: 'Delivered', originalStatus: 'Delivered', totalQuantity: 20 - i, totalValue: 20 - i,
      products: [{ originalProductName: `Product ${i}`, quantity: 20 - i, rowValue: 20 - i }]
    }));
    mixed.push({ ...mixed[0], canonicalOrderId: 'external', statusCategory: 'RTO', originalStatus: 'RTO', orderDate: '2026-01-02', totalQuantity: 40, totalValue: 40,
      products: [{ originalProductName: 'Product 11', quantity: 20, rowValue: 20 }, { originalProductName: 'Product 11', quantity: 20, rowValue: 20 }] });
    const memoryUniversal = new ReportStore({ mongoUri: '' }).universalStore;
    for (const order of mixed) memoryUniversal.orders.set(memoryUniversal.key(order.clientId, order.canonicalOrderId), order);
    const productsRef = { ...await reports.universalStore.payloads.write('mixed-analytics', 'mixed-external', mixed[12].products), ownerId: 'mixed-external' };
    await mongoose.models.UniversalOrder.insertMany([...mixed.slice(0, 12), { ...mixed[12], products: [], productsRef }]);
    const find = mongoose.models.UniversalOrder.find;
    try {
      mongoose.models.UniversalOrder.find = function (filter, ...args) {
        assert.equal(filter.clientId, 'mixed-analytics');
        assert.deepEqual(filter['productsRef.generation'], { $exists: true });
        return find.call(this, filter, ...args);
      };
      const actual = await reports.universalStore.analytics('mixed-analytics');
      assert.deepEqual(actual, await memoryUniversal.analytics('mixed-analytics'));
      assert.equal(actual.products[0].name, 'Product 11'); assert.equal(actual.products[0].orderCount, 2);
      assert.deepEqual(await reports.universalStore.analytics('mixed-analytics', { toDate: '2026-01-01' }), await memoryUniversal.analytics('mixed-analytics', { toDate: '2026-01-01' }));
    } finally { mongoose.models.UniversalOrder.find = find; }

    const mappings = new MappingStore({ mongoUri: uri }); mappings.connection = Promise.resolve(mongoose);
    const master = await mappings.saveMaster('maps', 'Beauty'); await mappings.saveCategory('maps', 'Serum', master._id);
    await mappings.saveProductMappings('maps', ['Widget', 'Gadget'], { masterCategory: master._id, productCategory: 'Serum', source: 'AI Approved' });
    assert.equal((await mappings.list('product', 'maps')).length, 2);
    assert.equal((await mappings.list('product', 'other')).length, 0);
    const suggestions = Array.from({ length: 1100 }, (_, i) => ({ normalizedProductName: `product ${i}`, originalProductName: `Product ${i}`, mappingSource: 'ai-suggested', suggestionStatus: 'AI Suggested', suggestedMasterCategory: 'Beauty', suggestedProductCategory: 'Serum' }));
    await mappings.saveSuggestions('maps', suggestions);
    await mappings.decideSuggestions('maps', ['Product 0', 'Product 1'], 'Client Rejected');
    await mappings.saveSuggestions('maps', suggestions);
    assert.equal((await mappings.listSuggestions('maps')).length, 1100);
    assert.equal((await mappings.listSuggestions('maps', ['product 0']))[0].status, 'Client Rejected');
    assert.equal((await mappings.listSuggestions('other')).length, 0);

    const ReportModel = mongoose.models.Report; const create = ReportModel.create;
    try {
      ReportModel.create = async () => { throw Object.assign(new Error('definite rejection'), { code: 11000 }); };
      await assert.rejects(reports.create('cleanup-before', { templateType: 'full', sourceFileName: 'small.csv', rows: inputFor(1).normalizedRows }), /definite rejection/);
      assert.equal(await ReportPayload.countDocuments({ clientId: 'cleanup-before' }), 0);
      ReportModel.create = async function (...args) { await create.apply(this, args); throw new Error('lost acknowledgement'); };
      await assert.rejects(reports.create('cleanup-after', { templateType: 'full', sourceFileName: 'small.csv', rows: inputFor(1).normalizedRows }), /lost acknowledgement/);
      const committed = await ReportModel.findOne({ clientId: 'cleanup-after' }).lean();
      assert.ok(await reports.payloads.read('cleanup-after', committed.reportId, committed.analyticsRef));
    } finally { ReportModel.create = create; }

    const payloads = new PayloadStore(async () => mongoose); const value = ['😀'.repeat(600000)];
    const update = ReportPayload.updateOne; let partialGeneration;
    try {
      ReportPayload.updateOne = function (filter, ...args) {
        partialGeneration = filter.generation;
        if (filter.index === 1) throw new Error('interrupted chunk write');
        return update.call(this, filter, ...args);
      };
      await assert.rejects(payloads.write('retry', 'large-order', value, { reuse: true }), /interrupted chunk write/);
    } finally { ReportPayload.updateOne = update; }
    const [retry, concurrent] = await Promise.all([payloads.write('retry', 'large-order', value, { reuse: true }), payloads.write('retry', 'large-order', value, { reuse: true })]);
    assert.equal(retry.generation, partialGeneration); assert.deepEqual(retry, concurrent);
    assert.equal(await ReportPayload.countDocuments({ clientId: 'retry', ownerId: 'large-order' }), retry.count);
    assert.deepEqual(await payloads.read('retry', 'large-order', retry), value);
    const replacement = await payloads.write('retry', 'large-order', ['new contents'], { reuse: true });
    assert.notEqual(replacement.generation, retry.generation);
    assert.deepEqual(await payloads.read('retry', 'large-order', retry), value);

    const sizes = {};
    for (const collection of await mongoose.connection.db.listCollections().toArray()) {
      const [size] = await mongoose.connection.db.collection(collection.name).aggregate([{ $group: { _id: null, max: { $max: { $bsonSize: '$$ROOT' } } } }]).toArray();
      sizes[collection.name] = size?.max || 0; assert.ok(sizes[collection.name] < 16 * 1024 * 1024, collection.name);
    }
    console.log(JSON.stringify({ mongoMaxDocumentBytes: sizes }));
    assert.ok(sizes.reportPayloads <= PAYLOAD_CHUNK_BYTES + 1024);
    const record = await ReportProcess.findOne().lean(); assert.equal(record.input.normalizedRows, undefined); assert.equal(record.result.normalizedRows, undefined);
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});
