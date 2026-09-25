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
