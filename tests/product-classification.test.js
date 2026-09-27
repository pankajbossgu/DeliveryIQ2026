const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyProducts, normalizeProductName, buildTaxonomy } = require('../src/product');
const { GeminiProductClassifier, validateGeminiResults } = require('../src/product-classifier');
const { MappingStore } = require('../src/mappings');
const { ProcessingStore } = require('../src/reports');
const { validateUpload, processValidatedUpload } = require('../src/upload');
const taxonomy = { masterCategories: ['Beauty', 'Home'], productCategories: [{ name: 'Serum', masterCategory: 'Beauty' }, { name: 'Towel', masterCategory: 'Home' }] };
const answer = (product, extra = {}) => ({ product, masterCategory: 'Beauty', productCategory: 'Serum', confidence: .9, ...extra });
const response = (results) => ({ ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ results }) }] } }] }) });
const csvInput = (names) => validateUpload({ originalname: 'synthetic.csv', buffer: Buffer.from('Order ID,Order Date,Order Status,Product Name,Payment Mode\n' + names.map((name, i) => `${i},2026-01-01,Delivered,${name},COD`).join('\n')) }, { classify: false, templateType: 'simple' });

test('request uses tenant taxonomy and permits new category names in the structured response', async () => {
  let captured;
  const provider = new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async (_url, options) => { captured = JSON.parse(options.body); return response([answer('Brand Serum')]); } });
  const result = await processValidatedUpload(csvInput(['Brand Serum', 'Brand Serum']), { masterCategories: [{ name: 'Beauty', clientId: 'tenant-a', active: true }, { name: 'Secret', active: false }], productCategories: [{ name: 'Serum', masterCategory: 'Beauty', clientId: 'tenant-a', _id: 'private-id', updatedBy: 'private-user' }, { name: 'Hidden', masterCategory: 'Secret' }, { name: 'Inactive', masterCategory: 'Beauty', active: false }], productClassifier: provider });
  const content = JSON.parse(captured.contents[0].parts[0].text);
  assert.deepEqual(content.products, ['Brand Serum']);
  assert.deepEqual(content.existingMasterCategories, ['Beauty']);
  assert.deepEqual(content.existingProductCategories, [{ name: 'Serum', masterCategory: 'Beauty' }]);
  assert.deepEqual(Object.keys(content).sort(), ['existingMasterCategories', 'existingProductCategories', 'instruction', 'products']);
  assert.doesNotMatch(JSON.stringify(captured), /tenant-a|private-id|private-user|COD|2026-01-01|synthetic.csv/);
  assert.match(content.instruction, /New categories are allowed/);
  const fields = captured.generationConfig.responseSchema.properties.results.items.properties;
  assert.equal(fields.masterCategory.enum, undefined);
  assert.equal(fields.productCategory.enum, undefined);
  assert.equal(result.classifications.products[0].suggestionStatus, 'AI Suggested');
  assert.equal(result.classifications.products[0].classificationRequired, true);
});

test('only pending normalized unknowns reach the provider; valid prior suggestions and mappings bypass it', async () => {
  const calls = [];
  const result = await classifyProducts(['Known', 'Prior', 'NEW_name', ' new-name ', 'Rejected'], { ...taxonomy, mappings: [{ normalizedValue: 'known', productCategory: 'Serum' }], suggestions: [{ normalizedProductName: 'prior', status: 'AI Suggested', suggestedMasterCategory: 'Beauty', suggestedProductCategory: 'Serum' }, { normalizedProductName: 'rejected', status: 'Client Rejected' }], provider: { classifyProducts(names) { calls.push(names); return { results: names.map((x) => answer(x)) }; } } });
  assert.deepEqual(calls, [['Known', 'NEW_name']]);
  assert.equal(result.items.find((x) => x.normalizedProductName === 'new name').count, 2);
  assert.equal(result.items.find((x) => x.value === 'Rejected').suggestionStatus, 'Client Rejected');
});

test('server accepts usable new categories but rejects malformed and partial classifications', () => {
  const parsed = validateGeminiResults({ results: [answer('good'), answer('good'), answer('invented', { productCategory: 'New type' }), answer('wrong-parent', { masterCategory: 'Home' }), answer('none', { masterCategory: 'NO_MATCH', productCategory: 'NO_MATCH' }), answer('partial', { masterCategory: 'NO_MATCH', productCategory: 'Serum' })] }, ['good', 'invented', 'wrong-parent', 'none', 'partial'], taxonomy);
  assert.deepEqual(parsed.map((x) => x.product), ['good', 'invented', 'wrong-parent', 'none']);
  assert.equal(parsed[1].productCategory, 'New type');
  assert.equal(parsed[3].productCategory, 'NO_MATCH');
});

test('Gemini receives specific product-type rules and retains specific review suggestions for every returned product', async () => {
  const cases = [
    ['Anti Dandruff Shampoo', 'Beauty', 'Shampoo'],
    ['Hair Serum', 'Beauty', 'Hair Serum'],
    ['Bluetooth Speaker', 'Electronics', 'Bluetooth Speakers'],
    ['Neckband Earphones', 'Electronics', 'Neckband Earphones'],
    ['Water Bottle', 'Home & Kitchen', 'Water Bottles'],
    ['Coffee Mug', 'Home & Kitchen', 'Coffee Mugs'],
    ['Non Stick Pan', 'Home & Kitchen', 'Non-Stick Pans'],
    ['Face Wash', 'Beauty', 'Face Wash'],
    ['Lip Balm', 'Beauty', 'Lip Balms'],
    ['Desk Lamp', 'Home & Kitchen', 'Desk Lamps'],
    ['Phone Stand', 'Electronics', 'Phone Stands']
  ];
  let request;
  const provider = new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return response(cases.map(([product, masterCategory, productCategory]) => ({ product, masterCategory, productCategory })));
  } });
  const existing = { masterCategories: ['Beauty', 'Electronics', 'Home & Kitchen'], productCategories: [{ name: 'Hair Care', masterCategory: 'Beauty' }, { name: 'Audio', masterCategory: 'Electronics' }, { name: 'Drinkware', masterCategory: 'Home & Kitchen' }, { name: 'Cookware', masterCategory: 'Home & Kitchen' }, { name: 'Face Wash', masterCategory: 'Beauty' }] };
  const result = await classifyProducts(cases.map(([product]) => product), { ...existing, provider });
  const content = JSON.parse(request.contents[0].parts[0].text);
  assert.match(content.instruction, /actual reusable product type/);
  assert.match(content.instruction, /Water Bottle.*Water Bottles/);
  assert.equal(result.items.length, cases.length);
  assert.deepEqual(result.items.map((item) => [item.value, item.suggestedMasterCategory, item.suggestedProductCategory]), cases);
  assert.ok(result.items.every((item) => item.suggestionStatus === 'AI Suggested' && item.classificationRequired));
});

test('specific existing category is reused, new pairs remain review-only, and ambiguous products remain No Match', async () => {
  const existing = { masterCategories: ['Beauty'], productCategories: [{ name: 'Shampoos', masterCategory: 'Beauty' }] };
  const result = await classifyProducts(['Anti Dandruff Shampoo', 'Mystery Bundle'], { ...existing, provider: { classifyProducts(products) { return { results: [{ product: products[0], masterCategory: 'Beauty', productCategory: 'Shampoos' }, { product: products[1], masterCategory: 'NO_MATCH', productCategory: 'NO_MATCH' }] }; } } });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0].suggestedProductCategory, 'Shampoos');
  assert.equal(result.items[1].suggestionStatus, 'No Match');
  const noTaxonomy = await classifyProducts(['Bluetooth Speaker'], { provider: { classifyProducts(products) { return { results: [{ product: products[0], masterCategory: 'Electronics', productCategory: 'Bluetooth Speakers' }] }; } } });
  assert.deepEqual([noTaxonomy.items[0].suggestedMasterCategory, noTaxonomy.items[0].suggestedProductCategory, noTaxonomy.items[0].classificationRequired], ['Electronics', 'Bluetooth Speakers', true]);
});

test('backend converts obvious department-level categories into visible No Match results without dropping products', () => {
  const parsed = validateGeminiResults({ results: [
    { product: 'Anti Dandruff Shampoo', masterCategory: 'Beauty', productCategory: 'Hair Care' },
    { product: 'Bluetooth Speaker', masterCategory: 'Electronics', productCategory: 'Audio' },
    { product: 'Water Bottle', masterCategory: 'Home & Kitchen', productCategory: 'Drinkware' },
    { product: 'Non Stick Pan', masterCategory: 'Home & Kitchen', productCategory: 'Cookware' },
    { product: 'Face Wash', masterCategory: 'Beauty', productCategory: 'Face Wash' }
  ] }, ['Anti Dandruff Shampoo', 'Bluetooth Speaker', 'Water Bottle', 'Non Stick Pan', 'Face Wash']);
  assert.deepEqual(parsed.map((item) => item.product), ['Anti Dandruff Shampoo', 'Bluetooth Speaker', 'Water Bottle', 'Non Stick Pan', 'Face Wash']);
  assert.deepEqual(parsed.slice(0, 4).map((item) => item.productCategory), ['NO_MATCH', 'NO_MATCH', 'NO_MATCH', 'NO_MATCH']);
  assert.equal(parsed[4].productCategory, 'Face Wash');
});

test('broad Gemini responses remain visible No Match review items while specific responses remain suggestions', async () => {
  const products = ['Anti Dandruff Shampoo', 'Bluetooth Speaker', 'Water Bottle', 'Non Stick Pan', 'Face Wash'];
  const provider = new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async () => response([
    { product: 'Anti Dandruff Shampoo', masterCategory: 'Beauty', productCategory: 'Hair Care' },
    { product: 'Bluetooth Speaker', masterCategory: 'Electronics', productCategory: 'Audio' },
    { product: 'Water Bottle', masterCategory: 'Home & Kitchen', productCategory: 'Drinkware' },
    { product: 'Non Stick Pan', masterCategory: 'Home & Kitchen', productCategory: 'Cookware' },
    { product: 'Face Wash', masterCategory: 'Beauty', productCategory: 'Face Wash' }
  ]) });
  const responseFromGemini = await provider.classifyProducts(products);
  assert.deepEqual(responseFromGemini.results.map((item) => item.product), products);
  assert.deepEqual(responseFromGemini.results.slice(0, 4).map((item) => item.productCategory), ['NO_MATCH', 'NO_MATCH', 'NO_MATCH', 'NO_MATCH']);
  assert.deepEqual(responseFromGemini.failedProducts, []);
  const classified = await classifyProducts(products, { provider: new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async () => response([
    { product: 'Anti Dandruff Shampoo', masterCategory: 'Beauty', productCategory: 'Shampoo' },
    { product: 'Bluetooth Speaker', masterCategory: 'Electronics', productCategory: 'Audio' },
    { product: 'Water Bottle', masterCategory: 'Home & Kitchen', productCategory: 'Drinkware' },
    { product: 'Non Stick Pan', masterCategory: 'Home & Kitchen', productCategory: 'Cookware' },
    { product: 'Face Wash', masterCategory: 'Beauty', productCategory: 'Face Wash' }
  ]) }) });
  assert.equal(classified.items.length, products.length);
  assert.equal(classified.items[0].suggestionStatus, 'AI Suggested');
  for (const item of classified.items.slice(1, 4)) {
    assert.equal(item.suggestionStatus, 'No Match');
    assert.equal(item.classificationRequired, true);
  }
  assert.equal(classified.items[4].suggestionStatus, 'AI Suggested');
});

test('No Match differs from Failed; empty taxonomy calls Gemini for a possible new pair', async () => {
  let calls = 0;
  const provider = new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async (_url, options) => { calls++; const [product] = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).products; return response([answer(product, { masterCategory: 'NO_MATCH', productCategory: 'NO_MATCH' })]); } });
  const none = await classifyProducts(['Mystery'], { ...taxonomy, provider });
  assert.equal(none.items[0].suggestionStatus, 'No Match'); assert.equal(none.providerUnavailable, false);
  const empty = await classifyProducts(['Other'], { provider });
  assert.equal(empty.items[0].suggestionStatus, 'No Match'); assert.equal(calls, 2);
  const invalid = await classifyProducts(['Other'], { ...taxonomy, provider: { classifyProducts: () => ({ results: [answer('Other', { productCategory: 'Invented' })] }) } });
  assert.equal(invalid.items[0].suggestionStatus, 'AI Suggested');
});

test('unsupported normalized names stay in review, remain distinct, and manual mappings are reusable', async () => {
  const input = csvInput(['商品', '商品', '!!!', '???']); let calls = 0;
  const result = await processValidatedUpload(input, { ...taxonomy, productClassifier: { classifyProducts() { calls++; } } });
  assert.equal(result.classifications.products.length, 3); assert.equal(calls, 0);
  assert.equal(result.classifications.products[0].value, '商品');
  assert.equal(result.classifications.products[0].count, 2);
  assert.ok(result.classifications.products.every((x) => x.classificationRequired && x.manualOnly));
  assert.ok(result.normalizedRows.every((x) => x.productClassificationRequired));
  assert.notEqual(normalizeProductName('!!!'), normalizeProductName('???'));
  const store = new MappingStore({ mongoUri: null }); const master = await store.saveMaster('a', 'Beauty'); await store.saveCategory('a', 'Serum', master._id);
  await store.saveProductMapping('a', '商品', { masterCategory: 'Beauty', productCategory: 'Serum', source: 'Manual' });
  await store.saveProductMappings('a', ['!!!', '???'], { masterCategory: 'Beauty', productCategory: 'Serum', source: 'Manual' });
  const again = await classifyProducts(['商品', '!!!', '???'], { mappings: await store.list('product', 'a'), provider: { classifyProducts() { calls++; } } });
  assert.ok(again.items.every((x) => !x.classificationRequired)); assert.equal(calls, 0);
});

test('failed requests retry and rejected decisions survive controlled reclassification without duplicate active records', async () => {
  const store = new MappingStore({ mongoUri: null }); let calls = 0;
  const options = { ...taxonomy, provider: { classifyProducts(names) { calls++; if (calls === 1) throw new Error('network'); return { results: names.map((x) => answer(x)) }; } } };
  let result = await classifyProducts(['Serum'], options); assert.equal(result.items[0].suggestionStatus, 'Failed'); await store.saveSuggestions('a', result.items);
  result = await classifyProducts(['Serum'], { ...options, suggestions: await store.listSuggestions('a') }); assert.equal(result.items[0].suggestionStatus, 'AI Suggested'); await store.saveSuggestions('a', result.items);
  await store.decideSuggestion('a', 'Serum', 'Client Rejected');
  result = await classifyProducts(['Serum'], { ...options, suggestions: await store.listSuggestions('a') }); assert.equal(calls, 2); assert.equal(result.items[0].suggestionStatus, 'Client Rejected');
  result = await classifyProducts(['Serum'], { ...options, retry: true, suggestions: await store.listSuggestions('a') }); await store.saveSuggestions('a', result.items, { retry: true });
  const records = await store.listSuggestions('a'); assert.equal(records.length, 1); assert.equal(calls, 3);
  assert.deepEqual(records[0].history.map((x) => x.status), ['Failed', 'AI Suggested', 'Client Rejected']);
  assert.equal(records[0].status, 'AI Suggested');
});

test('stale or deactivated suggestions are not reused and tenant taxonomy is isolated', async () => {
  const store = new MappingStore({ mongoUri: null });
  const a = await store.saveMaster('a', 'Beauty'); await store.saveCategory('a', 'Serum', a._id);
  const b = await store.saveMaster('b', 'Home'); await store.saveCategory('b', 'Towel', b._id);
  const rows = [{ originalProductName: 'Unknown', originalStatus: 'Delivered', normalizedProductName: 'unknown' }];
  const context = await store.classificationContext('b', rows); let sent;
  const result = await classifyProducts(['Unknown'], { ...context, suggestions: [{ normalizedProductName: 'unknown', status: 'AI Suggested', suggestedMasterCategory: 'Beauty', suggestedProductCategory: 'Serum' }], provider: { classifyProducts(names, current) { sent = current; return { results: [answer(names[0])] }; } } });
  assert.deepEqual(sent, { masterCategories: ['Home'], productCategories: [{ name: 'Towel', masterCategory: 'Home' }] });
  assert.equal(result.items[0].suggestionStatus, 'AI Suggested');
  await store.setMasterActive('b', 'Home', false);
  const inactive = await store.classificationContext('b', rows);
  assert.deepEqual(buildTaxonomy(inactive.productCategories, inactive.masterCategories).productCategories, []);
});

for (const count of [100, 101, 500, 1000, 5000]) test(`${count} unique pending products use batches of 25 with concurrency one`, async () => {
  let active = 0; let peak = 0; const batches = [];
  const provider = new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async (_url, options) => {
    active++; peak = Math.max(active, peak); const names = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).products; batches.push(names.length);
    await new Promise((resolve) => setImmediate(resolve)); active--; return response(names.map((x) => answer(x)));
  } });
  const result = await provider.classifyProducts(Array.from({ length: count }, (_, i) => `Product ${i}`), taxonomy);
  assert.deepEqual(batches, Array.from({ length: Math.ceil(count / 25) }, (_, i) => Math.min(25, count - i * 25))); assert.equal(peak, 1); assert.equal(result.results.length, count);
});

test('429 and 5xx retries are preserved; partial failures retain successful batches and progress', async () => {
  let calls = 0; const progress = [];
  const provider = new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async (_url, options) => {
    calls++; if (calls <= 2) return { ok: false, status: calls === 1 ? 429 : 503, text: async () => '{}' };
    const names = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).products;
    if (calls === 4) return { ok: true, status: 200, text: async () => '{invalid' };
    return response(names.map((x) => answer(x)));
  } });
  const result = await provider.classifyProducts(Array.from({ length: 201 }, (_, i) => `P${i}`), taxonomy, { onProgress: async (value) => progress.push(value) });
  assert.equal(calls, 11); assert.equal(result.results.length, 176); assert.equal(result.failedProducts.length, 25);
  assert.deepEqual(progress.map((x) => x.completed), [0, 25, 50, 75, 100, 125, 150, 175, 200, 201]); assert.equal(progress.at(-1).failed, 25);
});

test('response body is covered by the timeout and cancellation stops later batches', async () => {
  const timed = new GeminiProductClassifier({ apiKey: 'synthetic', timeoutMs: 15, fetchImpl: async (_url, { signal }) => ({ ok: true, status: 200, text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), { once: true })) }) });
  const failed = await timed.classifyProducts(['A'], taxonomy); assert.equal(failed.failedProducts.length, 1); assert.match(failed.providerError, /timed out/);
  let calls = 0;
  const cancelled = new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async (_url, options) => { calls++; return response(JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).products.map((x) => answer(x))); } });
  await cancelled.classifyProducts(Array.from({ length: 201 }, (_, i) => `P${i}`), taxonomy, { isCancelled: async () => calls > 0 }); assert.equal(calls, 1);
});

test('product retry lease prevents concurrent retries and expires without changing review status', async () => {
  const store = new ProcessingStore({ mongoUri: null }); const { job } = await store.createValidated('a', csvInput(['A'])); job.status = 'review_required'; await store.save(job);
  const claims = await Promise.all([store.claimProductRetry('a', job.processId, 'A'), store.claimProductRetry('a', job.processId, 'A')]); assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await store.claimProductRetry('b', job.processId, 'A'), null);
  await store.releaseProductRetry('a', job.processId, claims.find(Boolean).token);
  assert.ok(await store.claimProductRetry('a', job.processId, 'A'));
  store.jobs.get(job.processId).productRetry.expiresAt = new Date(0);
  assert.ok(await store.claimProductRetry('a', job.processId, 'A'));
  assert.equal((await store.get('a', job.processId)).status, 'review_required');
});

test('HTTP review retries, rejects with history, approves existing categories and resolves raw names', async () => {
  process.env.ADMIN_USERNAME = 'product-test'; process.env.ADMIN_PASSWORD = 'product-test-password'; process.env.SESSION_SECRET = 'synthetic-product-session'; process.env.GEMINI_API_KEY = 'synthetic-provider';
  const actualFetch = global.fetch; const calls = []; let release; let started;
  let retryStarted = new Promise((resolve) => { started = resolve; });
  global.fetch = async (_url, options) => {
    const names = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).products; calls.push(names);
    if (names.length === 1 && names[0] === 'Fail' && calls.length > 1) { started(); await new Promise((resolve) => { release = resolve; }); }
    return response(names.filter((name) => !(name === 'Fail' && names.length > 1)).map((name) => answer(name, name === 'Mystery' ? { masterCategory: 'NO_MATCH', productCategory: 'NO_MATCH' } : {})));
  };
  const app = require('../src/app'); global.fetch = actualFetch;
  const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await actualFetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const api = async (url, body, method = 'POST') => { const r = await actualFetch(base + url, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, ...(await r.json()) }; };
    assert.equal((await api('/api/master-categories', { name: 'Beauty' })).status, 201);
    assert.equal((await api('/api/product-categories', { name: 'Serum', masterCategory: 'Beauty' })).status, 201);
    await api('/api/mappings/product', { product: 'Known', masterCategory: 'Beauty', productCategory: 'Serum', source: 'Manual' });
    const names = ['Known', 'Suggested', 'Mystery', 'Fail', '商品', 'Rejected'];
    const upload = async () => {
      const body = Buffer.from('Order ID,Order Date,Order Status,Product Name,Payment Mode\n' + names.map((name, i) => `${i},2026-01-01,Delivered,${name},COD`).join('\n'));
      const r = await actualFetch(base + '/api/uploads/validate', { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-template-type': 'simple', 'x-file-name': 'synthetic.csv' }, body }); return r.json();
    };
    const initial = await upload(); const id = initial.process.processId;
    const review = `/api/report-processes/${id}/review/product`;
    await api(`/api/report-processes/${id}/start`);
    let reviewProcess;
    for (let i = 0; i < 40; i++) { reviewProcess = (await api(`/api/report-processes/${id}`, null, 'GET')).process; if (reviewProcess.status === 'review_required') break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(reviewProcess.status, 'review_required'); assert.deepEqual(calls[0], ['Suggested', 'Mystery', 'Fail', 'Rejected']);
    const item = (name) => reviewProcess.classifications.products.find((x) => x.value === name);
    assert.equal(item('Fail').suggestionStatus, 'Failed'); assert.equal(item('Mystery').suggestionStatus, 'No Match'); assert.equal(item('商品').manualOnly, true);
    assert.equal((await api(`/api/report-processes/${id}/finalize`)).status, 422);
    assert.equal((await api(review + '/Suggested', { action: 'approve', masterCategory: 'Beauty', productCategory: 'Invented' })).status, 422);
    const pending = api(`/api/report-processes/${id}/products/retry`, { value: 'Fail' }); await retryStarted;
    assert.equal((await api(`/api/report-processes/${id}/products/retry`, { value: 'Fail' })).status, 409);
    assert.equal((await api(review + '/Fail', { action: 'manual', masterCategory: 'Beauty', productCategory: 'Serum' })).status, 409);
    release(); const retried = await pending; assert.equal(retried.status, 200); reviewProcess = retried.process;
    assert.equal(item('Fail').suggestionStatus, 'AI Suggested');
    reviewProcess = (await api(review + '/Rejected', { action: 'reject' })).process; assert.equal(item('Rejected').suggestionStatus, 'Client Rejected');
    reviewProcess = (await api(`/api/report-processes/${id}/products/retry`, { value: 'Rejected' })).process;
    assert.ok(item('Rejected').suggestionHistory.some((x) => x.status === 'Client Rejected'));
    assert.equal((await api(`/api/report-processes/${id}/products/retry`, { value: '商品' })).status, 409);
    reviewProcess = (await api(review + '/bulk', { values: ['Suggested', 'Fail', 'Rejected'], decisions: ['Suggested', 'Fail', 'Rejected'].map((value) => ({ value, action: 'approve', masterCategory: 'Beauty', productCategory: 'Serum' })) })).process;
    assert.ok(['Suggested', 'Fail', 'Rejected'].every((name) => !item(name).classificationRequired));
    for (const name of ['Mystery', '商品']) { const saved = await api(review + '/' + encodeURIComponent(name), { action: 'manual', masterCategory: 'Beauty', productCategory: 'Serum' }); assert.equal(saved.status, 200); }
    assert.equal((await api('/api/product-categories', null, 'GET')).categories.length, 1);
    assert.equal((await api(`/api/report-processes/${id}/finalize`)).status, 201);
    const count = calls.length; const next = await upload(); await api(`/api/report-processes/${next.process.processId}/start`);
    for (let i = 0; i < 40; i++) { reviewProcess = (await api(`/api/report-processes/${next.process.processId}`, null, 'GET')).process; if (reviewProcess.status === 'completed') break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(reviewProcess.status, 'completed'); assert.equal(calls.length, count);
  } finally { release?.(); global.fetch = actualFetch; await new Promise((resolve) => server.close(resolve)); delete process.env.GEMINI_API_KEY; }
});

test('MongoDB persists suggestion history, raw-name mappings and retry leases', { skip: !process.env.DELIVERYIQ_TEST_MONGO_URI }, async () => {
  const mongoose = require('mongoose'); const uri = process.env.DELIVERYIQ_TEST_MONGO_URI;
  await mongoose.connect(uri, { dbName: `deliveryiq_product_${Date.now()}` });
  try {
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    const store = new MappingStore({ mongoUri: uri }); store.connection = Promise.resolve(mongoose);
    const master = await store.saveMaster('a', 'Beauty'); await store.saveCategory('a', 'Serum', master._id);
    const first = await classifyProducts(['Serum'], { ...taxonomy, provider: { classifyProducts: () => ({ results: [answer('Serum')] }) } });
    await store.saveSuggestions('a', first.items); await store.decideSuggestion('a', 'Serum', 'Client Rejected');
    await store.saveSuggestions('a', first.items, { retry: true });
    const restored = await store.listSuggestions('a'); assert.equal(restored.length, 1);
    assert.deepEqual(restored[0].history.map((x) => x.status), ['AI Suggested', 'Client Rejected']);
    assert.equal(await mongoose.models.ProductClassificationSuggestion.countDocuments({ clientId: 'a' }), 1);
    assert.equal((await store.listSuggestions('b')).length, 0);
    await store.saveProductMapping('a', '商品', { masterCategory: 'Beauty', productCategory: 'Serum', source: 'Manual' });
    assert.equal((await store.list('product', 'a', [normalizeProductName('商品')])).length, 1);
    const processes = new ProcessingStore({ mongoUri: uri }); processes.connection = Promise.resolve(mongoose);
    const { job } = await processes.createValidated('a', csvInput(['Serum'])); job.status = 'review_required'; await processes.save(job);
    const claims = await Promise.all([processes.claimProductRetry('a', job.processId, 'Serum'), processes.claimProductRetry('a', job.processId, 'Serum')]);
    assert.equal(claims.filter(Boolean).length, 1); await processes.releaseProductRetry('a', job.processId, claims.find(Boolean).token);
    assert.equal((await processes.get('a', job.processId)).productRetry, null);
  } finally { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});


test('review assignment preserves approval source unless the client changes a category', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
  const helper = source.match(/function productDecisionSource\([^]*?\n}/)[0];
  const choose = require('node:vm').runInNewContext(`(${helper})`);
  const item = { suggestionStatus: 'AI Suggested', suggestedMasterCategory: 'Beauty', suggestedProductCategory: 'Serum' };
  assert.equal(choose(item, 'Beauty', 'Serum'), 'AI Approved');
  assert.equal(choose(item, 'Home', 'Serum'), 'Client Modified');
  assert.equal(choose(item, 'Beauty', 'Towel'), 'Client Modified');
  assert.equal(choose({ suggestionStatus: 'Failed' }, 'Beauty', 'Serum'), 'Manual');
});


test('schema enum budget is bounded while large taxonomies remain fully enforced', async () => {
  for (const count of [197, 198, 300]) {
    const large = { masterCategories: ['Beauty'], productCategories: Array.from({ length: count }, (_, i) => ({ name: `Type ${i}`, masterCategory: 'Beauty' })) };
    let captured;
    const provider = new GeminiProductClassifier({ apiKey: 'synthetic', fetchImpl: async (_url, options) => { captured = JSON.parse(options.body); return response([answer('Known', { productCategory: 'Type 0' }), answer('Invented', { productCategory: 'Never allowed' })]); } });
    const result = await provider.classifyProducts(['Known', 'Invented'], large);
    const fields = captured.generationConfig.responseSchema.properties.results.items.properties;
    assert.equal(fields.masterCategory.enum, undefined);
    assert.equal(fields.productCategory.enum, undefined);
    assert.equal(JSON.parse(captured.contents[0].parts[0].text).existingProductCategories.length, count);
    assert.deepEqual(result.results.map((x) => x.product), ['Known', 'Invented']);
    assert.deepEqual(result.failedProducts, []);
  }
});


test('retry polling shares one timer while pending or in flight and stops after resolution', async () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
  const helper = source.match(/function scheduleProductRetryPoll\([^]*?\n}/)[0];
  let running = true; let release; let calls = 0; const timers = [];
  const context = require('node:vm').createContext({ state: { bulkRetry: null }, productRetryPollTimer: null, productRetryRunning: () => running, setTimeout: (callback) => { timers.push(callback); return timers.length; }, pollProcess: async () => { calls++; await new Promise((resolve) => { release = resolve; }); } });
  require('node:vm').runInContext(helper, context);
  context.state.bulkRetry = { total: 25, processed: 0 }; context.scheduleProductRetryPoll();
  assert.equal(timers.length, 0); context.state.bulkRetry = null;
  context.scheduleProductRetryPoll(); context.scheduleProductRetryPoll(); context.scheduleProductRetryPoll();
  assert.equal(timers.length, 1);
  const pending = timers[0]();
  context.scheduleProductRetryPoll(); assert.equal(timers.length, 1); assert.equal(calls, 1);
  release(); await pending; assert.equal(timers.length, 2);
  const second = timers[1](); running = false; release(); await second;
  context.scheduleProductRetryPoll(); assert.equal(timers.length, 2); assert.equal(calls, 2);
});


test('suggestion history keeps expansion through rerenders without leaking across products or processes', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
  const helper = source.match(/function preserveSuggestionHistory\([^]*?\n}/)[0];
  const state = { processId: 'one', openSuggestionHistories: new Set() };
  const context = require('node:vm').createContext({ state });
  require('node:vm').runInContext(helper, context);
  const render = (value) => {
    const node = { isConnected: true, addEventListener: (_, listener) => { node.toggle = listener; } };
    context.preserveSuggestionHistory(node, value);
    return node;
  };
  const first = render('Serum'); assert.equal(first.open, false);
  first.open = true; first.toggle();
  assert.equal(render('Serum').open, true);
  assert.equal(render('Other').open, false);
  first.isConnected = false; first.open = false; first.toggle();
  const replacement = render('Serum'); assert.equal(replacement.open, true);
  replacement.open = false; replacement.toggle();
  assert.equal(render('Serum').open, false);
  replacement.open = true; replacement.toggle(); state.processId = 'two';
  assert.equal(render('Serum').open, false);
});

test('Gemini taxonomy resolution reuses normalized masters and scopes products by master ID', async () => {
  const store = new MappingStore({ mongoUri: null });
  const electronics = await store.saveMaster('tenant', 'Electronics');
  const fashion = await store.saveMaster('tenant', 'Fashion');
  const electronicAccessories = await store.saveCategory('tenant', 'Accessories', electronics._id);
  const fashionAccessories = await store.saveCategory('tenant', 'Accessories', fashion._id);
  const existing = await store.resolveGeminiTaxonomy('tenant', { masterCategory: ' electronics ', productCategory: ' accessories ' });
  assert.equal(String(existing.masterCategoryId), String(electronics._id)); assert.equal(String(existing._id), String(electronicAccessories._id));
  const scoped = await store.resolveGeminiTaxonomy('tenant', { masterCategory: 'Fashion', productCategory: 'Accessories' });
  assert.equal(String(scoped.masterCategoryId), String(fashion._id)); assert.equal(String(scoped._id), String(fashionAccessories._id));
  const newProduct = await store.resolveGeminiTaxonomy('tenant', { masterCategory: 'ELECTRONICS', productCategory: 'Headphones' });
  assert.equal(String(newProduct.masterCategoryId), String(electronics._id));
  assert.equal((await store.listMasters('tenant', true)).length, 2); assert.equal((await store.listCategories('tenant', true)).length, 3);
});

test('final taxonomy resolution creates new pairs once across retries and concurrent requests', async () => {
  const store = new MappingStore({ mongoUri: null });
  const suggestions = { masterCategory: 'Home & Kitchen', productCategory: 'Cookware' };
  const resolved = await Promise.all(Array.from({ length: 8 }, () => store.resolveGeminiTaxonomy('tenant', suggestions)));
  assert.equal(new Set(resolved.map((x) => String(x.masterCategoryId))).size, 1);
  assert.equal(new Set(resolved.map((x) => String(x._id))).size, 1);
  assert.equal((await store.listMasters('tenant', true)).length, 1); assert.equal((await store.listCategories('tenant', true)).length, 1);
});

test('Gemini new taxonomy remains a review-only suggestion until the client approves it', async () => {
  const store = new MappingStore({ mongoUri: null });
  const result = await classifyProducts(['Noise Cancelling Headphones'], { provider: { classifyProducts: () => ({ results: [answer('Noise Cancelling Headphones', { masterCategory: 'Electronics', productCategory: 'Headphones' })] }) } });
  const item = result.items[0];
  assert.equal(item.suggestionStatus, 'AI Suggested'); assert.equal(item.classificationRequired, true);
  assert.equal(item.suggestedMasterCategory, 'Electronics'); assert.equal(item.suggestedProductCategory, 'Headphones');
  assert.equal((await store.list('product', 'tenant')).length, 0);
  assert.equal((await store.listMasters('tenant', true)).length, 0); assert.equal((await store.listCategories('tenant', true)).length, 0);
  await store.resolveGeminiTaxonomy('tenant', { masterCategory: item.suggestedMasterCategory, productCategory: item.suggestedProductCategory });
  assert.equal((await store.listMasters('tenant', true)).length, 1); assert.equal((await store.listCategories('tenant', true)).length, 1);
});
