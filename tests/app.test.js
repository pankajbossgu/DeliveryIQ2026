const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');

test('health endpoint confirms the application is available', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'deliveryiq');
    assert.ok(Number.isFinite(Date.parse(payload.timestamp)));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('application shell is served with the planned product navigation', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Upload Data/);
    assert.match(page, /Product Mapping/);
    assert.match(page, /Status Mapping/);
    assert.match(page, /Maximum 50,000 rows/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

const { validateUpload } = require('../src/upload');
const { classifyStatus, normalizeMappingValue } = require('../src/classification');
const { MappingStore } = require('../src/mappings');
const headers = ' Order-ID ,Order Date,Status,Product Name,Qty,Payment Mode,Order Source\n';
const validRow = 'ORD-1001,2026-01-15,Delivered,Product A,2,Prepaid,Store\n';
test('upload validator accepts normalized CSV columns and retains multi-product orders', () => {
  const result = validateUpload({ originalname: 'orders.csv', buffer: Buffer.from(headers + validRow + 'ORD-1001,2026-01-15,Shipped,Product B,1,COD,Store\n') });
  assert.equal(result.success, true); assert.equal(result.summary.uniqueOrders, 1); assert.equal(result.validation.duplicates, 0);
});
test('upload validator reports duplicates, invalid quantities, missing columns, and row limit', () => {
  const duplicate = validateUpload({ originalname: 'orders.csv', buffer: Buffer.from(headers + validRow + validRow) });
  assert.equal(duplicate.success, true); assert.equal(duplicate.validation.duplicates, 1);
  const quantity = validateUpload({ originalname: 'orders.csv', buffer: Buffer.from(headers + 'ORD-1,2026-01-15,Delivered,A,0,COD,Store\n') });
  assert.equal(quantity.code, 'INVALID_ROWS');
  const missing = validateUpload({ originalname: 'orders.csv', buffer: Buffer.from('Order ID,Status\nORD-1,Delivered\n') });
  assert.equal(missing.code, 'MISSING_REQUIRED_COLUMNS');
  const tooMany = validateUpload({ originalname: 'orders.csv', buffer: Buffer.from(headers + Array(50001).fill(validRow).join('')) });
  assert.equal(tooMany.code, 'ROW_LIMIT_EXCEEDED');
});

test('upload API validates bytes and serves usable templates', async () => {
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/uploads/validate`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': '../../orders.csv' }, body: headers + validRow });
    assert.equal(response.status, 200); assert.equal((await response.json()).file.name, 'orders.csv');
    const template = await fetch(`http://127.0.0.1:${port}/api/uploads/template.xlsx`);
    assert.equal(template.status, 200); assert.equal(validateUpload({ originalname: 'template.xlsx', buffer: Buffer.from(await template.arrayBuffer()) }).success, true);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('upload validator rejects unsupported, empty, malformed, and oversized file payloads', () => {
  assert.equal(validateUpload({ originalname: 'orders.pdf', buffer: Buffer.from('x') }).code, 'UNSUPPORTED_FILE_TYPE');
  assert.equal(validateUpload({ originalname: 'orders.csv', buffer: Buffer.alloc(0) }).code, 'EMPTY_FILE');
  assert.equal(validateUpload({ originalname: 'orders.xlsx', buffer: Buffer.from('not a workbook') }).code, 'MALFORMED_FILE');
});

test('status classifier applies all final categories and never guesses unknown values', () => {
  for (const [status, category] of [['Delivered', 'Delivered'], ['POD', 'Delivered'], ['Successfully Delivered', 'Delivered'], ['Ready to Ship', 'In Transit'], ['Ready for Pickup', 'In Transit'], ['Picked Up', 'In Transit'], ['Shipped', 'In Transit'], ['In Transit', 'In Transit'], ['OFD', 'In Transit'], ['Misrouted', 'In Transit'], ['Rerouted', 'In Transit'], ['NDR', 'NDR'], ['Undelivered', 'NDR'], ['Delivery Failed', 'NDR'], ['Customer Not Available', 'NDR'], ['RTO', 'RTO'], ['RTO Initiated', 'RTO'], ['RTO In Transit', 'RTO'], ['RTO OFD', 'RTO'], ['Cancelled', 'Cancelled'], ['Canceled', 'Cancelled'], ['Order Cancelled', 'Cancelled'], ['Lost', 'Other'], ['Damaged', 'Other'], ['On Hold', 'Other']]) assert.equal(classifyStatus(status).category, category, status);
  const unknown = classifyStatus('Shipment Held for Security Verification'); assert.equal(unknown.category, null); assert.equal(unknown.classificationRequired, true);
  assert.equal(classifyStatus('Pickup Failed').classificationRequired, true);
});

test('RTO context and status normalization have deterministic priority', () => {
  ['RTO Delivered', 'RTO NDR', 'RTO OFD', 'RTO In Transit', 'Return-to-Origin In Transit', 'Rto_Delivered'].forEach((status) => assert.equal(classifyStatus(status).category, 'RTO'));
  assert.equal(normalizeMappingValue(' RTO-Delivered / '), 'rto delivered');
});

test('client status mappings are isolated and applied to future classifications', async () => {
  const store = new MappingStore({ mongoUri: null });
  await store.save('status', 'client-a', 'Shipment Held at Facility', 'In Transit');
  await store.save('status', 'client-b', 'Shipment Held at Facility', 'Other');
  const clientA = await store.list('status', 'client-a'); const clientB = await store.list('status', 'client-b');
  assert.equal(classifyStatus('Shipment Held at Facility', clientA).category, 'In Transit');
  assert.equal(classifyStatus('Shipment Held at Facility', clientB).category, 'Other');
  assert.equal((await store.list('status', 'client-a')).length, 1);
});

test('validation returns grouped unmapped reviews and mapping APIs validate categories', async () => {
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const source = headers + 'ORD-999,2026-01-15,Shipment Held at Facility,Unmapped Product,1,COD,Store\n';
  try {
    const config = await (await fetch(`http://127.0.0.1:${port}/api/classifications/config`)).json(); const productCategory = config.productCategories[0];
    const validate = () => fetch(`http://127.0.0.1:${port}/api/uploads/validate`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'review.csv' }, body: source });
    let response = await validate(); let payload = await response.json();
    assert.equal(payload.classifications.statuses[0].classificationRequired, true); assert.equal(payload.classifications.products[0].classificationRequired, true);
    response = await fetch(`http://127.0.0.1:${port}/api/mappings/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'Shipment Held at Facility', category: 'In Transit' }) }); assert.equal(response.status, 200);
    response = await fetch(`http://127.0.0.1:${port}/api/mappings/product`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: 'Unmapped Product', category: productCategory }) }); assert.equal(response.status, 200);
    response = await validate(); payload = await response.json(); assert.equal(payload.classifications.statuses[0].category, 'In Transit'); assert.equal(payload.classifications.statuses[0].mappingSource, 'client'); assert.equal(payload.classifications.products[0].category, productCategory);
    response = await fetch(`http://127.0.0.1:${port}/api/mappings/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'Anything', category: 'UNMAPPED' }) }); assert.equal(response.status, 422);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
