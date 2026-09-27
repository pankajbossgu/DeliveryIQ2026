const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const actualFetch = global.fetch;
let server; let base; let cookie; let mode = 'initial'; let calls = []; let gate;
const answer = (product) => ({ product, masterCategory: 'Beauty', productCategory: 'Serum' });
async function api(url, body, method = 'POST') {
  const response = await actualFetch(base + url, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, ...(await response.json()) };
}
test.before(async () => {
  process.env.ADMIN_USERNAME = 'bulk-test'; process.env.ADMIN_PASSWORD = 'synthetic-password'; process.env.SESSION_SECRET = 'synthetic-session'; process.env.GEMINI_API_KEY = 'synthetic-provider';
  global.fetch = async (_url, options) => {
    const products = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text).products;
    calls.push(products);
    if (gate) { gate.started(); await gate.promise; }
    if (mode === 'partial' && calls.length === 2) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Synthetic batch failure' } }) };
    const results = (mode === 'initial' ? products.filter((name) => name.startsWith('Suggested')) : products).map(answer);
    return { ok: true, status: 200, text: async () => JSON.stringify({ results }) };
  };
  const app = require('../src/app'); global.fetch = actualFetch;
  server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await actualFetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('/api/master-categories', { name: 'Beauty' })).status, 201);
  assert.equal((await api('/api/product-categories', { name: 'Serum', masterCategory: 'Beauty' })).status, 201);
});
test.after(async () => { global.fetch = actualFetch; if (server) await new Promise((resolve) => server.close(resolve)); });
let sequence = 0;
async function review(count, extras = []) {
  mode = 'initial'; calls = []; sequence++;
  const names = Array.from({ length: count }, (_, i) => `Failed ${sequence} ${i}`).concat(extras);
  const body = Buffer.from('Order ID,Order Date,Order Status,Product Name,Payment Mode\n' + names.map((name, i) => `${i},2026-01-01,Delivered,${name},COD`).join('\n'));
  const response = await actualFetch(base + '/api/uploads/validate', { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-template-type': 'simple', 'x-file-name': 'synthetic.csv' }, body });
  const payload = await response.json(); assert.equal(response.status, 200);
  const id = payload.process.processId;
  await api(`/api/report-processes/${id}/start`);
  let process;
  for (let i = 0; i < 100; i++) {
    process = (await api(`/api/report-processes/${id}`, null, 'GET')).process;
    if (process.status === 'review_required') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(process.status, 'review_required'); mode = 'success'; calls = [];
  return process;
}
class Element {
  constructor(tag, text) { this.tag = tag; this.textContent = text || ''; this.children = []; this.events = {}; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, listener) { this.events[key] = listener; }
  querySelectorAll(tags) { return this.children.flatMap((child) => [ ...(tags.split(',').includes(child.tag) ? [child] : []), ...child.querySelectorAll(tags) ]); }
}
function browser(process) {
  const nodes = new Map(); const renders = []; const notifications = []; const requests = [];
  const state = { processId: process.processId, result: process, selectedProducts: new Set(), selectedStatuses: new Set(), productSaving: new Set(), productErrors: new Map(), config: { masterCategories: [{ name: 'Beauty', active: true }], statusCategories: [] }, bulkRetry: null };
  const context = vm.createContext({ state, Date, Set, Map, Boolean, encodeURIComponent,
    el: (tag, text) => new Element(tag, text), document: { createElement: (tag) => new Element(tag) }, Option: function (text) { return new Element('option', text); },
    $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, new Element('div')); return nodes.get(selector); },
    clear: (node) => { node.children = []; }, clearNotice() {}, setWorkflowStep() {}, setWorkflowForProcess() {}, taxonomyOptions: () => new Element('select'), replacePremiumSelect: (_old, next) => next,
    bulkProductMapping() {}, bulkProductAction() {}, clearProductSelection() { state.selectedProducts.clear(); },
    reviewItem: (item) => new Element('article', item.value), generateReport() {},
    applyProcess: (next) => { state.result = next; }, reviewFeedback: (text) => { notifications.push(text); }, scheduleProductRetryPoll() {},
    fetch: async (url, options) => { requests.push({ url, options }); return actualFetch(base + url, { ...options, headers: { ...options?.headers, cookie } }); }
  });
  for (const name of ['productRetryRunning', 'retrySelectedProducts', 'retryProduct', 'reviewToolbar', 'reviewMetric', 'renderReview']) {
    const start = source.indexOf(`${name === 'retrySelectedProducts' || name === 'retryProduct' ? 'async ' : ''}function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1); const asyncEnd = source.indexOf('\nasync function ', start + 1);
    vm.runInContext(source.slice(start, Math.min(...[end, asyncEnd].filter((n) => n !== -1))), context);
  }
  const render = context.renderReview;
  context.renderReview = () => { render(); renders.push(state.bulkRetry ? { ...state.bulkRetry } : null); };
  const toolbar = () => context.reviewToolbar(state.result.classifications.products.filter((item) => item.classificationRequired));
  const selectAll = () => { const checkbox = toolbar().querySelectorAll('input')[0]; checkbox.checked = true; checkbox.events.change(); };
  const metrics = () => Object.fromEntries(nodes.get('#product-summary').children.map((node) => node.children.map((child) => child.textContent)));
  return { context, state, toolbar, selectAll, renders, notifications, requests, metrics, nodes };
}

for (const [count, batches] of [[1, [1]], [25, [25]], [26, [25, 1]], [67, [25, 25, 17]]]) {
  test(`bulk retry ${count} failed products sends Gemini batches ${batches.join(' + ')}`, async () => {
    const process = await review(count); const ui = browser(process);
    try {
      assert.equal(ui.toolbar().querySelectorAll('button').some((x) => x.textContent === 'Retry selected'), false);
      ui.selectAll();
      const retry = ui.toolbar().querySelectorAll('button').find((x) => x.textContent === 'Retry selected');
      assert.ok(retry); assert.equal(retry.disabled, false);
      await retry.events.click();
      assert.deepEqual(calls.map((batch) => batch.length), batches);
      assert.ok(ui.state.result.classifications.products.every((item) => item.suggestionStatus === 'AI Suggested' && item.classificationRequired && item.suggestedMasterCategory === 'Beauty' && item.suggestedProductCategory === 'Serum'));
      assert.equal(ui.state.selectedProducts.size, 0);
      assert.equal(ui.metrics()['Total products'], String(count)); assert.equal(ui.metrics()['AI suggested'], String(count));
      assert.equal(ui.metrics().Approved, '0'); assert.equal(ui.metrics().Known, '0'); assert.equal(ui.metrics()['Needs attention'], String(count));
      assert.ok(ui.renders.some((progress) => progress?.processed === Math.min(25, count) && progress.total === count));
      assert.match(ui.notifications[0], new RegExp(`${count} AI suggested, 0 failed`));
      assert.equal(ui.requests.length, batches.length); // No upload/report reload or polling.
    } finally { await api(`/api/report-processes/${process.processId}`, null, 'DELETE'); }
  });
}

test('a failed middle batch preserves successful batches and leaves failures selected for retry', async () => {
  const process = await review(67); const ui = browser(process); mode = 'partial';
  try {
    ui.selectAll(); await ui.context.retrySelectedProducts();
    assert.deepEqual(calls.map((batch) => batch.length), [25, 25, 17]);
    const products = ui.state.result.classifications.products;
    assert.ok(products.slice(0, 25).concat(products.slice(50)).every((item) => item.suggestionStatus === 'AI Suggested' && item.classificationRequired));
    assert.ok(products.slice(25, 50).every((item) => item.suggestionStatus === 'Failed' && item.classificationRequired));
    assert.deepEqual([...ui.state.selectedProducts], products.slice(25, 50).map((item) => item.value));
    assert.equal(ui.metrics()['AI suggested'], '42'); assert.equal(ui.metrics().Approved, '0'); assert.equal(ui.metrics()['Needs attention'], '67');
    assert.match(ui.notifications[0], /42 AI suggested, 25 failed/);
  } finally { await api(`/api/report-processes/${process.processId}`, null, 'DELETE'); }
});

test('Select All preserves visible selection while retry ignores suggested, approved and known products', async () => {
  await api('/api/mappings/product', { product: 'Known bulk', masterCategory: 'Beauty', productCategory: 'Serum', source: 'Manual' });
  let process = await review(1, ['Suggested bulk', 'Suggested approved', 'Known bulk']);
  try {
    process = (await api(`/api/report-processes/${process.processId}/review/product/Suggested%20approved`, { action: 'approve', masterCategory: 'Beauty', productCategory: 'Serum' })).process;
    const ui = browser(process); ui.selectAll();
    const failed = process.classifications.products.find((item) => item.suggestionStatus === 'Failed').value;
    assert.deepEqual([...ui.state.selectedProducts], [failed, 'Suggested bulk']);
    assert.equal(ui.toolbar().querySelectorAll('input')[0].checked, true);
    // Even stale selections cannot cause resolved products to be retried.
    ui.state.selectedProducts.add('Suggested approved'); ui.state.selectedProducts.add('Known bulk');
    await ui.context.retrySelectedProducts(); assert.deepEqual(calls, [[failed]]);
    assert.deepEqual([...ui.state.selectedProducts], ['Suggested bulk']);
    assert.equal(ui.metrics().Known, '1'); assert.equal(ui.metrics().Approved, '2'); assert.equal(ui.metrics()['AI suggested'], '2');
    assert.equal(ui.toolbar().querySelectorAll('button').some((x) => x.textContent === 'Retry selected'), false);
    const previous = JSON.stringify(ui.state.result.classifications.products); calls = [];
    const ignored = await api(`/api/report-processes/${process.processId}/products/retry`, { values: process.classifications.products.map((item) => item.value) });
    assert.equal(ignored.status, 200); assert.deepEqual(calls, []); assert.equal(JSON.stringify(ignored.process.classifications.products), previous);
  } finally { await api(`/api/report-processes/${process.processId}`, null, 'DELETE'); }
});

test('bulk retry guards duplicate clicks, individual retries and concurrent HTTP requests', async () => {
  const process = await review(26); const ui = browser(process); let release; let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  gate = { started, promise: new Promise((resolve) => { release = resolve; }) };
  try {
    ui.selectAll(); const pending = ui.context.retrySelectedProducts(); await waiting;
    assert.equal(ui.toolbar().querySelectorAll('button').find((x) => x.textContent === 'Retry selected').disabled, true);
    assert.match(ui.toolbar().children.find((node) => node.textContent.startsWith('Retrying')).textContent, /Retrying 26 products… 0 \/ 26 processed/);
    await ui.context.retrySelectedProducts(); await ui.context.retryProduct(process.classifications.products[0]);
    assert.equal(ui.requests.length, 1);
    assert.equal((await api(`/api/report-processes/${process.processId}/products/retry`, { values: [process.classifications.products[0].value] })).status, 409);
    assert.equal((await api(`/api/report-processes/${process.processId}/products/retry`, { value: process.classifications.products[0].value })).status, 409);
    gate = null; release(); await pending; assert.deepEqual(calls.map((batch) => batch.length), [25, 1]);
  } finally { gate = null; release(); await api(`/api/report-processes/${process.processId}`, null, 'DELETE'); }
});

test('retry endpoint validates batch size and filters mixed selections on the server', async () => {
  const process = await review(1, ['Suggested server']); const id = process.processId;
  try {
    const value = process.classifications.products.find((item) => item.suggestionStatus === 'Failed').value;
    for (const values of [[], Array(26).fill(value), 'invalid', [null]]) assert.equal((await api(`/api/report-processes/${id}/products/retry`, { values })).status, 422);
    const result = await api(`/api/report-processes/${id}/products/retry`, { values: [value, value, 'Suggested server', 'Unknown product'] });
    assert.equal(result.status, 200); assert.deepEqual(calls, [[value]]);
    assert.ok(result.process.classifications.products.every((item) => item.suggestionStatus === 'AI Suggested' && item.classificationRequired));
  } finally { await api(`/api/report-processes/${id}`, null, 'DELETE'); }
});


test('lost batch response restores persisted successes and stops further requests', async () => {
  const process = await review(26); const ui = browser(process);
  const fetch = ui.context.fetch;
  ui.context.fetch = async (url, options) => {
    const response = await fetch(url, options);
    if (options?.method === 'POST') throw new Error('Synthetic lost response');
    return response;
  };
  try {
    ui.selectAll(); await ui.context.retrySelectedProducts();
    assert.deepEqual(calls.map((batch) => batch.length), [25]);
    assert.equal(ui.state.bulkRetry, null); assert.match(ui.state.bulkError, /lost response/);
    assert.equal(ui.metrics()['AI suggested'], '25'); assert.equal(ui.state.selectedProducts.size, 1);
    assert.equal(ui.requests.length, 2); assert.ok(!ui.requests[1].options);
  } finally { await api(`/api/report-processes/${process.processId}`, null, 'DELETE'); }
});
